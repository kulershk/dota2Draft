<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { Loader2, Swords, X, Users } from 'lucide-vue-next'
import { useQueueStore } from '@/composables/useQueueStore'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const queue = useQueueStore()

// Show when: in queue or in an active match (pick/lobby) AND not already on the queue page.
const onQueuePage = computed(() => route.path === '/queue')
const visible = computed(() => {
  if (onQueuePage.value) return false
  return queue.inQueue.value || !!queue.activeMatch.value
})

const inMatch = computed(() => !!queue.activeMatch.value)
const totalPlayers = computed(() => {
  const pool = queue.pools.value.find(p => p.id === queue.currentPoolId.value)
  const teamSize = (pool as any)?.team_size || 5
  return teamSize * 2
})

function openQueuePage() {
  router.push('/queue')
}

function leave() {
  queue.leaveQueue()
}
</script>

<template>
  <div v-if="visible"
    class="fixed bottom-4 right-4 z-50 w-72 card overflow-hidden shadow-xl shadow-black/30 border border-primary/30">
    <!-- Match found state -->
    <template v-if="inMatch">
      <div class="h-1 bg-primary animate-pulse" />
      <button class="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-accent/40 transition-colors" @click="openQueuePage">
        <div class="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
          <Swords class="w-4.5 h-4.5 text-primary" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-bold text-foreground">{{ t('queueMatchFoundShort') }}</div>
          <div class="text-[11px] text-muted-foreground truncate">{{ t('queueClickToOpen') }}</div>
        </div>
      </button>
    </template>

    <!-- In queue state -->
    <template v-else>
      <div class="h-1 bg-primary/60" />
      <div class="px-4 py-3 flex items-center gap-3">
        <Loader2 class="w-4 h-4 text-primary animate-spin shrink-0" />
        <div class="flex-1 min-w-0">
          <div class="text-sm font-semibold text-foreground truncate">
            {{ t('queueSearching') }}
            <span v-if="queue.currentPoolName.value" class="text-muted-foreground font-normal">— {{ queue.currentPoolName.value }}</span>
          </div>
          <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5">
            <Users class="w-3 h-3" />
            <span class="font-mono tabular-nums">{{ queue.queueCount.value }}/{{ totalPlayers }}</span>
          </div>
        </div>
        <button
          class="p-1.5 rounded-md hover:bg-destructive/15 text-muted-foreground hover:text-destructive transition-colors"
          :title="t('queueLeave')"
          @click="leave"
        >
          <X class="w-4 h-4" />
        </button>
      </div>
      <button class="w-full px-4 py-2 text-[11px] text-primary hover:bg-primary/10 border-t border-border/30 transition-colors" @click="openQueuePage">
        {{ t('queueOpenPage') }}
      </button>
    </template>
  </div>
</template>
