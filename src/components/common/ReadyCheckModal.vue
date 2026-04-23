<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Swords, Check, X } from 'lucide-vue-next'
import { useQueueStore } from '@/composables/useQueueStore'
import { getServerNow } from '@/composables/useSocket'

const { t } = useI18n()
const queue = useQueueStore()

const now = ref(getServerNow())
let tickInterval: ReturnType<typeof setInterval> | null = null

const acceptTimeLeft = computed(() => {
  const rc = queue.readyCheck.value
  if (!rc) return 0
  return Math.max(0, rc.acceptTimerEnd - now.value)
})
const acceptTimerPercent = computed(() => {
  const rc = queue.readyCheck.value
  if (!rc) return 0
  const total = rc.acceptTimerSeconds * 1000
  return Math.min(100, (acceptTimeLeft.value / total) * 100)
})

const readySound = new Audio('/sounds/ready.wav')
readySound.preload = 'auto'
watch(() => queue.readyCheck.value, (rc, prev) => {
  if (rc && !prev) {
    readySound.currentTime = 0
    readySound.play().catch(() => {})
  }
})

onMounted(() => {
  tickInterval = setInterval(() => { now.value = getServerNow() }, 200)
})
onUnmounted(() => {
  if (tickInterval) clearInterval(tickInterval)
})
</script>

<template>
  <div
    v-if="queue.readyCheck.value"
    class="fixed inset-0 z-[100] bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
  >
    <div class="card w-full max-w-md overflow-hidden">
      <div class="h-1 bg-primary" />
      <div class="px-6 py-6 text-center">
        <div class="w-14 h-14 rounded-full bg-primary/15 flex items-center justify-center mx-auto mb-3">
          <Swords class="w-7 h-7 text-primary" />
        </div>
        <h2 class="text-xl font-bold mb-1">{{ t('queueMatchFound') }}</h2>
        <p class="text-sm text-muted-foreground mb-4">
          {{ t('queueWaitingForAccepts', { n: queue.readyCheck.value.acceptedIds.length, total: queue.readyCheck.value.expectedCount }) }}
        </p>

        <div class="h-1.5 bg-accent rounded-full overflow-hidden mb-1">
          <div class="h-full bg-primary transition-[width] duration-200" :style="{ width: acceptTimerPercent + '%' }" />
        </div>
        <div class="text-xs text-muted-foreground font-mono mb-5">
          {{ Math.ceil(acceptTimeLeft / 1000) }}s
        </div>

        <div class="flex justify-center gap-1.5 mb-5 flex-wrap">
          <div
            v-for="p in queue.readyCheck.value.players"
            :key="p.playerId"
            class="w-8 h-8 rounded-full border-2 flex items-center justify-center overflow-hidden"
            :class="queue.readyCheck.value.acceptedIds.includes(p.playerId)
              ? 'border-green-500'
              : queue.readyCheck.value.declinedIds.includes(p.playerId)
                ? 'border-destructive opacity-50'
                : 'border-border'"
            :title="p.name"
          >
            <img v-if="p.avatarUrl" :src="p.avatarUrl" class="w-full h-full object-cover" />
            <span v-else class="text-[10px]">{{ p.name.charAt(0).toUpperCase() }}</span>
          </div>
        </div>

        <div v-if="queue.readyCheck.value.myStatus === 'pending'" class="flex gap-2">
          <button class="flex-1 btn-outline px-4 py-2.5" @click="queue.declineReadyCheck()">
            <X class="w-4 h-4 inline-block mr-1" /> {{ t('queueDecline') }}
          </button>
          <button class="flex-1 btn-primary px-4 py-2.5 font-bold" @click="queue.acceptReadyCheck()">
            <Check class="w-4 h-4 inline-block mr-1" /> {{ t('queueAccept') }}
          </button>
        </div>
        <div v-else-if="queue.readyCheck.value.myStatus === 'accepted'" class="text-sm text-green-500 font-semibold py-2">
          <Check class="w-4 h-4 inline-block mr-1" />
          {{ t('queueAccepted') }}
        </div>
        <div v-else class="text-sm text-destructive font-semibold py-2">
          <X class="w-4 h-4 inline-block mr-1" />
          {{ t('queueDeclined') }}
        </div>
      </div>
    </div>
  </div>
</template>
