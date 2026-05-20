<script setup lang="ts">
// Currency admin page — handles BOTH dotacoins and gcoins. A toggle picks the
// active currency; only the currencies the admin can manage are shown
// (manage_dotacoins / manage_gcoins, or full admin). Lets an economy
// moderator search a player, see their balance + recent transactions, and
// apply a signed adjustment without exposing the full user-management page.
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Coins, Search, Loader2, Plus, Minus } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { fmtDateTime } from '@/utils/format'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

type Currency = 'dotacoins' | 'gcoins'
interface TxRow { id: number; delta: number; reason: string | null; created_at: string; created_by_name: string | null }
interface PlayerInfo { id: number; name: string; display_name: string; avatar_url: string | null; balance: number }

const canDota = computed(() => store.isAdmin.value || store.hasPerm('manage_dotacoins'))
const canG = computed(() => store.isAdmin.value || store.hasPerm('manage_gcoins'))
const availableCurrencies = computed<Currency[]>(() => {
  const arr: Currency[] = []
  if (canDota.value) arr.push('dotacoins')
  if (canG.value) arr.push('gcoins')
  return arr
})
const currency = ref<Currency>(canDota.value ? 'dotacoins' : 'gcoins')
const currencyLabel = computed(() => (currency.value === 'gcoins' ? t('gcoins') : t('dotacoins')))
const pageTitle = computed(() => (currency.value === 'gcoins' ? t('adminGcoinsTitle') : t('adminDotacoinsTitle')))
const pageDesc = computed(() => (currency.value === 'gcoins' ? t('adminGcoinsDesc') : t('adminDotacoinsDesc')))

const searchQuery = ref('')
const searchResults = ref<Array<{ id: number; name: string; display_name?: string | null; avatar_url?: string | null }>>([])
let searchTimer: ReturnType<typeof setTimeout> | null = null

const selected = ref<PlayerInfo | null>(null)
const transactions = ref<TxRow[]>([])
const loading = ref(false)

const delta = ref<number | null>(null)
const reason = ref('')
const saving = ref(false)
const error = ref('')

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  const q = searchQuery.value.trim()
  if (q.length < 2) { searchResults.value = []; return }
  searchTimer = setTimeout(async () => {
    try {
      const res = await api.searchPlayers(q)
      searchResults.value = Array.isArray(res) ? res : (res?.players || [])
    } catch {
      searchResults.value = []
    }
  }, 200)
}

