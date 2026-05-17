<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { Swords } from 'lucide-vue-next'
import { useQueueStore } from '@/composables/useQueueStore'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const queue = useQueueStore()

// Only the "match found" CTA lives here. The "searching" state is owned by
// the right-rail PLAY button (pulsing cyan) + the Queue side panel.
const onQueuePage = computed(() => route.path === '/queue')
const visible = computed(() => !onQueuePage.value && !!queue.activeMatch.value)

function openQueuePage() {
  router.push('/queue')
}
</script>

<template>
  <div
    v-if="visible"
    class="fixed bottom-4 right-4 z-50 w-72 card overflow-hidden shadow-xl shadow-black/30 border border-primary/30"
  >
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
  </div>
</template>
