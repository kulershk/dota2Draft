<script setup lang="ts">
import { Info } from 'lucide-vue-next'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDraftStore } from '@/composables/useDraftStore'

const { t } = useI18n()
const store = useDraftStore()
const comp = computed(() => store.currentCompetition.value)
</script>

<template>
  <div class="max-w-[1200px] mx-auto w-full px-6 md:px-12 py-8">
    <div v-if="!comp" class="text-center py-12 text-muted-foreground">{{ t('loading') }}</div>
    <template v-else>
      <div v-if="comp.rules_content" class="rounded-lg bg-card p-6 md:p-8 flex flex-col gap-5">
        <div class="flex items-center gap-2">
          <Info class="w-[18px] h-[18px] text-primary" />
          <span class="text-xl font-semibold text-foreground">{{ comp.rules_title || t('rules') || 'Rules' }}</span>
        </div>
        <div class="prose prose-sm dark:prose-invert max-w-none text-muted-foreground leading-relaxed" v-safe-html="comp.rules_content"></div>
      </div>
      <div v-else class="text-center py-12 text-muted-foreground">
        {{ t('noRulesYet') || 'No rules have been added yet.' }}
      </div>
    </template>
  </div>
</template>
