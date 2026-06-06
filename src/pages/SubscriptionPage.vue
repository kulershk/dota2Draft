<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Crown, Coins, Check, CheckCircle2, Loader2, Sparkles, ExternalLink, ImagePlus, X } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { fmtDateTime } from '@/utils/format'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import ImageCropper from '@/components/common/ImageCropper.vue'

interface Plan {
  id: number
  name: string
  slug: string
  description: string | null
  price_dotacoins: number
  duration_days: number
  trial_enabled: boolean
  trial_days: number
  trial_max_concurrent: number
  perks: Record<string, boolean | number>
  badge_url: string | null
  sort_order: number
}
interface TrialState {
  used_plan_ids: number[]
  active_counts: Record<number, number>
}
interface MySub {
  subscription_id: number
  status: string
  source: string
  auto_renew: boolean
  started_at: string
  expires_at: string | null
  plan_id: number
  plan_name: string
  plan_slug: string
  plan_badge_url: string | null
  plan_perks: Record<string, boolean | number>
  price_dotacoins: number
  duration_days: number
}

// Perk key → i18n label key. Mirrors the admin PERK_OPTIONS catalogue so plan
// cards advertise the same perks the admin configures.
const PERK_LABELS: Record<string, string> = {
  auto_requeue: 'perkAutoRequeue',
  profile_banner: 'perkProfileBanner',
  avatar_decoration: 'perkAvatarDecoration',
  gcoin_multiplier: 'perkGcoinMultiplier',
}

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

const plans = ref<Plan[]>([])
const mySub = ref<MySub | null>(null)
const balance = ref(0)
const trial = ref<TrialState>({ used_plan_ids: [], active_counts: {} })
const loading = ref(true)
const error = ref('')
// Discord invite for the "buy dotacoins" card — links to the same site setting
// the homepage Discord card uses. Empty string just hides the button.
const discordUrl = ref('')

// ── Profile banners (profile_banner perk) ──
// The perk grants three independent banners, one per surface. Each slot crops
// to that surface's aspect (matching server/routes/users.js BANNER_SLOTS) and
// stores to its own column on the player, surfaced via store.currentUser.
interface BannerSlot {
  key: 'profile' | 'leaderboard' | 'queue'
  field: 'profile_banner_url' | 'leaderboard_banner_url' | 'queue_banner_url'
  w: number
  h: number
  labelKey: string
  descKey: string
}
const BANNER_SLOTS: BannerSlot[] = [
  { key: 'profile',     field: 'profile_banner_url',     w: 1200, h: 300, labelKey: 'bannerSlotProfile',     descKey: 'bannerSlotProfileDesc' },
  { key: 'leaderboard', field: 'leaderboard_banner_url', w: 1200, h: 200, labelKey: 'bannerSlotLeaderboard', descKey: 'bannerSlotLeaderboardDesc' },
  { key: 'queue',       field: 'queue_banner_url',       w: 360,  h: 400, labelKey: 'bannerSlotQueue',       descKey: 'bannerSlotQueueDesc' },
]
// Perk gate mirrors the server: only an active plan granting profile_banner
// unlocks the manager. Read from the live subscription so it reacts to a fresh
// subscribe/cancel without a full reload.
const hasBannerPerk = computed(() => mySub.value?.plan_perks?.profile_banner === true)
const bannerError = ref('')
const bannerBusySlot = ref<string | null>(null)
const bannerFileInput = ref<HTMLInputElement | null>(null)
const pendingSlot = ref<BannerSlot | null>(null)
const cropSlot = ref<BannerSlot | null>(null)
const cropFile = ref<File | null>(null)

function bannerUrlFor(slot: BannerSlot): string | null {
  return (store.currentUser.value as any)?.[slot.field] || null
}
function triggerBannerPick(slot: BannerSlot) {
  bannerError.value = ''
  pendingSlot.value = slot
  bannerFileInput.value?.click()
}
function onBannerPicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // allow re-picking the same file later
  if (!file || !pendingSlot.value) return
  cropFile.value = file
  cropSlot.value = pendingSlot.value
}
async function handleBannerCrop(blob: Blob) {
  const slot = cropSlot.value
  cropSlot.value = null
  if (!slot) return
  const file = new File([blob], `${slot.key}-banner.png`, { type: 'image/png' })
  bannerBusySlot.value = slot.key
  bannerError.value = ''
  try {
    const r = await api.uploadBanner(slot.key, file)
    if (store.currentUser.value) (store.currentUser.value as any)[slot.field] = r.url
  } catch (e: any) {
    bannerError.value = e?.message || t('bannerUploadFailed')
  } finally {
    bannerBusySlot.value = null
  }
}
async function removeBanner(slot: BannerSlot) {
  bannerBusySlot.value = slot.key
  bannerError.value = ''
  try {
    await api.deleteBanner(slot.key)
    if (store.currentUser.value) (store.currentUser.value as any)[slot.field] = null
  } catch (e: any) {
    bannerError.value = e?.message || t('bannerUploadFailed')
  } finally {
    bannerBusySlot.value = null
  }
}

