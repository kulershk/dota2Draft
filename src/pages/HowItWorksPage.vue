<script setup lang="ts">
import { Info, Gavel, ListOrdered } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 max-w-[900px] mx-auto w-full">
    <div class="mb-6">
      <h1 class="text-2xl font-semibold text-foreground">{{ t('howItWorksTitle') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('howItWorksSubtitle') }}</p>
    </div>

    <!-- Bidding Types -->
    <div class="card mb-6">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Gavel class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('howItWorks.biddingTypesTitle') }}</span>
      </div>
      <div class="px-4 py-5 md:px-6 flex flex-col gap-5">
        <div class="pl-6 border-l-2 border-primary/30">
          <h3 class="text-sm font-semibold text-foreground">{{ t('biddingTypeDefault') }}</h3>
          <p class="text-sm text-muted-foreground mt-1.5 leading-relaxed">{{ t('howItWorks.defaultDesc') }}</p>
        </div>
        <div class="pl-6 border-l-2 border-primary/30">
          <h3 class="text-sm font-semibold text-foreground">{{ t('biddingTypeBlind') }}</h3>
          <p class="text-sm text-muted-foreground mt-1.5 leading-relaxed">{{ t('howItWorks.blindDesc') }}</p>
        </div>
      </div>
    </div>

    <!-- Nomination Orders -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <ListOrdered class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('howItWorks.nominationOrderTitle') }}</span>
      </div>
      <div class="px-4 py-5 md:px-6 flex flex-col gap-5">
        <div class="pl-6 border-l-2 border-primary/30">
          <h3 class="text-sm font-semibold text-foreground">{{ t('normalRoundRobin') }}</h3>
          <p class="text-sm text-muted-foreground mt-1.5 leading-relaxed">{{ t('howItWorks.normalDesc') }}</p>
        </div>
        <div class="pl-6 border-l-2 border-primary/30">
          <h3 class="text-sm font-semibold text-foreground">{{ t('lowestAvgFirst') }}</h3>
          <p class="text-sm text-muted-foreground mt-1.5 leading-relaxed">{{ t('howItWorks.lowestAvgDesc') }}</p>
        </div>
        <div class="pl-6 border-l-2 border-primary/30">
          <h3 class="text-sm font-semibold text-foreground">{{ t('fewestThenLowest') }}</h3>
          <p class="text-sm text-muted-foreground mt-1.5 leading-relaxed">{{ t('howItWorks.fewestThenLowestDesc') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
