<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Crown, Coins, Check, CheckCircle2, Loader2 } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import { fmtDateTime } from '@/utils/format'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

interface Plan {
  id: number
  name: string
  slug: string
  description: string | null
  price_dotacoins: number
  duration_days: number
  perks: Record<string, boolean | number>
  badge_url: string | null
  sort_order: number
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
const loading = ref(true)
const error = ref('')

const confirmPlan = ref<Plan | null>(null)
const subscribing = ref(false)
const showCancel = ref(false)
const cancelling = ref(false)
const flash = ref<{ type: 'ok' | 'err'; text: string } | null>(null)

const isLoggedIn = computed(() => !!store.currentUser.value)
// Only plans priced in dotacoins are self-purchasable; price 0 = admin-only.
const buyablePlans = computed(() => plans.value.filter(p => (p.price_dotacoins || 0) > 0))

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
      api.getMySubscription() as Promise<{ subscription: MySub | null; dotacoins: number }>,
    ])
    plans.value = planList
    mySub.value = mine.subscription
    balance.value = mine.dotacoins
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

onMounted(load)
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
                  class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                  :class="mySub.auto_renew ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'"
                >
                  {{ mySub.auto_renew ? t('subscriptionAutoRenewOn') : t('subscriptionAutoRenewOff') }}
                </span>
              </div>
              <p class="text-xs text-muted-foreground mt-1">
                <template v-if="mySub.expires_at">
                  {{ mySub.auto_renew
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

        <!-- Plan catalogue -->
        <div v-if="buyablePlans.length === 0 && !mySub" class="card px-6 py-10 text-center text-sm text-muted-foreground">
          {{ t('subscriptionNoPlans') }}
        </div>
        <div v-if="buyablePlans.length" class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div
            v-for="plan in buyablePlans"
            :key="plan.id"
            class="card p-5 flex flex-col gap-3"
            :class="isCurrent(plan) && 'ring-1 ring-emerald-500/40'"
          >
            <div class="flex items-center gap-3">
              <img v-if="plan.badge_url" :src="plan.badge_url" class="w-10 h-10 rounded object-cover border border-border shrink-0" :alt="plan.name" />
              <Crown v-else class="w-8 h-8 text-amber-400 shrink-0" />
              <div class="min-w-0">
                <h3 class="text-base font-bold text-foreground truncate">{{ plan.name }}</h3>
                <p class="text-sm font-mono text-amber-400">
                  {{ t('subscriptionPerPeriod', { price: plan.price_dotacoins.toLocaleString(), days: plan.duration_days }) }}
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

            <div class="mt-auto pt-2">
              <button
                v-if="isCurrent(plan)"
                class="btn-secondary w-full justify-center text-sm opacity-70 cursor-default"
                disabled
              >
                <Check class="w-4 h-4" />
                {{ t('subscriptionCurrentPlan') }}
              </button>
              <template v-else>
                <button
                  class="btn-primary w-full justify-center text-sm"
                  :disabled="balance < plan.price_dotacoins"
                  @click="confirmPlan = plan"
                >
                  {{ mySub ? t('subscriptionSwitch') : t('subscriptionSubscribe') }}
                </button>
                <p v-if="balance < plan.price_dotacoins" class="text-[11px] text-destructive text-center mt-1.5">
                  {{ t('subscriptionNotEnough') }}
                </p>
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
  </div>
</template>
