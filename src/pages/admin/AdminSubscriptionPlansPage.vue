<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Crown, Plus, Pencil, Trash2, X, Eye, EyeOff, UserPlus, Search, BadgeCheck } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'

interface Plan {
  id: number
  name: string
  slug: string
  description: string | null
  price_cents: number
  currency: string
  perks: Record<string, any>
  badge_url: string | null
  is_active: boolean
  sort_order: number
  active_subscriber_count: number
  created_at: string
  updated_at: string
}

// Hardcoded perk catalogue. Adding a new perk = add a row here + a backend
// consumer that calls hasPerk('the_key'). The plan's perks JSONB stores
// boolean flags keyed by perk_key.
const PERK_OPTIONS: { key: string; labelKey: string; descKey: string }[] = [
  { key: 'auto_requeue', labelKey: 'perkAutoRequeue', descKey: 'perkAutoRequeueDesc' },
]
interface Subscriber {
  id: number
  player_id: number
  status: 'active' | 'cancelled' | 'expired'
  source: string
  external_id: string | null
  started_at: string
  expires_at: string | null
  cancelled_at: string | null
  player_name: string | null
  player_display_name: string | null
  player_avatar_url: string | null
  player_steam_id: string | null
}
interface PlayerSearchResult {
  id: number
  name: string
  display_name?: string | null
  avatar_url?: string | null
  steam_id?: string | null
}

const { t } = useI18n()
const api = useApi()

const plans = ref<Plan[]>([])
const loading = ref(false)
const error = ref('')

// One plan is "expanded" at a time to show its subscribers — keeps the page
// simple and avoids loading every subscriber list eagerly.
const expandedPlanId = ref<number | null>(null)
const subscribersByPlan = ref<Record<number, Subscriber[]>>({})
const subscribersLoading = ref<Record<number, boolean>>({})

// Plan create / edit modal
const showPlanModal = ref(false)
const editingPlan = ref<Plan | null>(null)
const planForm = ref({
  name: '',
  slug: '',
  description: '',
  price_cents: 0,
  currency: 'EUR',
  is_active: true,
  sort_order: 0,
  perks: {} as Record<string, boolean>,
})
const badgeFile = ref<File | null>(null)
const badgePreviewUrl = ref<string | null>(null)
const badgeUploading = ref(false)

// Subscriber assign modal
const showAssignModal = ref(false)
const assignToPlanId = ref<number | null>(null)
const playerQuery = ref('')
const playerResults = ref<PlayerSearchResult[]>([])
const playerSearching = ref(false)
const selectedPlayer = ref<PlayerSearchResult | null>(null)
const expiresAtLocal = ref('') // <input type="datetime-local"> wall clock
let playerSearchTimer: ReturnType<typeof setTimeout> | null = null

const sortedPlans = computed(() =>
  [...plans.value].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
)

function fmtPrice(cents: number, currency: string) {
  const v = (cents / 100).toFixed(2)
  return `${v} ${currency}`
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    plans.value = await api.getAdminSubscriptionPlans()
  } catch (e: any) {
    error.value = e.message || 'Failed to load plans'
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingPlan.value = null
  planForm.value = { name: '', slug: '', description: '', price_cents: 0, currency: 'EUR', is_active: true, sort_order: nextSortOrder(), perks: {} }
  badgeFile.value = null
  badgePreviewUrl.value = null
  error.value = ''
  showPlanModal.value = true
}

function nextSortOrder(): number {
  if (!plans.value.length) return 0
  return Math.max(...plans.value.map(p => p.sort_order)) + 10
}

function openEdit(plan: Plan) {
  editingPlan.value = plan
  // Coerce server perks JSONB into a flat boolean map for the checkboxes,
  // ignoring any unknown keys (forward-compatible with future perks).
  const perksMap: Record<string, boolean> = {}
  for (const opt of PERK_OPTIONS) perksMap[opt.key] = !!(plan.perks && plan.perks[opt.key])
  planForm.value = {
    name: plan.name,
    slug: plan.slug,
    description: plan.description || '',
    price_cents: plan.price_cents,
    currency: plan.currency,
    is_active: plan.is_active,
    sort_order: plan.sort_order,
    perks: perksMap,
  }
  badgeFile.value = null
  badgePreviewUrl.value = plan.badge_url
  error.value = ''
  showPlanModal.value = true
}

