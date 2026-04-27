<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Medal, Plus, Trash2, Trophy } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'

interface Season {
  id: number
  name: string
  slug: string
  description: string | null
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
  settings: Record<string, any>
  pool_count: number
  player_count: number
  match_count: number
  created_at: string
}

const { t } = useI18n()
const router = useRouter()
const api = useApi()

const seasons = ref<Season[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

// Create modal
const showCreate = ref(false)
const createName = ref('')
const createSlug = ref('')
const createSaving = ref(false)
const createError = ref<string | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    seasons.value = await api.getAdminSeasons()
  } catch (e: any) {
    error.value = e.message || 'Failed to load seasons'
  } finally {
    loading.value = false
  }
}

function statusOf(s: Season): 'active' | 'upcoming' | 'ended' {
  if (!s.is_active) return 'ended'
  const now = Date.now()
  if (s.starts_at && new Date(s.starts_at).getTime() > now) return 'upcoming'
  if (s.ends_at && new Date(s.ends_at).getTime() < now) return 'ended'
  return 'active'
}

function statusClass(s: Season): string {
  const v = statusOf(s)
  if (v === 'active')   return 'bg-green-500/15 text-green-500 border-green-500/30'
  if (v === 'upcoming') return 'bg-blue-500/15 text-blue-400 border-blue-500/30'
  return 'bg-muted/40 text-muted-foreground border-border/40'
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString()
}

const sortedSeasons = computed(() => seasons.value.slice().sort((a, b) => {
  if (a.is_active !== b.is_active) return a.is_active ? -1 : 1
  return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
}))

async function handleCreate() {
  if (!createName.value.trim()) {
    createError.value = t('seasonNameRequired')
    return
  }
  createSaving.value = true
  createError.value = null
  try {
    const created = await api.createSeason({
      name: createName.value.trim(),
      slug: createSlug.value.trim() || undefined,
    })
    showCreate.value = false
    createName.value = ''
    createSlug.value = ''
    await load()
    router.push({ name: 'admin-season-setup', params: { id: created.id } })
  } catch (e: any) {
    createError.value = e.message || 'Failed to create season'
  } finally {
    createSaving.value = false
  }
}

async function handleDelete(s: Season) {
  if (!confirm(t('seasonDeleteConfirm', { name: s.name }))) return
  try {
    await api.deleteSeason(s.id)
    await load()
  } catch (e: any) {
    alert(e.message || 'Failed to delete season')
  }
}

onMounted(load)
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('adminSeasons') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('adminSeasonsDesc') }}</p>
      </div>
      <button
        type="button"
        class="btn-primary px-3 py-2 text-sm flex items-center gap-2"
        @click="showCreate = true"
      >
        <Plus class="w-4 h-4" />
        {{ t('seasonCreate') }}
      </button>
    </div>

    <div v-if="loading" class="text-sm text-muted-foreground">{{ t('loading') }}…</div>
    <div v-else-if="error" class="card p-4 border border-destructive/40 text-destructive text-sm">{{ error }}</div>
    <div v-else-if="sortedSeasons.length === 0" class="card p-8 text-center text-muted-foreground">
      <Trophy class="w-10 h-10 mx-auto mb-3 opacity-40" />
      <p class="text-sm">{{ t('seasonsEmpty') }}</p>
    </div>
    <div v-else class="card overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th class="text-left px-4 py-2.5">{{ t('seasonName') }}</th>
            <th class="text-left px-4 py-2.5">{{ t('seasonStatus') }}</th>
            <th class="text-left px-4 py-2.5">{{ t('seasonDates') }}</th>
            <th class="text-right px-4 py-2.5">{{ t('seasonPoolsCount') }}</th>
            <th class="text-right px-4 py-2.5">{{ t('seasonPlayersCount') }}</th>
            <th class="text-right px-4 py-2.5">{{ t('seasonMatchesCount') }}</th>
            <th class="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in sortedSeasons" :key="s.id"
            class="border-t border-border/40 hover:bg-accent/20 cursor-pointer"
            @click="router.push({ name: 'admin-season-setup', params: { id: s.id } })"
          >
            <td class="px-4 py-3">
              <div class="font-semibold">{{ s.name }}</div>
              <div class="text-[11px] text-muted-foreground font-mono">{{ s.slug }}</div>
            </td>
            <td class="px-4 py-3">
              <span class="inline-block px-2 py-0.5 text-[11px] font-mono font-bold uppercase rounded border" :class="statusClass(s)">
                {{ t('seasonStatus_' + statusOf(s)) }}
              </span>
            </td>
            <td class="px-4 py-3 font-mono text-xs text-muted-foreground tabular-nums">
              {{ fmtDate(s.starts_at) }} → {{ fmtDate(s.ends_at) }}
            </td>
            <td class="px-4 py-3 text-right font-mono tabular-nums">{{ s.pool_count }}</td>
            <td class="px-4 py-3 text-right font-mono tabular-nums">{{ s.player_count }}</td>
            <td class="px-4 py-3 text-right font-mono tabular-nums">{{ s.match_count }}</td>
            <td class="px-4 py-3 text-right">
              <button
                type="button"
                class="p-1.5 rounded-md hover:bg-destructive/15 text-muted-foreground hover:text-destructive transition-colors"
                :title="t('delete')"
                @click.stop="handleDelete(s)"
              >
                <Trash2 class="w-4 h-4" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create modal -->
    <div v-if="showCreate" class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" @click.self="showCreate = false">
      <div class="card w-full max-w-md p-6">
        <h2 class="text-lg font-bold mb-4">{{ t('seasonCreate') }}</h2>
        <div class="flex flex-col gap-3">
          <label class="block">
            <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonName') }}</span>
            <input v-model="createName" type="text" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40" />
          </label>
          <label class="block">
            <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ t('seasonSlug') }}</span>
            <input v-model="createSlug" type="text" :placeholder="t('seasonSlugAuto')" class="mt-1 w-full bg-accent/40 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary/40" />
          </label>
          <div v-if="createError" class="text-xs text-destructive">{{ createError }}</div>
        </div>
        <div class="flex justify-end gap-2 mt-5">
          <button type="button" class="px-3 py-2 text-sm rounded-md hover:bg-accent" @click="showCreate = false">{{ t('cancel') }}</button>
          <button
            type="button"
            class="btn-primary px-3 py-2 text-sm"
            :disabled="createSaving"
            @click="handleCreate"
          >
            {{ createSaving ? `${t('saving')}…` : t('create') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
