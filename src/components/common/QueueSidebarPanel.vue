<script setup lang="ts">
import { computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Swords, X, Play, Loader2, LogOut, Users, Star } from 'lucide-vue-next'
import { useQueueStore } from '@/composables/useQueueStore'
import { useSidePanels } from '@/composables/useSidePanels'
import { useDraftStore } from '@/composables/useDraftStore'
import { getSocket } from '@/composables/useSocket'

const { t } = useI18n()
const router = useRouter()
const queue = useQueueStore()
const panels = useSidePanels()
const store = useDraftStore()

const isLoggedIn = computed(() => !!store.currentUser.value)

// Featured = the pool with is_featured=true; fall back to the first enabled
// pool so newly-seeded DBs work without an admin flipping anything.
const featuredPool = computed(() => {
  const enabled = queue.pools.value.filter(p => p.enabled)
  return enabled.find(p => p.is_featured) || enabled[0] || null
})

const featuredPlayers = computed(() => {
  if (!featuredPool.value) return [] as typeof queue.queuePlayers.value
  if (queue.currentPoolId.value === featuredPool.value.id) return queue.queuePlayers.value
  return []
})

const featuredCount = computed(() => {
  if (!featuredPool.value) return 0
  const cnt = (queue.poolCounts.value as any)?.[featuredPool.value.id]
  return typeof cnt === 'number' ? cnt : featuredPlayers.value.length
})

// While the panel is open, watch the featured pool so its player list keeps
// flowing in over the socket. Skip if the user is already queuing somewhere
// else — leaving their current pool's room would lose their state.
function watchFeatured() {
  const p = featuredPool.value
  if (!p) return
  if (queue.inQueue.value && queue.currentPoolId.value !== p.id) return
  queue.currentPoolId.value = p.id
  queue.currentPoolName.value = p.name
  getSocket().emit('queue:getState', { poolId: p.id })
}

watch(() => panels.active.value, (a) => {
  if (a === 'queue') watchFeatured()
})

watch(featuredPool, (p) => {
  if (panels.active.value === 'queue' && p) watchFeatured()
})

onMounted(() => {
  if (queue.pools.value.length === 0) queue.fetchPools().then(() => {
    if (panels.active.value === 'queue') watchFeatured()
  })
})

function join() {
  if (featuredPool.value) queue.joinQueue(featuredPool.value.id)
}

function leave() {
  queue.leaveQueue()
}

function openQueuePage() {
  router.push('/queue')
  panels.close()
}

