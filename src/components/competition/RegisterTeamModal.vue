<script setup lang="ts">
import { Search, UserPlus, X } from 'lucide-vue-next'
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'

const props = defineProps<{ show: boolean; teamSize: number }>()
const emit = defineEmits<{ close: []; registered: [] }>()

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

const team = ref('')
const captainRole = ref<number | null>(null)
const submitting = ref(false)
const errorMsg = ref('')

type Slot = {
  query: string
  results: any[]
  selected: any | null
  role: number | null
  open: boolean
  searching: boolean
  searchToken: number
}

function makeSlot(): Slot {
  return { query: '', results: [], selected: null, role: null, open: false, searching: false, searchToken: 0 }
}

const slots = ref<Slot[]>([])

watch(() => [props.show, props.teamSize], () => {
  if (props.show) {
    team.value = ''
    captainRole.value = null
    errorMsg.value = ''
    slots.value = Array.from({ length: Math.max(0, props.teamSize - 1) }, () => makeSlot())
  }
}, { immediate: true })

const myId = computed(() => store.currentUser.value?.id ?? null)

const selectedIds = computed(() =>
  slots.value.map(s => s.selected?.id).filter((id): id is number => typeof id === 'number')
)

const allSelected = computed(() => slots.value.every(s => s.selected))
const noDuplicateRoles = computed(() => {
  const roles = [
    captainRole.value,
    ...slots.value.map(s => s.role),
  ].filter((r): r is number => r != null)
  return new Set(roles).size === roles.length
})
const canSubmit = computed(() =>
  team.value.trim().length > 0 && allSelected.value && noDuplicateRoles.value && !submitting.value
)

async function searchSlot(idx: number) {
  const slot = slots.value[idx]
  const q = slot.query.trim()
  slot.open = true
  if (q.length < 2) {
    slot.results = []
    return
  }
  const token = ++slot.searchToken
  slot.searching = true
  try {
    const data = await api.search(q, 8)
    if (token !== slot.searchToken) return
    const taken = new Set([myId.value, ...selectedIds.value.filter((_, i) => i !== idx)])
    slot.results = (data.players || []).filter((p: any) => !p.is_banned && !taken.has(p.id))
  } catch (e) {
    if (token === slot.searchToken) slot.results = []
  } finally {
    if (token === slot.searchToken) slot.searching = false
  }
}

let debounceTimers: Record<number, any> = {}
function onSlotInput(idx: number, value: string) {
  const slot = slots.value[idx]
  slot.query = value
  slot.selected = null
  clearTimeout(debounceTimers[idx])
  debounceTimers[idx] = setTimeout(() => searchSlot(idx), 200)
}

function pickResult(idx: number, p: any) {
  const slot = slots.value[idx]
  slot.selected = p
  slot.query = p.display_name || p.name
  slot.open = false
  slot.results = []
}

function clearSlot(idx: number) {
  const slot = slots.value[idx]
  slot.selected = null
  slot.query = ''
  slot.results = []
  slot.open = false
}

