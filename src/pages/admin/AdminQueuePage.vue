<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Trash2, Pencil, X, Check } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'

const { t } = useI18n()
const api = useApi()
const pools = ref<any[]>([])
const editingId = ref<number | null>(null)
const showCreate = ref(false)

const form = ref<Record<string, any>>({
  name: '',
  enabled: true,
  min_mmr: 0,
  max_mmr: 0,
  pick_timer: 30,
  best_of: 1,
  lobby_server_region: 3,
  lobby_game_mode: 2,
  lobby_league_id: 0,
  lobby_dotv_delay: 1,
  lobby_cheats: false,
  lobby_allow_spectating: true,
  lobby_pause_setting: 0,
  lobby_selection_priority: 0,
  lobby_cm_pick: 0,
  lobby_series_type: 0,
  lobby_timeout_minutes: 10,
})

function resetForm() {
  form.value = {
    name: '', enabled: true, min_mmr: 0, max_mmr: 0, pick_timer: 30, best_of: 1,
    lobby_server_region: 3, lobby_game_mode: 2, lobby_league_id: 0, lobby_dotv_delay: 1,
    lobby_cheats: false, lobby_allow_spectating: true, lobby_pause_setting: 0,
    lobby_selection_priority: 0, lobby_cm_pick: 0, lobby_series_type: 0, lobby_timeout_minutes: 10,
  }
}

async function fetchPools() {
  try { pools.value = await api.getAdminQueuePools() } catch { pools.value = [] }
}

function startEdit(pool: any) {
  editingId.value = pool.id
  form.value = { ...pool }
  showCreate.value = false
}

function startCreate() {
  resetForm()
  editingId.value = null
  showCreate.value = true
}

function cancelEdit() {
  editingId.value = null
  showCreate.value = false
  resetForm()
}

async function savePool() {
  if (!form.value.name) return
  try {
    if (editingId.value) {
      await api.updateQueuePool(editingId.value, form.value)
    } else {
      await api.createQueuePool(form.value)
    }
    editingId.value = null
    showCreate.value = false
    resetForm()
    await fetchPools()
  } catch (e: any) {
    alert(e.message)
  }
}

async function deletePool(id: number) {
  if (!confirm('Delete this queue pool?')) return
  await api.deleteQueuePool(id)
  await fetchPools()
}

const SERVER_REGIONS: Record<number, string> = {
  0: 'US West', 1: 'US East', 2: 'Europe', 3: 'Europe East',
  5: 'SE Asia', 6: 'Dubai', 7: 'Australia', 8: 'Stockholm',
  9: 'Austria', 10: 'Brazil', 11: 'South Africa', 12: 'China',
  14: 'Chile', 15: 'Peru', 16: 'India', 17: 'Japan', 19: 'Taiwan',
}

const GAME_MODES: Record<number, string> = {
  1: 'All Pick', 2: "Captain's Mode", 3: 'Random Draft',
  4: 'Single Draft', 5: 'All Random', 22: 'Ranked All Pick',
}

