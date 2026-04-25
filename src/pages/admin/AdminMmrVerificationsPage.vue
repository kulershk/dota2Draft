<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Shield, Check, X, ExternalLink, Loader2 } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'

interface Submission {
  id: number
  player_id: number
  submitted_mmr: number
  screenshot_url: string
  status: 'pending' | 'approved' | 'rejected'
  submitted_at: string
  reviewed_at: string | null
  review_note: string | null
  player_name: string
  player_display_name: string
  player_avatar: string | null
  player_current_mmr: number
  reviewed_by_name: string | null
}

const { t } = useI18n()
const api = useApi()

const tab = ref<'pending' | 'approved' | 'rejected' | 'all'>('pending')
const rows = ref<Submission[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const acting = ref<number | null>(null)

async function load() {
  loading.value = true
  error.value = null
  try {
    rows.value = await api.getAdminMmrVerifications(tab.value)
  } catch (e: any) {
    error.value = e.message || 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function approve(s: Submission) {
  if (!confirm(t('mmrVerificationApproveConfirm', { name: s.player_display_name, mmr: s.submitted_mmr }))) return
  acting.value = s.id
  try {
    await api.approveMmrVerification(s.id)
    await load()
  } catch (e: any) {
    alert(e.message || 'Approve failed')
  } finally {
    acting.value = null
  }
}

async function reject(s: Submission) {
  const note = prompt(t('mmrVerificationRejectPrompt'))
  if (note === null) return
  acting.value = s.id
  try {
    await api.rejectMmrVerification(s.id, note || undefined)
    await load()
  } catch (e: any) {
    alert(e.message || 'Reject failed')
  } finally {
    acting.value = null
  }
}

const pendingCount = computed(() => rows.value.filter(r => r.status === 'pending').length)

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function deltaText(s: Submission): string {
  const d = s.submitted_mmr - (s.player_current_mmr || 0)
  if (d > 0) return `+${d}`
  if (d < 0) return String(d)
  return '0'
}
function deltaClass(s: Submission): string {
  const d = s.submitted_mmr - (s.player_current_mmr || 0)
  if (d > 0) return 'text-green-500'
  if (d < 0) return 'text-red-500'
  return 'text-muted-foreground'
}

onMounted(load)
</script>

<template>
  <div class="p-6 max-w-[1200px] mx-auto">
    <div class="flex items-center gap-3 mb-5">
      <Shield class="w-6 h-6 text-primary" />
      <h1 class="text-2xl font-bold">{{ t('adminMmrVerifications') }}</h1>
    </div>

    <div class="flex items-center gap-1 border-b border-border/40 mb-4">
      <button
        v-for="t_ in (['pending', 'approved', 'rejected', 'all'] as const)" :key="t_"
        type="button"
        class="px-4 py-2 text-sm border-b-2 transition-colors flex items-center gap-1.5"
        :class="tab === t_ ? 'border-primary text-foreground font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="tab = t_; load()"
      >
        {{ t('mmrVerificationTab_' + t_) }}
        <span v-if="t_ === 'pending' && tab === 'pending' && pendingCount > 0"
              class="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[10px] font-bold tabular-nums">
          {{ pendingCount }}
        </span>
      </button>
    </div>

    <div v-if="loading" class="text-sm text-muted-foreground flex items-center gap-2">
      <Loader2 class="w-4 h-4 animate-spin" /> {{ t('loading') }}…
    </div>
    <div v-else-if="error" class="card p-4 border border-destructive/40 text-destructive text-sm">{{ error }}</div>
    <div v-else-if="rows.length === 0" class="card p-8 text-center text-muted-foreground text-sm">
      {{ t('mmrVerificationEmpty') }}
    </div>
    <div v-else class="flex flex-col gap-3">
      <div v-for="s in rows" :key="s.id" class="card p-4 flex items-center gap-4">
        <!-- Player -->
        <div class="flex items-center gap-2.5 min-w-0 w-[220px] shrink-0">
          <img v-if="s.player_avatar" :src="s.player_avatar" class="w-9 h-9 rounded-full object-cover" />
          <div v-else class="w-9 h-9 rounded-full bg-accent" />
          <div class="min-w-0">
            <p class="text-sm font-semibold truncate">{{ s.player_display_name }}</p>
            <p class="text-[11px] text-muted-foreground font-mono tabular-nums">#{{ s.player_id }}</p>
          </div>
        </div>

        <!-- MMR change -->
        <div class="flex items-center gap-3 shrink-0">
          <div class="text-center">
            <p class="text-[10px] uppercase tracking-wider text-muted-foreground">{{ t('mmrVerificationCurrent') }}</p>
            <p class="text-sm font-mono font-bold tabular-nums">{{ s.player_current_mmr || 0 }}</p>
          </div>
          <span class="text-muted-foreground">→</span>
          <div class="text-center">
            <p class="text-[10px] uppercase tracking-wider text-muted-foreground">{{ t('mmrVerificationRequested') }}</p>
            <p class="text-sm font-mono font-bold tabular-nums">{{ s.submitted_mmr }}</p>
          </div>
          <div class="text-center min-w-[50px]">
            <p class="text-[10px] uppercase tracking-wider text-muted-foreground">Δ</p>
            <p class="text-sm font-mono font-bold tabular-nums" :class="deltaClass(s)">{{ deltaText(s) }}</p>
          </div>
        </div>

        <!-- Screenshot -->
        <a :href="s.screenshot_url" target="_blank" class="shrink-0 group" :title="t('mmrVerificationScreenshot')">
          <img :src="s.screenshot_url" class="w-20 h-12 rounded object-cover border border-border/40 group-hover:border-primary/40 transition-colors" />
        </a>

        <!-- Meta -->
        <div class="flex-1 min-w-0">
          <p class="text-[11px] text-muted-foreground font-mono tabular-nums">{{ fmtTime(s.submitted_at) }}</p>
          <p v-if="s.status !== 'pending'" class="text-[11px] text-muted-foreground mt-0.5">
            <span class="font-semibold" :class="s.status === 'approved' ? 'text-green-500' : 'text-red-500'">
              {{ t('mmrVerificationStatus_' + s.status) }}
            </span>
            <template v-if="s.reviewed_by_name"> · {{ s.reviewed_by_name }}</template>
            <template v-if="s.reviewed_at"> · <span class="font-mono">{{ fmtTime(s.reviewed_at) }}</span></template>
          </p>
          <p v-if="s.review_note" class="text-[11px] italic text-muted-foreground mt-0.5 truncate" :title="s.review_note">"{{ s.review_note }}"</p>
        </div>

        <!-- Actions -->
        <div v-if="s.status === 'pending'" class="flex items-center gap-2 shrink-0">
          <button
            type="button"
            class="px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 bg-green-500/15 text-green-500 hover:bg-green-500/25 transition-colors disabled:opacity-40"
            :disabled="acting === s.id"
            @click="approve(s)"
          >
            <Check class="w-3.5 h-3.5" />
            {{ t('mmrVerificationApprove') }}
          </button>
          <button
            type="button"
            class="px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 bg-red-500/15 text-red-500 hover:bg-red-500/25 transition-colors disabled:opacity-40"
            :disabled="acting === s.id"
            @click="reject(s)"
          >
            <X class="w-3.5 h-3.5" />
            {{ t('mmrVerificationReject') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
