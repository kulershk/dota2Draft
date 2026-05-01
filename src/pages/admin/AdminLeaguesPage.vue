<script setup lang="ts">
import { Award, Plus, Pencil, Trash2, User, Globe, Lock } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

interface League {
  id: number
  name: string
  dota_league_id: number
  public: boolean
  created_by: number | null
  created_by_name: string | null
  created_at: string
}

const leagues = ref<League[]>([])
const showAdd = ref(false)
const showEdit = ref(false)
const newLeague = ref({ name: '', dota_league_id: 0, public: false })
const editLeague = ref({ id: 0, name: '', dota_league_id: 0, public: false })
const error = ref('')

const canManageAll = computed(() => store.hasPerm('manage_leagues'))
const myId = computed(() => store.currentUser.value?.id ?? null)

function canEdit(league: League): boolean {
  return canManageAll.value || (myId.value != null && league.created_by === myId.value)
}

async function fetchLeagues() {
  leagues.value = await api.getLeagues()
}
fetchLeagues()

async function addLeague() {
  error.value = ''
  if (!newLeague.value.name.trim()) { error.value = t('leagueNameRequired'); return }
  if (!newLeague.value.dota_league_id || newLeague.value.dota_league_id <= 0) { error.value = t('leagueDotaIdRequired'); return }
  try {
    await api.createLeague({ name: newLeague.value.name.trim(), dota_league_id: newLeague.value.dota_league_id, public: newLeague.value.public })
    newLeague.value = { name: '', dota_league_id: 0, public: false }
    showAdd.value = false
    await fetchLeagues()
  } catch (e: any) {
    error.value = e.message || 'Failed to create league'
  }
}

function openEdit(league: League) {
  editLeague.value = { id: league.id, name: league.name, dota_league_id: league.dota_league_id, public: !!league.public }
  error.value = ''
  showEdit.value = true
}

async function saveLeague() {
  error.value = ''
  if (!editLeague.value.name.trim()) { error.value = t('leagueNameRequired'); return }
  if (!editLeague.value.dota_league_id || editLeague.value.dota_league_id <= 0) { error.value = t('leagueDotaIdRequired'); return }
  try {
    await api.updateLeague(editLeague.value.id, { name: editLeague.value.name.trim(), dota_league_id: editLeague.value.dota_league_id, public: editLeague.value.public })
    showEdit.value = false
    await fetchLeagues()
  } catch (e: any) {
    error.value = e.message || 'Failed to save league'
  }
}

async function deleteLeague(league: League) {
  if (!confirm(t('leagueDeleteConfirm', { name: league.name }))) return
  await api.deleteLeague(league.id)
  await fetchLeagues()
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('adminLeagues') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('adminLeaguesSubtitle') }}</p>
      </div>
      <button class="btn-primary text-sm" @click="error = ''; newLeague = { name: '', dota_league_id: 0, public: false }; showAdd = true">
        <Plus class="w-4 h-4" />
        {{ t('addLeague') }}
      </button>
    </div>

    <div class="card">
      <div v-if="leagues.length === 0" class="px-4 py-12 text-center text-sm text-muted-foreground">
        {{ t('noLeagues') }}
      </div>
      <div v-else class="divide-y divide-border">
        <div v-for="league in leagues" :key="league.id" class="px-4 py-3 md:px-6 flex items-center gap-3">
          <Award class="w-4 h-4 text-muted-foreground shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-3 flex-wrap">
              <span class="text-sm font-semibold text-foreground">{{ league.name }}</span>
              <span class="text-xs text-muted-foreground font-mono">#{{ league.dota_league_id }}</span>
              <span v-if="league.public" class="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                <Globe class="w-3 h-3" />
                {{ t('leaguePublic') }}
              </span>
              <span v-else class="flex items-center gap-1 text-xs text-muted-foreground">
                <Lock class="w-3 h-3" />
                {{ t('leaguePrivate') }}
              </span>
              <span v-if="league.created_by_name" class="flex items-center gap-1 text-xs text-muted-foreground">
                <User class="w-3 h-3" />
                {{ league.created_by_name }}
              </span>
            </div>
          </div>
          <div v-if="canEdit(league)" class="flex items-center gap-1 shrink-0">
            <button class="btn-ghost p-2" :title="t('edit')" @click="openEdit(league)">
              <Pencil class="w-4 h-4" />
            </button>
            <button class="btn-ghost p-2 text-destructive" :title="t('delete')" @click="deleteLeague(league)">
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Add League Modal -->
    <ModalOverlay :show="showAdd" @close="showAdd = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('addLeague') }}</h2>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup :label="t('leagueName')" :model-value="newLeague.name" :placeholder="t('leagueNamePlaceholder')" @update:model-value="newLeague.name = $event" />
        <InputGroup :label="t('dotaLeagueId')" :model-value="String(newLeague.dota_league_id || '')" placeholder="12345" :hint="t('dotaLeagueIdHint')" @update:model-value="newLeague.dota_league_id = Number($event)" />
        <div class="flex flex-col gap-1.5">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="w-4 h-4 accent-primary" v-model="newLeague.public" />
            <span class="text-sm text-foreground">{{ t('leaguePublic') }}</span>
          </label>
          <p class="text-xs text-muted-foreground">{{ t('leaguePublicHint') }}</p>
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="addLeague">
          <Plus class="w-4 h-4" />
          {{ t('addLeague') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showAdd = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Edit League Modal -->
    <ModalOverlay :show="showEdit" @close="showEdit = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('editLeague') }}</h2>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup :label="t('leagueName')" :model-value="editLeague.name" @update:model-value="editLeague.name = $event" />
        <InputGroup :label="t('dotaLeagueId')" :model-value="String(editLeague.dota_league_id || '')" :hint="t('dotaLeagueIdHint')" @update:model-value="editLeague.dota_league_id = Number($event)" />
        <div class="flex flex-col gap-1.5">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" class="w-4 h-4 accent-primary" v-model="editLeague.public" />
            <span class="text-sm text-foreground">{{ t('leaguePublic') }}</span>
          </label>
          <p class="text-xs text-muted-foreground">{{ t('leaguePublicHint') }}</p>
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="saveLeague">
          <Pencil class="w-4 h-4" />
          {{ t('save') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showEdit = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>
  </div>
</template>