function goToProfile(playerId: number) {
  router.push({ name: 'player-profile', params: { id: playerId } })
  panels.close()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="slide-right">
      <aside
        v-if="panels.active.value === 'queue'"
        class="fixed top-0 bottom-0 w-[320px] z-50 flex flex-col shadow-[0_0_60px_0_rgba(0,0,0,0.8)] md:right-[70px] right-0"
        style="background:#0F172A;border-left:1px solid #22D3EE;border-right:1px solid #1E293B"
      >
        <!-- Header -->
        <div
          class="flex items-center justify-between h-[54px] px-[18px] shrink-0"
          style="background:#0A0F1C;border-bottom:1px solid #1E293B"
        >
          <div class="flex items-center gap-2">
            <Swords class="w-[15px] h-[15px]" style="color:#22D3EE" />
            <span class="text-[15px] font-extrabold" style="color:#F1F5F9">
              {{ t('findMatch') }}
            </span>
          </div>
          <button
            class="w-[26px] h-[26px] rounded-md flex items-center justify-center transition-colors hover:opacity-80"
            style="background:#1E293B"
            :title="t('close')"
            @click="panels.close()"
          >
            <X class="w-[13px] h-[13px]" style="color:#94A3B8" />
          </button>
        </div>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto">
          <!-- Not logged in -->
          <div v-if="!isLoggedIn" class="px-6 py-12 text-center text-[12px]" style="color:#475569">
            {{ t('loginToQueue') }}
          </div>

          <!-- No featured pool -->
          <div v-else-if="!featuredPool" class="px-6 py-12 text-center text-[12px]" style="color:#475569">
            {{ t('noQueuePoolsAvailable') }}
          </div>

          <template v-else>
            <!-- Featured pool card -->
            <div class="p-4">
              <div
                class="rounded-lg p-4 flex flex-col gap-3"
                :style="queue.inQueue.value
                  ? 'background:#0A0F1C;box-shadow:inset 0 0 0 1px rgba(34,211,238,0.45)'
                  : 'background:#0A0F1C;box-shadow:inset 0 0 0 1px #1E293B'"
              >
                <div class="flex items-center gap-2">
                  <Star class="w-3.5 h-3.5" style="color:#FACC15" fill="#FACC15" />
                  <span class="text-[10px] font-extrabold tracking-[1.2px]" style="color:#FACC15">
                    {{ t('featured').toUpperCase() }}
                  </span>
                  <span class="flex-1 text-right text-[10px] font-mono" style="color:#64748B">
                    {{ featuredPool.min_mmr }} – {{ featuredPool.max_mmr }} MMR · Bo{{ featuredPool.best_of }}
                  </span>
                </div>
                <div class="text-[15px] font-extrabold" style="color:#F1F5F9">
                  {{ featuredPool.name }}
                </div>
                <!-- CTA -->
                <button
                  v-if="!queue.inQueue.value"
                  class="flex items-center justify-center gap-2 rounded-md px-4 py-3 text-[14px] font-extrabold transition-transform hover:scale-[1.02]"
                  style="background:#22D3EE;color:#0A0F1C;box-shadow:0 0 18px rgba(34,211,238,0.35)"
                  @click="join"
                >
                  <Play class="w-4 h-4" style="color:#0A0F1C" fill="#0A0F1C" />
                  {{ t('joinQueue') }}
                </button>
                <button
                  v-else
                  class="flex items-center justify-center gap-2 rounded-md px-4 py-3 text-[13px] font-extrabold transition-colors"
                  style="background:#1E293B;color:#FCA5A5"
                  @click="leave"
                >
                  <LogOut class="w-4 h-4" />
                  {{ t('leaveQueue') }}
                </button>
                <div v-if="queue.inQueue.value" class="flex items-center justify-center gap-2 text-[12px]" style="color:#22D3EE">
                  <Loader2 class="w-3.5 h-3.5 animate-spin" />
                  {{ t('searching') }}
                </div>
              </div>
            </div>

            <!-- Players in queue -->
            <div class="px-[10px] pb-3 flex flex-col gap-0.5">
              <div class="flex items-center gap-1.5 px-2 py-1">
                <Users class="w-3 h-3" style="color:#22D3EE" />
                <span class="text-[10px] font-extrabold tracking-[1.2px]" style="color:#22D3EE">
                  {{ t('inQueue').toUpperCase() }} — {{ featuredCount }}
                </span>
              </div>
              <div
                v-if="featuredPlayers.length === 0"
                class="px-3 py-6 text-center text-[12px]"
                style="color:#475569"
              >
                {{ t('queueIsEmpty') }}
              </div>
              <button
                v-for="p in featuredPlayers"
                :key="p.playerId"
                class="flex items-center gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-white/5"
                @click="goToProfile(p.playerId)"
              >
                <img
                  v-if="p.avatarUrl"
                  :src="p.avatarUrl"
                  class="w-8 h-8 rounded-full object-cover shrink-0"
                />
                <div
                  v-else
                  class="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                  style="background:#1E293B"
                >
                  <span class="text-white text-[12px] font-extrabold">{{ (p.name || '?').charAt(0).toUpperCase() }}</span>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-[12px] font-bold truncate" style="color:#F1F5F9">{{ p.name }}</div>
                  <div class="text-[10px] font-mono" style="color:#64748B">{{ p.mmr }} MMR</div>
                </div>
              </button>
            </div>

            <!-- Deep-link to the full queue page for the pick phase, etc. -->
            <div class="px-4 pb-4 text-center">
              <button
                class="text-[11px] font-semibold underline transition-opacity hover:opacity-80"
                style="color:#22D3EE"
                @click="openQueuePage"
              >
                {{ t('openFullQueue') }}
              </button>
            </div>
          </template>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 220ms ease;
}
.slide-right-enter-from,
.slide-right-leave-to {
  transform: translateX(100%);
}
</style>