// Fetch a player's balance + log for the active currency.
async function loadPlayer(id: number) {
  loading.value = true
  error.value = ''
  try {
    const data = currency.value === 'gcoins'
      ? await api.getPlayerGcoins(id)
      : await api.getPlayerDotacoins(id)
    const pl = data.player
    selected.value = {
      id: pl.id,
      name: pl.name,
      display_name: pl.display_name,
      avatar_url: pl.avatar_url,
      balance: currency.value === 'gcoins' ? (pl.gcoins ?? 0) : (pl.dotacoins ?? 0),
    }
    transactions.value = data.transactions || []
  } catch (e: any) {
    error.value = e?.message || 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function pickPlayer(p: { id: number }) {
  searchQuery.value = ''
  searchResults.value = []
  delta.value = null
  reason.value = ''
  await loadPlayer(p.id)
}

// Switching currency re-loads the selected player against the other ledger.
watch(currency, () => {
  delta.value = null
  reason.value = ''
  error.value = ''
  if (selected.value) loadPlayer(selected.value.id)
})

const previewBalance = computed(() => {
  if (!selected.value) return null
  const d = Number(delta.value)
  if (!Number.isFinite(d) || d === 0) return selected.value.balance
  return selected.value.balance + Math.trunc(d)
})
const previewNegative = computed(() => (previewBalance.value ?? 0) < 0)

async function apply() {
  if (!selected.value || saving.value) return
  const d = Math.trunc(Number(delta.value))
  if (!Number.isFinite(d) || d === 0) { error.value = t('dotacoinsDelta'); return }
  if (previewNegative.value) { error.value = t('dotacoinsNegative'); return }
  saving.value = true
  error.value = ''
  try {
    const res = currency.value === 'gcoins'
      ? await api.adjustGcoins(selected.value.id, d, reason.value.trim() || undefined)
      : await api.adjustDotacoins(selected.value.id, d, reason.value.trim() || undefined)
    selected.value.balance = currency.value === 'gcoins' ? res.gcoins : res.dotacoins
    // Refresh the transaction log so the new row shows immediately.
    await loadPlayer(selected.value.id)
    delta.value = null
    reason.value = ''
  } catch (e: any) {
    error.value = e?.message || 'Failed to adjust'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div>
      <h1 class="text-2xl font-semibold text-foreground flex items-center gap-2">
        <Coins class="w-5 h-5 text-yellow-500" />
        {{ pageTitle }}
      </h1>
      <p class="text-sm text-muted-foreground mt-1">{{ pageDesc }}</p>
    </div>

    <!-- Currency toggle (only when the admin can manage more than one) -->
    <div v-if="availableCurrencies.length > 1" class="flex items-center gap-2">
      <button
        v-for="c in availableCurrencies" :key="c"
        type="button"
        class="px-4 py-1.5 rounded-lg text-sm font-semibold border-2 transition-colors"
        :class="currency === c
          ? 'border-yellow-500 bg-yellow-500/10 text-yellow-500'
          : 'border-border/60 text-muted-foreground hover:border-yellow-500/40'"
        @click="currency = c"
      >
        {{ c === 'gcoins' ? t('gcoins') : t('dotacoins') }}
      </button>
    </div>

    <!-- Player search -->
    <div class="card p-4 flex flex-col gap-3">
      <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('dotacoinsFindPlayer') }}</label>
      <div class="flex items-center gap-2 px-3 py-2 bg-accent/40 border border-border/40 rounded-lg">
        <Search class="w-4 h-4 text-muted-foreground" />
        <input
          v-model="searchQuery"
          type="text"
          class="flex-1 bg-transparent text-sm focus:outline-none"
          :placeholder="t('dotacoinsSearchPlaceholder')"
          @input="onSearchInput"
        />
      </div>
      <div v-if="searchResults.length" class="flex flex-col gap-1 border border-border/40 rounded-lg overflow-hidden">
        <button
          v-for="p in searchResults" :key="p.id"
          type="button"
          class="px-3 py-2 flex items-center gap-2 text-left hover:bg-accent/40 transition-colors"
          @click="pickPlayer(p)"
        >
          <img v-if="p.avatar_url" :src="p.avatar_url" class="w-7 h-7 rounded-full" />
          <div v-else class="w-7 h-7 rounded-full bg-accent" />
          <span class="text-sm flex-1 truncate">{{ p.display_name || p.name }}</span>
          <span class="text-[11px] text-muted-foreground">#{{ p.id }}</span>
        </button>
      </div>
    </div>

    <div v-if="loading" class="text-sm text-muted-foreground flex items-center gap-2">
      <Loader2 class="w-4 h-4 animate-spin" /> {{ t('loading') }}…
    </div>

    <!-- Selected player -->
    <template v-else-if="selected">
      <div class="card p-5 flex flex-col gap-5">
        <div class="flex items-center gap-3">
          <img v-if="selected.avatar_url" :src="selected.avatar_url" class="w-12 h-12 rounded-full" />
          <div v-else class="w-12 h-12 rounded-full bg-accent" />
          <div class="flex-1 min-w-0">
            <p class="text-base font-semibold truncate">{{ selected.display_name }}</p>
            <p class="text-[11px] text-muted-foreground font-mono">#{{ selected.id }}</p>
          </div>
          <div class="text-right">
            <p class="text-[10px] uppercase tracking-wider text-muted-foreground">{{ currencyLabel }}</p>
            <p class="text-2xl font-bold font-mono text-yellow-500 tabular-nums">{{ selected.balance.toLocaleString() }}</p>
          </div>
        </div>

        <!-- Adjust form -->
        <div class="flex flex-col gap-3 border-t border-border/30 pt-4">
          <div class="flex items-center gap-2">
            <button type="button" class="btn-secondary px-2.5 py-2" :title="t('dotacoinsSubtract')" @click="delta = -Math.abs(delta || 0) || -1"><Minus class="w-4 h-4" /></button>
            <input
              v-model.number="delta"
              type="number"
              class="input-field flex-1 text-center font-mono"
              :placeholder="t('dotacoinsDeltaPlaceholder')"
            />
            <button type="button" class="btn-secondary px-2.5 py-2" :title="t('dotacoinsAdd')" @click="delta = Math.abs(delta || 0) || 1"><Plus class="w-4 h-4" /></button>
          </div>
          <input
            v-model="reason"
            type="text"
            class="input-field"
            :maxlength="280"
            :placeholder="t('dotacoinsReasonPlaceholder')"
          />
          <p v-if="delta" class="text-xs text-muted-foreground">
            {{ t('dotacoinsNewBalance') }}:
            <span class="font-mono font-bold" :class="previewNegative ? 'text-red-500' : 'text-foreground'">{{ (previewBalance ?? 0).toLocaleString() }}</span>
          </p>
          <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
          <button class="btn-primary justify-center" :disabled="saving || !delta || previewNegative" @click="apply">
            {{ saving ? `${t('saving')}…` : t('dotacoinsApply') }}
          </button>
        </div>
      </div>

      <!-- Transaction log -->
      <div class="card overflow-hidden">
        <div class="px-4 py-3 border-b border-border/30">
          <h2 class="text-sm font-semibold">{{ t('dotacoinsHistory') }}</h2>
        </div>
        <div v-if="transactions.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">{{ t('dotacoinsNoHistory') }}</div>
        <div v-else>
          <div v-for="tx in transactions" :key="tx.id" class="px-4 py-2.5 flex items-center gap-3 border-b border-border/20 last:border-b-0">
            <span class="font-mono font-bold tabular-nums w-20 shrink-0" :class="tx.delta > 0 ? 'text-green-500' : 'text-red-500'">
              {{ tx.delta > 0 ? `+${tx.delta.toLocaleString()}` : tx.delta.toLocaleString() }}
            </span>
            <span class="flex-1 min-w-0 text-sm truncate">{{ tx.reason || '—' }}</span>
            <span v-if="tx.created_by_name" class="text-[11px] text-muted-foreground truncate max-w-[120px]">{{ tx.created_by_name }}</span>
            <span class="text-[11px] text-muted-foreground font-mono">{{ fmtDateTime(new Date(tx.created_at)) }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
