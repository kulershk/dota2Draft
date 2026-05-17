<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Swords, X, Play, Loader2, LogOut, Users } from 'lucide-vue-next'
import { useQueueStore } from '@/composables/useQueueStore'
import { useSidePanels } from '@/composables/useSidePanels'
import { useDraftStore } from '@/composables/useDraftStore'

const { t } = useI18n()
const router = useRouter()
const queue = useQueueStore()
const panels = useSidePanels()
const store = useDraftStore()

const visiblePools = computed(() => queue.pools.value.filter(p => p.enabled))

const isLoggedIn = computed(() => !!store.currentUser.value)

function poolCount(poolId: number): number {
  return (queue.poolCounts.value as any)?.[poolId] ?? 0
}

function join(poolId: number) {
  queue.joinQueue(poolId)
}

function leave() {
  queue.leaveQueue()
}

function openQueuePage() {
  router.push('/queue')
  panels.close()
}

onMounted(() => {
  if (queue.pools.value.length === 0) queue.fetchPools()
})
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

          <!-- Currently queuing -->
          <div v-else-if="queue.inQueue.value" class="p-4 flex flex-col gap-4">
            <div
              class="rounded-lg p-4 flex flex-col items-center gap-2"
              style="background:#0A0F1C;box-shadow:inset 0 0 0 1px rgba(34,211,238,0.3)"
            >
              <Loader2 class="w-6 h-6 animate-spin" style="color:#22D3EE" />
              <div class="text-[13px] font-bold" style="color:#F1F5F9">{{ t('searching') }}</div>
              <div class="text-[11px]" style="color:#94A3B8">{{ queue.currentPoolName.value }}</div>
              <div class="flex items-center gap-1.5 mt-1">
                <Users class="w-3.5 h-3.5" style="color:#22D3EE" />
                <span class="text-[12px] font-mono font-bold" style="color:#22D3EE">{{ queue.queueCount.value }}</span>
              </div>
            </div>
            <button
              class="flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-[13px] font-extrabold transition-colors"
              style="background:#1E293B;color:#FCA5A5"
              @click="leave"
            >
              <LogOut class="w-4 h-4" />
              {{ t('leaveQueue') }}
            </button>
            <button
              class="text-[11px] font-semibold underline transition-colors hover:opacity-80"
              style="color:#22D3EE"
              @click="openQueuePage"
            >
              {{ t('openFullQueue') }}
            </button>
          </div>

          <!-- Pool list -->
          <div v-else class="p-3 flex flex-col gap-2">
            <div
              v-if="visiblePools.length === 0"
              class="px-3 py-12 text-center text-[12px]"
              style="color:#475569"
            >
              {{ t('noQueuePoolsAvailable') }}
            </div>
            <button
              v-for="pool in visiblePools"
              :key="pool.id"
              class="flex items-center gap-3 rounded-lg p-3 transition-colors hover:bg-white/5 text-left"
              style="background:#0A0F1C;box-shadow:inset 0 0 0 1px #1E293B"
              @click="join(pool.id)"
            >
              <div
                class="w-10 h-10 rounded-md flex items-center justify-center shrink-0"
                style="background:linear-gradient(135deg,#22D3EE,#0EA5E9)"
              >
                <Play class="w-5 h-5" style="color:#0A0F1C" fill="#0A0F1C" />
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-[13px] font-bold truncate" style="color:#F1F5F9">{{ pool.name }}</div>
                <div class="text-[10px] font-mono mt-0.5" style="color:#64748B">
                  {{ pool.min_mmr }} – {{ pool.max_mmr }} MMR · Bo{{ pool.best_of }}
                </div>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <Users class="w-3 h-3" style="color:#64748B" />
                <span class="text-[11px] font-mono font-bold" style="color:#94A3B8">{{ poolCount(pool.id) }}</span>
              </div>
            </button>
          </div>
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
