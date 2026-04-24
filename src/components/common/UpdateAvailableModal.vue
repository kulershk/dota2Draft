<script setup lang="ts">
import { RefreshCw } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useAppVersion } from '@/composables/useAppVersion'

const { t } = useI18n()
const { updateAvailable } = useAppVersion()

function refresh() {
  window.location.reload()
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="updateAvailable" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60">
        <div class="relative w-full max-w-[440px] mx-4 bg-card rounded-xl border border-border shadow-xl p-6 flex flex-col items-center text-center gap-4">
          <div class="w-14 h-14 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
            <RefreshCw class="w-7 h-7 text-primary" />
          </div>
          <h2 class="text-lg font-bold text-foreground">{{ t('versionUpdateTitle') }}</h2>
          <p class="text-sm text-muted-foreground">{{ t('versionUpdateDesc') }}</p>
          <button
            class="mt-2 inline-flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors"
            @click="refresh"
          >
            <RefreshCw class="w-4 h-4" />
            {{ t('versionUpdateRefresh') }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