function onPickBadge(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  badgeFile.value = file
  badgePreviewUrl.value = URL.createObjectURL(file)
}

async function removeBadge() {
  if (!editingPlan.value || !editingPlan.value.badge_url) {
    badgeFile.value = null
    badgePreviewUrl.value = null
    return
  }
  if (!confirm(t('subscriptionPlanBadgeRemoveConfirm'))) return
  await api.deleteSubscriptionPlanBadge(editingPlan.value.id)
  badgePreviewUrl.value = null
  badgeFile.value = null
  await load()
  // Refresh the editingPlan reference so badge_url state reflects the deletion.
  const updated = plans.value.find(p => p.id === editingPlan.value!.id)
  if (updated) editingPlan.value = updated
}

async function savePlan() {
  error.value = ''
  if (!planForm.value.name.trim()) { error.value = t('subscriptionPlanNameRequired'); return }
  // Strip false keys so the perks JSONB doesn't accumulate dead flags over time.
  const perks: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(planForm.value.perks)) if (v) perks[k] = true

  const payload = {
    name: planForm.value.name.trim(),
    slug: planForm.value.slug.trim() || undefined,
    description: planForm.value.description.trim() || null,
    price_cents: Math.max(0, Math.floor(Number(planForm.value.price_cents) || 0)),
    currency: planForm.value.currency.trim() || 'EUR',
    is_active: planForm.value.is_active,
    sort_order: Math.floor(Number(planForm.value.sort_order) || 0),
    perks,
  }
  try {
    let savedPlanId: number
    if (editingPlan.value) {
      const updated: any = await api.updateSubscriptionPlan(editingPlan.value.id, payload)
      savedPlanId = updated.id
    } else {
      const created: any = await api.createSubscriptionPlan(payload)
      savedPlanId = created.id
    }
    if (badgeFile.value) {
      badgeUploading.value = true
      try {
        await api.uploadSubscriptionPlanBadge(savedPlanId, badgeFile.value)
      } finally {
        badgeUploading.value = false
      }
    }
    showPlanModal.value = false
    await load()
  } catch (e: any) {
    error.value = e.message || 'Failed to save plan'
  }
}

async function deletePlan(plan: Plan) {
  if (!confirm(t('subscriptionPlanDeleteConfirm', { name: plan.name }))) return
  try {
    await api.deleteSubscriptionPlan(plan.id)
    await load()
  } catch (e: any) {
    // 409 = has subscriber history — suggest setting inactive
    alert(e.message || 'Failed to delete')
  }
}

async function togglePlanActive(plan: Plan) {
  await api.updateSubscriptionPlan(plan.id, { is_active: !plan.is_active })
  await load()
}

async function toggleExpanded(planId: number) {
  if (expandedPlanId.value === planId) {
    expandedPlanId.value = null
    return
  }
  expandedPlanId.value = planId
  if (!subscribersByPlan.value[planId]) await loadSubscribers(planId)
}

async function loadSubscribers(planId: number) {
  subscribersLoading.value[planId] = true
  try {
    subscribersByPlan.value[planId] = await api.getSubscriptionPlanSubscribers(planId)
  } finally {
    subscribersLoading.value[planId] = false
  }
}

function openAssign(planId: number) {
  assignToPlanId.value = planId
  selectedPlayer.value = null
  playerQuery.value = ''
  playerResults.value = []
  expiresAtLocal.value = ''
  error.value = ''
  showAssignModal.value = true
}

watch(playerQuery, (q) => {
  if (playerSearchTimer) clearTimeout(playerSearchTimer)
  if (!q || q.trim().length < 2) { playerResults.value = []; return }
  playerSearchTimer = setTimeout(async () => {
    playerSearching.value = true
    try {
      playerResults.value = await api.searchPlayers(q.trim())
    } catch {
      playerResults.value = []
    } finally {
      playerSearching.value = false
    }
  }, 250)
})

function selectPlayer(p: PlayerSearchResult) {
  selectedPlayer.value = p
  playerQuery.value = p.display_name || p.name
  playerResults.value = []
}