const confirmPlan = ref<Plan | null>(null)
const subscribing = ref(false)
const confirmTrialPlan = ref<Plan | null>(null)
const startingTrial = ref(false)
const showCancel = ref(false)
const cancelling = ref(false)
const flash = ref<{ type: 'ok' | 'err'; text: string } | null>(null)

const isLoggedIn = computed(() => !!store.currentUser.value)
// Plans shown on the page: anything self-purchasable (price > 0) OR offering a
// free trial. Price-0, trial-off plans stay admin-assign-only and are hidden.
const visiblePlans = computed(() =>
  plans.value.filter(p => (p.price_dotacoins || 0) > 0 || p.trial_enabled)
)

// Has this player already used their one trial for the plan?
function trialUsed(plan: Plan): boolean {
  return trial.value.used_plan_ids.includes(plan.id)
}
// Seats left for the plan's trial (Infinity when uncapped). null = no cap.
function trialSeatsLeft(plan: Plan): number {
  const cap = plan.trial_max_concurrent || 0
  if (cap <= 0) return Infinity
  return Math.max(0, cap - (trial.value.active_counts[plan.id] || 0))
}
// Can the player start a trial right now? Mirrors the server's three rules:
// trial enabled, no active sub, not already trialed, and a free seat.
function canTry(plan: Plan): boolean {
  return plan.trial_enabled && !mySub.value && !trialUsed(plan) && trialSeatsLeft(plan) > 0
}

function planPerks(perks: Record<string, boolean | number>): string[] {
  const out: string[] = []
  for (const [key, val] of Object.entries(perks || {})) {
    if (key === 'gcoin_multiplier') {
      const n = Number(val)
      if (n > 1) out.push(`${t('perkGcoinMultiplier')} (×${n})`)
    } else if (val === true && PERK_LABELS[key]) {
      out.push(t(PERK_LABELS[key]))
    }
  }
  return out
}