async function submit() {
  errorMsg.value = ''
  if (!canSubmit.value) return
  submitting.value = true
  try {
    await store.registerTeam({
      team: team.value.trim(),
      captainRole: captainRole.value,
      members: slots.value.map(s => ({
        playerId: s.selected!.id,
        playingRole: s.role,
      })),
    })
    emit('registered')
    emit('close')
  } catch (e: any) {
    errorMsg.value = e.message || t('teamRegistration.failed')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <ModalOverlay :show="show" wide @close="emit('close')">
    <div class="border-b border-border px-7 py-6">
      <h2 class="text-xl font-semibold text-foreground">{{ t('registerTeamTitle') }}</h2>
      <p class="text-sm text-muted-foreground mt-1">{{ t('registerTeamSubtitle', { n: teamSize, m: Math.max(0, teamSize - 1) }) }}</p>
    </div>
    <div class="px-7 py-5 flex flex-col gap-5">
      <p v-if="errorMsg" class="text-sm text-red-500 bg-red-500/10 rounded px-3 py-2">{{ errorMsg }}</p>

      <div v-if="store.currentUser.value" class="flex items-center gap-4 p-4 rounded-lg bg-accent/50 border border-border">
        <img v-if="store.currentUser.value.avatar_url" :src="store.currentUser.value.avatar_url" class="w-12 h-12 rounded-full" />
        <div v-else class="w-12 h-12 rounded-full bg-secondary flex items-center justify-center text-base font-bold text-secondary-foreground">
          {{ store.currentUser.value.name.charAt(0) }}
        </div>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-foreground">{{ store.currentUser.value.name }}</p>
          <p class="text-xs text-muted-foreground">{{ t('youAreCaptain') }}</p>
        </div>
        <select class="input-field w-32" :value="captainRole ?? ''" @change="captainRole = ($event.target as HTMLSelectElement).value ? Number(($event.target as HTMLSelectElement).value) : null">
          <option value="">{{ t('slotRolePlaceholder') }}</option>
          <option :value="1">P1</option>
          <option :value="2">P2</option>
          <option :value="3">P3</option>
          <option :value="4">P4</option>
          <option :value="5">P5</option>
        </select>
      </div>

      <InputGroup
        :label="t('registerTeamNameLabel')"
        :model-value="team"
        :placeholder="t('registerTeamNamePlaceholder')"
        @update:model-value="team = $event"
      />

      <div class="flex flex-col gap-3">
        <label class="label-text">{{ t('registerTeamMembersLabel') }}</label>
        <div v-for="(slot, idx) in slots" :key="idx" class="flex flex-col gap-1">
          <div class="flex items-center gap-2">
            <div class="relative flex-1">
              <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                :value="slot.query"
                type="text"
                :placeholder="t('searchByNameOrSteamId')"
                class="input-field pl-9 pr-9 w-full"
                @input="onSlotInput(idx, ($event.target as HTMLInputElement).value)"
                @focus="slot.open = true"
              />
              <button v-if="slot.selected || slot.query" class="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-accent text-muted-foreground" @click="clearSlot(idx)">
                <X class="w-3.5 h-3.5" />
              </button>
              <div v-if="slot.open && (slot.results.length > 0 || slot.searching || (slot.query.length >= 2 && !slot.searching))" class="absolute left-0 right-0 top-full mt-1 max-h-[220px] overflow-y-auto rounded-md border border-border bg-card shadow-lg z-10 divide-y divide-border">
                <div v-if="slot.searching" class="px-3 py-3 text-center text-xs text-muted-foreground">{{ t('searchingPlayers') }}</div>
                <button
                  v-for="p in slot.results"
                  :key="p.id"
                  class="flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-accent/30 transition-colors"
                  @click="pickResult(idx, p)"
                >
                  <img v-if="p.avatar_url" :src="p.avatar_url" class="w-7 h-7 rounded-full" />
                  <div v-else class="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-[10px] font-semibold text-secondary-foreground">
                    {{ (p.display_name || p.name).charAt(0) }}
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-foreground truncate">{{ p.display_name || p.name }}</div>
                    <div v-if="p.steam_id" class="text-[10px] text-muted-foreground font-mono truncate">{{ p.steam_id }}</div>
                  </div>
                  <span v-if="p.mmr" class="text-xs text-muted-foreground ml-auto shrink-0">{{ p.mmr }} MMR</span>
                </button>
                <div v-if="!slot.searching && slot.results.length === 0 && slot.query.length >= 2" class="px-3 py-3 text-center text-xs text-muted-foreground">
                  {{ t('noPlayersFound') }}
                </div>
              </div>
            </div>
            <select class="input-field w-24 shrink-0" :value="slot.role ?? ''" @change="slot.role = ($event.target as HTMLSelectElement).value ? Number(($event.target as HTMLSelectElement).value) : null">
              <option value="">{{ t('slotRolePlaceholder') }}</option>
              <option :value="1">P1</option>
              <option :value="2">P2</option>
              <option :value="3">P3</option>
              <option :value="4">P4</option>
              <option :value="5">P5</option>
            </select>
          </div>
        </div>
        <p v-if="!noDuplicateRoles" class="text-xs text-amber-500">{{ t('teamMemberDuplicateRole') }}</p>
      </div>
    </div>
    <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
      <button class="btn-primary w-full justify-center" :disabled="!canSubmit" @click="submit">
        <UserPlus class="w-4 h-4" />
        {{ submitting ? t('teamRegistration.submitting') : t('registerTeam') }}
      </button>
      <button class="btn-secondary w-full justify-center" @click="emit('close')">{{ t('cancel') }}</button>
    </div>
  </ModalOverlay>
</template>