async function assignSubscriber() {
  error.value = ''
  if (!assignToPlanId.value || !selectedPlayer.value) { error.value = t('subscriptionPlanPickPlayer'); return }
  try {
    // Convert datetime-local wall clock → ISO UTC string. Empty string = no expiry.
    const expiresAtIso = expiresAtLocal.value
      ? new Date(expiresAtLocal.value).toISOString()
      : null
    await api.addSubscriptionPlanSubscriber(assignToPlanId.value, {
      player_id: selectedPlayer.value.id,
      expires_at: expiresAtIso,
    })
    showAssignModal.value = false
    await loadSubscribers(assignToPlanId.value)
    await load() // refresh active counts
  } catch (e: any) {
    error.value = e.message || 'Failed to assign'
  }
}

async function cancelSubscriber(planId: number, sub: Subscriber) {
  if (!confirm(t('subscriptionPlanCancelConfirm', { name: sub.player_display_name || sub.player_name || `#${sub.player_id}` }))) return
  await api.cancelSubscriptionPlanSubscriber(planId, sub.id)
  await loadSubscribers(planId)
  await load()
}

onMounted(load)
onUnmounted(() => {
  if (playerSearchTimer) clearTimeout(playerSearchTimer)
})
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('adminSubscriptionPlans') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('adminSubscriptionPlansSubtitle') }}</p>
      </div>
      <button class="btn-primary text-sm" @click="openCreate">
        <Plus class="w-4 h-4" />
        {{ t('subscriptionPlanAdd') }}
      </button>
    </div>

    <p v-if="error && !showPlanModal && !showAssignModal" class="text-sm text-destructive">{{ error }}</p>

    <div class="card">
      <div v-if="loading && plans.length === 0" class="px-4 py-12 text-center text-sm text-muted-foreground">
        {{ t('loading') }}
      </div>
      <div v-else-if="plans.length === 0" class="px-4 py-12 text-center text-sm text-muted-foreground">
        {{ t('subscriptionPlanEmpty') }}
      </div>
      <div v-else class="divide-y divide-border">
        <div v-for="plan in sortedPlans" :key="plan.id" class="flex flex-col">
          <div class="px-4 py-3 md:px-6 flex items-center gap-3">
            <img
              v-if="plan.badge_url"
              :src="plan.badge_url"
              class="w-8 h-8 rounded shrink-0 object-cover border border-border"
              :alt="plan.name"
            />
            <Crown v-else class="w-4 h-4 shrink-0" :class="plan.is_active ? 'text-amber-500' : 'text-muted-foreground'" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-3 flex-wrap">
                <span class="text-sm font-semibold text-foreground">{{ plan.name }}</span>
                <span class="text-xs text-muted-foreground font-mono">{{ plan.slug }}</span>
                <span class="text-xs font-mono text-cyan-400">{{ fmtPrice(plan.price_cents, plan.currency) }}</span>
                <span class="text-xs font-mono text-muted-foreground">{{ t('subscriptionPlanSort') }}: {{ plan.sort_order }}</span>
                <span v-if="!plan.is_active" class="text-xs px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground uppercase font-mono">{{ t('subscriptionPlanInactive') }}</span>
                <button
                  class="text-xs px-2 py-0.5 rounded bg-accent/40 text-foreground hover:bg-accent transition-colors font-mono"
                  @click="toggleExpanded(plan.id)"
                >
                  {{ plan.active_subscriber_count }} {{ t('subscriptionPlanSubscribers') }}
                </button>
              </div>
              <p v-if="plan.description" class="text-xs text-muted-foreground mt-1 line-clamp-2">{{ plan.description }}</p>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button class="btn-ghost p-2" :title="plan.is_active ? t('subscriptionPlanDeactivate') : t('subscriptionPlanActivate')" @click="togglePlanActive(plan)">
                <Eye v-if="plan.is_active" class="w-4 h-4 text-green-500" />
                <EyeOff v-else class="w-4 h-4 text-muted-foreground" />
              </button>
              <button class="btn-ghost p-2" :title="t('edit')" @click="openEdit(plan)">
                <Pencil class="w-4 h-4" />
              </button>
              <button class="btn-ghost p-2 text-destructive" :title="t('delete')" @click="deletePlan(plan)">
                <Trash2 class="w-4 h-4" />
              </button>
            </div>
          </div>

          <!-- Expanded: subscribers -->
          <div v-if="expandedPlanId === plan.id" class="px-4 md:px-6 pb-4 border-t border-border/40 bg-accent/5">
            <div class="flex items-center justify-between py-3">
              <h3 class="text-sm font-semibold text-foreground">{{ t('subscriptionPlanSubscribersFor', { name: plan.name }) }}</h3>
              <button class="btn-primary text-xs" @click="openAssign(plan.id)">
                <UserPlus class="w-3.5 h-3.5" />
                {{ t('subscriptionPlanAssignUser') }}
              </button>
            </div>
            <div v-if="subscribersLoading[plan.id]" class="py-4 text-center text-xs text-muted-foreground">{{ t('loading') }}</div>
            <div v-else-if="!subscribersByPlan[plan.id]?.length" class="py-4 text-center text-xs text-muted-foreground">
              {{ t('subscriptionPlanNoSubscribers') }}
            </div>
            <div v-else class="flex flex-col gap-1.5">
              <div
                v-for="sub in subscribersByPlan[plan.id]"
                :key="sub.id"
                class="flex items-center gap-3 px-3 py-2 rounded bg-card border border-border/40"
                :class="sub.status !== 'active' && 'opacity-60'"
              >
                <img v-if="sub.player_avatar_url" :src="sub.player_avatar_url" class="w-7 h-7 rounded-full object-cover" />
                <div v-else class="w-7 h-7 rounded-full bg-accent" />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-semibold truncate">{{ sub.player_display_name || sub.player_name || `#${sub.player_id}` }}</span>
                    <span class="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded"
                          :class="sub.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-muted/40 text-muted-foreground'">
                      {{ sub.status }}
                    </span>
                    <span class="text-[10px] font-mono text-muted-foreground">{{ sub.source }}</span>
                  </div>
                  <div class="text-[11px] text-muted-foreground font-mono mt-0.5">
                    {{ t('subscriptionPlanStartedAt') }}: {{ fmtDate(sub.started_at) }}
                    <span v-if="sub.expires_at"> · {{ t('subscriptionPlanExpiresAt') }}: {{ fmtDate(sub.expires_at) }}</span>
                    <span v-if="sub.cancelled_at"> · {{ t('subscriptionPlanCancelledAt') }}: {{ fmtDate(sub.cancelled_at) }}</span>
                  </div>
                </div>
                <button v-if="sub.status === 'active'" class="btn-ghost p-1.5 text-destructive" :title="t('subscriptionPlanCancel')" @click="cancelSubscriber(plan.id, sub)">
                  <X class="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Plan Add / Edit Modal -->
    <ModalOverlay :show="showPlanModal" @close="showPlanModal = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ editingPlan ? t('subscriptionPlanEdit') : t('subscriptionPlanAdd') }}</h2>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup
          :label="t('subscriptionPlanName')"
          :model-value="planForm.name"
          :placeholder="t('subscriptionPlanNamePlaceholder')"
          @update:model-value="planForm.name = $event"
        />
        <InputGroup
          :label="t('subscriptionPlanSlug')"
          :model-value="planForm.slug"
          :hint="t('subscriptionPlanSlugHint')"
          placeholder="bronze"
          @update:model-value="planForm.slug = $event"
        />
        <InputGroup
          :label="t('subscriptionPlanDescription')"
          :model-value="planForm.description"
          :placeholder="t('subscriptionPlanDescriptionPlaceholder')"
          @update:model-value="planForm.description = $event"
        />
        <div class="grid grid-cols-2 gap-3">
          <InputGroup
            :label="t('subscriptionPlanPriceCents')"
            type="number"
            :model-value="String(planForm.price_cents)"
            :hint="t('subscriptionPlanPriceCentsHint')"
            @update:model-value="planForm.price_cents = Number($event) || 0"
          />
          <InputGroup
            :label="t('subscriptionPlanCurrency')"
            :model-value="planForm.currency"
            placeholder="EUR"
            @update:model-value="planForm.currency = $event"
          />
        </div>
        <InputGroup
          :label="t('subscriptionPlanSort')"
          type="number"
          :model-value="String(planForm.sort_order)"
          :hint="t('subscriptionPlanSortHint')"
          @update:model-value="planForm.sort_order = Number($event) || 0"
        />

        <!-- Badge upload -->
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('subscriptionPlanBadge') }}</label>
          <div class="flex items-center gap-3">
            <div class="w-16 h-16 rounded border border-border bg-accent/20 flex items-center justify-center overflow-hidden shrink-0">
              <img v-if="badgePreviewUrl" :src="badgePreviewUrl" class="w-full h-full object-cover" />
              <Crown v-else class="w-6 h-6 text-muted-foreground" />
            </div>
            <div class="flex flex-col gap-1.5 flex-1">
              <input type="file" accept="image/*" class="text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-primary file:text-[#0A0F1C] file:font-semibold file:cursor-pointer hover:file:brightness-110" @change="onPickBadge" />
              <button v-if="badgePreviewUrl" type="button" class="self-start text-xs text-destructive hover:underline" @click="removeBadge">
                {{ t('subscriptionPlanBadgeRemove') }}
              </button>
            </div>
          </div>
          <p class="text-[11px] text-muted-foreground">{{ t('subscriptionPlanBadgeHint') }}</p>
        </div>

        <!-- Perks -->
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('subscriptionPlanPerks') }}</label>
          <div class="flex flex-col gap-2 rounded border border-border p-3 bg-accent/10">
            <label v-for="opt in PERK_OPTIONS" :key="opt.key" class="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" class="mt-0.5 w-4 h-4 accent-primary" v-model="planForm.perks[opt.key]" />
              <div class="flex flex-col">
                <span class="text-sm text-foreground font-medium">{{ t(opt.labelKey) }}</span>
                <span class="text-[11px] text-muted-foreground">{{ t(opt.descKey) }}</span>
              </div>
            </label>
          </div>
        </div>

        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="w-4 h-4 accent-primary" v-model="planForm.is_active" />
          <span class="text-sm text-foreground">{{ t('subscriptionPlanActive') }}</span>
        </label>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="savePlan">
          {{ editingPlan ? t('save') : t('subscriptionPlanAdd') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showPlanModal = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Assign Subscriber Modal -->
    <ModalOverlay :show="showAssignModal" @close="showAssignModal = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('subscriptionPlanAssignUser') }}</h2>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <div class="flex flex-col gap-1.5 relative">
          <label class="label-text">{{ t('subscriptionPlanPickPlayer') }}</label>
          <div class="relative">
            <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              v-model="playerQuery"
              type="text"
              class="input-field pl-8 w-full"
              :placeholder="t('searchPlayers')"
              @focus="selectedPlayer = null"
            />
          </div>
          <div v-if="playerResults.length > 0 && !selectedPlayer" class="absolute z-10 left-0 right-0 top-full mt-1 max-h-60 overflow-y-auto rounded border border-border bg-card shadow-lg">
            <button
              v-for="p in playerResults" :key="p.id"
              type="button"
              class="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
              @click="selectPlayer(p)"
            >
              <img v-if="p.avatar_url" :src="p.avatar_url" class="w-6 h-6 rounded-full object-cover" />
              <div v-else class="w-6 h-6 rounded-full bg-accent" />
              <span class="text-sm truncate">{{ p.display_name || p.name }}</span>
              <BadgeCheck v-if="p.steam_id" class="w-3 h-3 text-cyan-400 shrink-0" />
            </button>
          </div>
          <p v-if="playerSearching" class="text-[11px] text-muted-foreground">{{ t('loading') }}</p>
        </div>

        <div v-if="selectedPlayer" class="flex items-center gap-2.5 px-3 py-2 rounded bg-emerald-500/10 border border-emerald-500/30">
          <img v-if="selectedPlayer.avatar_url" :src="selectedPlayer.avatar_url" class="w-6 h-6 rounded-full object-cover" />
          <div v-else class="w-6 h-6 rounded-full bg-accent" />
          <span class="text-sm font-semibold flex-1 truncate">{{ selectedPlayer.display_name || selectedPlayer.name }}</span>
          <button class="btn-ghost p-1" @click="selectedPlayer = null"><X class="w-3.5 h-3.5" /></button>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('subscriptionPlanExpiresAt') }}</label>
          <input v-model="expiresAtLocal" type="datetime-local" class="input-field" />
          <p class="text-[11px] text-muted-foreground">{{ t('subscriptionPlanExpiresAtHint') }}</p>
        </div>

        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="!selectedPlayer" @click="assignSubscriber">
          <UserPlus class="w-4 h-4" />
          {{ t('subscriptionPlanAssignUser') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showAssignModal = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>
  </div>
</template>