onMounted(fetchPools)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-xl font-bold">{{ t('adminQueuePools') }}</h2>
      <button class="btn-primary flex items-center gap-1.5 text-sm" @click="startCreate">
        <Plus class="w-4 h-4" /> {{ t('queueCreatePool') }}
      </button>
    </div>

    <!-- Pool List -->
    <div class="flex flex-col gap-3 mb-6">
      <div v-for="pool in pools" :key="pool.id" class="card px-4 py-3">
        <div class="flex items-center justify-between">
          <div>
            <span class="font-semibold">{{ pool.name }}</span>
            <span class="ml-2 text-xs px-1.5 py-0.5 rounded" :class="pool.enabled ? 'bg-green-500/10 text-green-500' : 'bg-accent text-muted-foreground'">
              {{ pool.enabled ? 'Enabled' : 'Disabled' }}
            </span>
            <span class="text-xs text-muted-foreground ml-3">
              MMR: {{ pool.min_mmr || 0 }}{{ pool.max_mmr ? `-${pool.max_mmr}` : '+' }}
              | Pick: {{ pool.pick_timer }}s
              | Region: {{ SERVER_REGIONS[pool.lobby_server_region] || pool.lobby_server_region }}
              | League: {{ pool.lobby_league_id || 'None' }}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <button class="p-1.5 rounded hover:bg-accent" @click="startEdit(pool)"><Pencil class="w-4 h-4" /></button>
            <button class="p-1.5 rounded hover:bg-destructive/10 text-destructive" @click="deletePool(pool.id)"><Trash2 class="w-4 h-4" /></button>
          </div>
        </div>
      </div>
      <div v-if="pools.length === 0" class="text-muted-foreground text-sm text-center py-4">{{ t('queueNoPoolsYet') }}</div>
    </div>

    <!-- Create / Edit Form -->
    <div v-if="showCreate || editingId" class="card px-6 py-5">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-semibold">{{ editingId ? t('queueEditPool') : t('queueCreatePool') }}</h3>
        <button @click="cancelEdit" class="p-1 rounded hover:bg-accent"><X class="w-4 h-4" /></button>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <!-- Basic -->
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queuePoolName') }}</label>
          <input class="input-field" v-model="form.name" />
        </div>
        <div class="flex items-center gap-2 pt-5">
          <input type="checkbox" :checked="form.enabled" @change="form.enabled = ($event.target as HTMLInputElement).checked" />
          <span class="text-sm">{{ t('queueEnabled') }}</span>
        </div>

        <!-- MMR -->
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queueMinMmr') }}</label>
          <input class="input-field" type="number" v-model.number="form.min_mmr" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queueMaxMmr') }} (0 = {{ t('queueNoLimit') }})</label>
          <input class="input-field" type="number" v-model.number="form.max_mmr" />
        </div>

        <!-- Pick / Match -->
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queuePickTimer') }} (s)</label>
          <input class="input-field" type="number" v-model.number="form.pick_timer" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('queueBestOf') }}</label>
          <select class="input-field" v-model.number="form.best_of">
            <option :value="1">Bo1</option>
            <option :value="3">Bo3</option>
            <option :value="5">Bo5</option>
          </select>
        </div>

        <!-- Lobby Settings -->
        <div class="col-span-2 border-t border-border/30 pt-3 mt-1">
          <span class="text-sm font-semibold text-muted-foreground">{{ t('queueLobbySettings') }}</span>
        </div>

        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('serverRegion') }}</label>
          <select class="input-field" v-model.number="form.lobby_server_region">
            <option v-for="(name, id) in SERVER_REGIONS" :key="id" :value="Number(id)">{{ name }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('gameMode') }}</label>
          <select class="input-field" v-model.number="form.lobby_game_mode">
            <option v-for="(name, id) in GAME_MODES" :key="id" :value="Number(id)">{{ name }}</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('leagueId') }}</label>
          <input class="input-field" type="number" v-model.number="form.lobby_league_id" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">{{ t('lobbyTimeout') }} (min)</label>
          <input class="input-field" type="number" v-model.number="form.lobby_timeout_minutes" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">DotaTV Delay</label>
          <select class="input-field" v-model.number="form.lobby_dotv_delay">
            <option :value="0">None</option>
            <option :value="1">2 min</option>
            <option :value="2">5 min</option>
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground">Series Type</label>
          <select class="input-field" v-model.number="form.lobby_series_type">
            <option :value="0">None</option>
            <option :value="1">Bo3</option>
            <option :value="2">Bo5</option>
          </select>
        </div>
        <div class="flex items-center gap-4 col-span-2">
          <label class="flex items-center gap-1.5">
            <input type="checkbox" :checked="form.lobby_cheats" @change="form.lobby_cheats = ($event.target as HTMLInputElement).checked" />
            <span class="text-sm">Cheats</span>
          </label>
          <label class="flex items-center gap-1.5">
            <input type="checkbox" :checked="form.lobby_allow_spectating" @change="form.lobby_allow_spectating = ($event.target as HTMLInputElement).checked" />
            <span class="text-sm">Allow Spectating</span>
          </label>
        </div>
      </div>

      <div class="flex justify-end gap-2 mt-5 pt-4 border-t border-border/30">
        <button class="btn-outline" @click="cancelEdit">{{ t('cancel') }}</button>
        <button class="btn-primary" @click="savePool">{{ t('save') }}</button>
      </div>
    </div>
  </div>
</template>
