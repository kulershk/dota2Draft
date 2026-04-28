<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Frown, Home, ArrowLeft } from 'lucide-vue-next'

const { t } = useI18n()
const route = useRoute()
const requestedPath = computed(() => route.fullPath)

function goBack() {
  if (window.history.length > 1) window.history.back()
  else window.location.href = '/'
}
</script>

<template>
  <div class="flex flex-1 items-center justify-center px-4 py-16">
    <div class="card max-w-lg w-full p-8 md:p-10 text-center flex flex-col items-center gap-5">
      <div class="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center">
        <Frown class="w-8 h-8 text-primary" />
      </div>

      <div>
        <p class="text-[11px] font-bold font-mono uppercase tracking-[3px] text-muted-foreground">404</p>
        <h1 class="text-2xl md:text-3xl font-extrabold text-foreground mt-2">{{ t('notFoundTitle') }}</h1>
        <p class="text-sm text-muted-foreground mt-2">{{ t('notFoundDesc') }}</p>
      </div>

      <div class="w-full bg-muted/40 border border-border rounded-md px-3 py-2 font-mono text-xs text-muted-foreground truncate">
        {{ requestedPath }}
      </div>

      <div class="flex flex-col sm:flex-row gap-2 w-full">
        <button class="btn-secondary flex items-center justify-center gap-1.5 flex-1" @click="goBack">
          <ArrowLeft class="w-4 h-4" />
          {{ t('notFoundGoBack') }}
        </button>
        <router-link to="/" class="btn-primary flex items-center justify-center gap-1.5 flex-1">
          <Home class="w-4 h-4" />
          {{ t('notFoundGoHome') }}
        </router-link>
      </div>
    </div>
  </div>
</template>