function isCurrent(plan: Plan): boolean {
  return !!mySub.value && mySub.value.plan_id === plan.id
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [planList, mine] = await Promise.all([
      api.getActiveSubscriptionPlans() as Promise<Plan[]>,
      api.getMySubscription() as Promise<{ subscription: MySub | null; dotacoins: number; trial?: TrialState }>,
    ])
    plans.value = planList
    mySub.value = mine.subscription
    balance.value = mine.dotacoins
    trial.value = mine.trial || { used_plan_ids: [], active_counts: {} }
    // Keep the top-bar wallet in sync with the freshly-read balance.
    if (store.currentUser.value) store.currentUser.value.dotacoins = mine.dotacoins
  } catch (e: any) {
    error.value = e.message || 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function confirmSubscribe() {
  if (!confirmPlan.value) return
  subscribing.value = true
  flash.value = null
  try {
    const plan = confirmPlan.value
    const res: any = await api.subscribeWithDotacoins(plan.id)
    balance.value = res.dotacoins
    if (store.currentUser.value) {
      store.currentUser.value.dotacoins = res.dotacoins
      // Update the cached subscription summary so the sidebar badge + perk
      // gating react immediately, without waiting for a full /me refetch.
      store.currentUser.value.subscription = {
        plan_id: plan.id,
        plan_name: plan.name,
        plan_slug: plan.slug,
        badge_url: plan.badge_url || null,
        perks: (plan.perks || {}) as Record<string, boolean>,
      }
    }
    confirmPlan.value = null
    flash.value = { type: 'ok', text: t('subscriptionSubscribed') }
    await load()
  } catch (e: any) {
    flash.value = { type: 'err', text: e.message || 'Failed to subscribe' }
  } finally {
    subscribing.value = false
  }
}

async function confirmStartTrial() {
  if (!confirmTrialPlan.value) return
  startingTrial.value = true
  flash.value = null
  try {
    const plan = confirmTrialPlan.value
    await api.startSubscriptionTrial(plan.id)
    if (store.currentUser.value) {
      // Reflect the trial's perks in the cached subscription summary so the
      // sidebar badge + perk gating react immediately.
      store.currentUser.value.subscription = {
        plan_id: plan.id,
        plan_name: plan.name,
        plan_slug: plan.slug,
        badge_url: plan.badge_url || null,
        perks: (plan.perks || {}) as Record<string, boolean>,
      }
    }
    confirmTrialPlan.value = null
    flash.value = { type: 'ok', text: t('subscriptionTrialStarted') }
    await load()
  } catch (e: any) {
    flash.value = { type: 'err', text: e.message || 'Failed to start trial' }
  } finally {
    startingTrial.value = false
  }
}

async function confirmCancel() {
  cancelling.value = true
  flash.value = null
  try {
    await api.cancelMySubscription()
    showCancel.value = false
    flash.value = { type: 'ok', text: t('subscriptionCancelled') }
    await load()
  } catch (e: any) {
    flash.value = { type: 'err', text: e.message || 'Failed to cancel' }
  } finally {
    cancelling.value = false
  }
}

onMounted(() => {
  load()
  const { cached, fresh } = api.getSiteSettingsCached()
  if (cached?.site_discord_url) discordUrl.value = cached.site_discord_url
  fresh.then((d: any) => { discordUrl.value = d?.site_discord_url || '' }).catch(() => {})
})
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-6 max-w-[900px] mx-auto w-full">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-foreground flex items-center gap-2">
          <Crown class="w-6 h-6 text-amber-400" />
          {{ t('subscriptionTitle') }}
        </h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('subscriptionSubtitle') }}</p>
      </div>
      <div v-if="isLoggedIn" class="shrink-0 flex flex-col items-end">
        <span class="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{{ t('subscriptionBalance') }}</span>
        <span class="flex items-center gap-1.5 text-lg font-extrabold font-mono text-amber-400">
          <Coins class="w-4 h-4" />
          {{ balance.toLocaleString() }}
        </span>
      </div>
    </div>

    <!-- Buy dotacoins via Discord — informational, shown to everyone -->
    <div class="card p-5 flex flex-col gap-3 border-amber-500/30">
      <div class="flex items-center gap-2">
        <Coins class="w-5 h-5 text-amber-400" />
        <h2 class="text-base font-bold text-foreground">{{ t('subscriptionBuyTitle') }}</h2>
      </div>
      <p class="text-sm text-muted-foreground">{{ t('subscriptionBuyBody') }}</p>
      <div class="flex items-center gap-2 text-sm flex-wrap">
        <span class="text-muted-foreground">{{ t('subscriptionBuyCmdPrefix') }}</span>
        <code class="px-2 py-0.5 rounded bg-accent/50 border border-border/50 font-mono text-amber-300">/buydotacoins</code>
        <span class="text-muted-foreground">{{ t('subscriptionBuyCmdHint') }}</span>
      </div>
      <a v-if="discordUrl" :href="discordUrl" target="_blank" rel="noopener" class="btn-secondary text-sm self-start">
        <ExternalLink class="w-4 h-4" />
        {{ t('subscriptionBuyJoinDiscord') }}
      </a>
      <p class="text-xs text-muted-foreground/80 italic border-t border-border/40 pt-3 mt-1">
        {{ t('subscriptionBuyNote') }}
      </p>
    </div>

    <div v-if="!isLoggedIn" class="card px-6 py-10 text-center text-sm text-muted-foreground">
      {{ t('subscriptionLoginRequired') }}
    </div>

    <template v-else>
      <div v-if="flash" class="text-sm font-medium" :class="flash.type === 'ok' ? 'text-color-success' : 'text-destructive'">
        {{ flash.text }}
      </div>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>

      <div v-if="loading" class="card px-6 py-10 text-center text-sm text-muted-foreground">{{ t('loading') }}</div>

      <template v-else>
        <!-- Current subscription -->
        <div v-if="mySub" class="card overflow-hidden">
          <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
            <CheckCircle2 class="w-4 h-4 text-emerald-400" />
            <span class="text-sm font-semibold text-foreground">{{ t('subscriptionCurrentPlan') }}</span>
          </div>
          <div class="px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4">
            <img v-if="mySub.plan_badge_url" :src="mySub.plan_badge_url" class="w-12 h-12 rounded object-cover border border-border shrink-0" :alt="mySub.plan_name" />
            <Crown v-else class="w-10 h-10 text-amber-400 shrink-0" />
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-base font-bold text-foreground">{{ mySub.plan_name }}</span>
                <span
                  v-if="mySub.source === 'trial'"
                  class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 flex items-center gap-1"
                >
                  <Sparkles class="w-3 h-3" />
                  {{ t('subscriptionTrialBadge') }}
                </span>
                <span
                  v-else
                  class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                  :class="mySub.auto_renew ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'"
                >
                  {{ mySub.auto_renew ? t('subscriptionAutoRenewOn') : t('subscriptionAutoRenewOff') }}
                </span>
              </div>
              <p class="text-xs text-muted-foreground mt-1">
                <template v-if="mySub.expires_at">
                  {{ mySub.source === 'trial'
                      ? t('subscriptionTrialEndsOn', { date: fmtDateTime(new Date(mySub.expires_at)) })
                      : mySub.auto_renew
                        ? t('subscriptionRenewsOn', { date: fmtDateTime(new Date(mySub.expires_at)) })
                        : t('subscriptionEndsOn', { date: fmtDateTime(new Date(mySub.expires_at)) }) }}
                </template>
              </p>
              <p v-if="mySub.price_dotacoins > 0" class="text-xs text-amber-400/90 font-mono mt-0.5">
                {{ t('subscriptionPerPeriod', { price: mySub.price_dotacoins.toLocaleString(), days: mySub.duration_days }) }}
              </p>
            </div>
            <button
              v-if="mySub.auto_renew"
              class="btn-secondary text-sm shrink-0"
              @click="showCancel = true"
            >
              {{ t('subscriptionCancel') }}
            </button>
          </div>
        </div>

        <!-- Profile banners (profile_banner perk): one per surface -->
        <div v-if="mySub && hasBannerPerk" class="card overflow-hidden">
          <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
            <ImagePlus class="w-4 h-4 text-primary" />
            <span class="text-sm font-semibold text-foreground">{{ t('bannerManagerTitle') }}</span>
          </div>
          <div class="px-5 py-4 flex flex-col gap-5">
            <p class="text-xs text-muted-foreground -mt-1">{{ t('bannerManagerSubtitle') }}</p>
            <p v-if="bannerError" class="text-xs text-destructive">{{ bannerError }}</p>

            <div v-for="slot in BANNER_SLOTS" :key="slot.key" class="flex flex-col sm:flex-row sm:items-center gap-3">
              <div class="sm:w-44 shrink-0">
                <div class="text-sm font-semibold text-foreground">{{ t(slot.labelKey) }}</div>
                <div class="text-xs text-muted-foreground mt-0.5">{{ t(slot.descKey) }}</div>
                <div class="text-[11px] font-mono text-muted-foreground/80 mt-1">{{ t('bannerRecommendedSize', { w: slot.w, h: slot.h }) }}</div>
              </div>

              <!-- Preview at the slot's true aspect so the user sees the real crop -->
              <div
                class="flex-1 min-w-0 rounded-lg overflow-hidden border border-border bg-accent/30 relative"
                :style="{ aspectRatio: `${slot.w} / ${slot.h}`, maxWidth: '420px' }"
              >
                <img v-if="bannerUrlFor(slot)" :src="bannerUrlFor(slot)!" class="w-full h-full object-cover" :alt="t(slot.labelKey)" />
                <div v-else class="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground">
                  {{ t('bannerSlotEmpty') }}
                </div>
                <div v-if="bannerBusySlot === slot.key" class="absolute inset-0 bg-black/40 flex items-center justify-center">
                  <Loader2 class="w-5 h-5 animate-spin text-white" />
                </div>
              </div>

              <div class="flex sm:flex-col gap-2 shrink-0">
                <button
                  class="btn-secondary text-xs justify-center"
                  :disabled="bannerBusySlot === slot.key"
                  @click="triggerBannerPick(slot)"
                >
                  <ImagePlus class="w-3.5 h-3.5" />
                  {{ bannerUrlFor(slot) ? t('bannerChange') : t('bannerUpload') }}
                </button>
                <button
                  v-if="bannerUrlFor(slot)"
                  class="btn-secondary text-xs justify-center text-destructive hover:bg-destructive/10"
                  :disabled="bannerBusySlot === slot.key"
                  @click="removeBanner(slot)"
                >
                  <X class="w-3.5 h-3.5" />
                  {{ t('bannerRemove') }}
                </button>
              </div>
            </div>

            <input ref="bannerFileInput" type="file" accept="image/*" class="hidden" @change="onBannerPicked" />
          </div>
        </div>

        <!-- Plan catalogue -->
        <div v-if="visiblePlans.length === 0 && !mySub" class="card px-6 py-10 text-center text-sm text-muted-foreground">
          {{ t('subscriptionNoPlans') }}
        </div>
        <div v-if="visiblePlans.length" class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div
            v-for="plan in visiblePlans"
            :key="plan.id"
            class="card p-5 flex flex-col gap-3"
            :class="isCurrent(plan) && 'ring-1 ring-emerald-500/40'"
          >
            <div class="flex items-center gap-3">
              <img v-if="plan.badge_url" :src="plan.badge_url" class="w-10 h-10 rounded object-cover border border-border shrink-0" :alt="plan.name" />
              <Crown v-else class="w-8 h-8 text-amber-400 shrink-0" />
              <div class="min-w-0">
                <h3 class="text-base font-bold text-foreground truncate">{{ plan.name }}</h3>
                <p v-if="plan.price_dotacoins > 0" class="text-sm font-mono text-amber-400">
                  {{ t('subscriptionPerPeriod', { price: plan.price_dotacoins.toLocaleString(), days: plan.duration_days }) }}
                </p>
                <p v-else-if="plan.trial_enabled" class="text-sm font-mono text-violet-300">
                  {{ t('subscriptionTrialFree', { days: plan.trial_days }) }}
                </p>
              </div>
            </div>

            <p v-if="plan.description" class="text-xs text-muted-foreground">{{ plan.description }}</p>

            <ul v-if="planPerks(plan.perks).length" class="flex flex-col gap-1.5 mt-1">
              <li v-for="perk in planPerks(plan.perks)" :key="perk" class="flex items-center gap-2 text-xs text-foreground">
                <Check class="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                {{ perk }}
              </li>
            </ul>

            <div class="mt-auto pt-2 flex flex-col gap-2">
              <button
                v-if="isCurrent(plan)"
                class="btn-secondary w-full justify-center text-sm opacity-70 cursor-default"
                disabled
              >
                <Check class="w-4 h-4" />
                {{ t('subscriptionCurrentPlan') }}
              </button>
              <template v-else>
                <!-- Buy (dotacoins) -->
                <template v-if="plan.price_dotacoins > 0">
                  <button
                    class="btn-primary w-full justify-center text-sm"
                    :disabled="balance < plan.price_dotacoins"
                    @click="confirmPlan = plan"
                  >
                    {{ mySub ? t('subscriptionSwitch') : t('subscriptionSubscribe') }}
                  </button>
                  <p v-if="balance < plan.price_dotacoins" class="text-[11px] text-destructive text-center">
                    {{ t('subscriptionNotEnough') }}
                  </p>
                </template>

                <!-- Free trial -->
                <template v-if="plan.trial_enabled">
                  <button
                    v-if="canTry(plan)"
                    class="btn-secondary w-full justify-center text-sm border-violet-500/40 text-violet-200 hover:bg-violet-500/10"
                    @click="confirmTrialPlan = plan"
                  >
                    <Sparkles class="w-4 h-4" />
                    {{ t('subscriptionTryFor', { days: plan.trial_days }) }}
                  </button>
                  <p v-else-if="trialUsed(plan)" class="text-[11px] text-muted-foreground text-center">
                    {{ t('subscriptionTrialUsed') }}
                  </p>
                  <p v-else-if="!mySub && trialSeatsLeft(plan) <= 0" class="text-[11px] text-amber-400/90 text-center">
                    {{ t('subscriptionTrialFull') }}
                  </p>
                </template>
              </template>
            </div>
          </div>
        </div>
      </template>
    </template>

    <!-- Subscribe confirm modal -->
    <ModalOverlay :show="!!confirmPlan" @close="confirmPlan = null">
      <div v-if="confirmPlan" class="px-7 py-6 flex flex-col gap-4">
        <h2 class="text-xl font-semibold text-foreground">{{ t('subscriptionConfirmTitle', { plan: confirmPlan.name }) }}</h2>
        <p class="text-sm text-muted-foreground">
          {{ t('subscriptionConfirmBody', { price: confirmPlan.price_dotacoins.toLocaleString(), days: confirmPlan.duration_days }) }}
        </p>
        <p v-if="mySub" class="text-xs text-amber-400/90">{{ t('subscriptionSwitchNote') }}</p>
        <div class="flex items-center justify-between text-sm rounded-lg bg-accent/30 border border-border/40 px-4 py-3">
          <span class="text-muted-foreground">{{ t('subscriptionConfirmBalanceAfter') }}</span>
          <span class="font-mono font-bold text-amber-400">{{ (balance - confirmPlan.price_dotacoins).toLocaleString() }}</span>
        </div>
        <div class="flex flex-col gap-3 mt-2">
          <button class="btn-primary w-full justify-center" :disabled="subscribing" @click="confirmSubscribe">
            <Loader2 v-if="subscribing" class="w-4 h-4 animate-spin" />
            <Coins v-else class="w-4 h-4" />
            {{ subscribing ? t('saving') : t('subscriptionConfirmBtn') }}
          </button>
          <button class="btn-secondary w-full justify-center" :disabled="subscribing" @click="confirmPlan = null">{{ t('cancel') }}</button>
        </div>
      </div>
    </ModalOverlay>

    <!-- Start trial confirm modal -->
    <ModalOverlay :show="!!confirmTrialPlan" @close="confirmTrialPlan = null">
      <div v-if="confirmTrialPlan" class="px-7 py-6 flex flex-col gap-4">
        <h2 class="text-xl font-semibold text-foreground flex items-center gap-2">
          <Sparkles class="w-5 h-5 text-violet-300" />
          {{ t('subscriptionTrialConfirmTitle', { plan: confirmTrialPlan.name }) }}
        </h2>
        <p class="text-sm text-muted-foreground">
          {{ t('subscriptionTrialConfirmBody', { days: confirmTrialPlan.trial_days }) }}
        </p>
        <div class="flex flex-col gap-3 mt-2">
          <button class="btn-primary w-full justify-center" :disabled="startingTrial" @click="confirmStartTrial">
            <Loader2 v-if="startingTrial" class="w-4 h-4 animate-spin" />
            <Sparkles v-else class="w-4 h-4" />
            {{ startingTrial ? t('saving') : t('subscriptionTrialConfirmBtn') }}
          </button>
          <button class="btn-secondary w-full justify-center" :disabled="startingTrial" @click="confirmTrialPlan = null">{{ t('cancel') }}</button>
        </div>
      </div>
    </ModalOverlay>

    <!-- Cancel auto-renew confirm modal -->
    <ModalOverlay :show="showCancel" @close="showCancel = false">
      <div v-if="mySub" class="px-7 py-6 flex flex-col gap-4">
        <h2 class="text-xl font-semibold text-foreground">{{ t('subscriptionCancelTitle') }}</h2>
        <p class="text-sm text-muted-foreground">
          {{ t('subscriptionCancelBody', {
              plan: mySub.plan_name,
              date: mySub.expires_at ? fmtDateTime(new Date(mySub.expires_at)) : '—',
          }) }}
        </p>
        <div class="flex flex-col gap-3 mt-2">
          <button class="btn-secondary w-full justify-center" :disabled="cancelling" @click="confirmCancel">
            <Loader2 v-if="cancelling" class="w-4 h-4 animate-spin" />
            {{ cancelling ? t('saving') : t('subscriptionCancelConfirm') }}
          </button>
          <button class="btn-primary w-full justify-center" :disabled="cancelling" @click="showCancel = false">{{ t('subscriptionKeep') }}</button>
        </div>
      </div>
    </ModalOverlay>

    <!-- Banner crop step — aspect/output sized per the slot being edited -->
    <ImageCropper
      v-if="cropSlot"
      :show="!!cropSlot"
      :image-file="cropFile"
      :aspect-ratio="cropSlot.w / cropSlot.h"
      :output-width="cropSlot.w"
      :output-height="cropSlot.h"
      @crop="handleBannerCrop"
      @close="cropSlot = null"
    />
  </div>
</template>
