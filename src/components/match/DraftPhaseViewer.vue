<script setup lang="ts">
import { useI18n } from 'vue-i18n'

interface PickBan {
  order: number
  hero_id: number
  is_pick: boolean
  team: number  // 0 or 1 (radiant/dire respectively)
}

interface Phase {
  type: string
  label: string
  items: PickBan[]
}

interface Props {
  phases: Phase[]
  dota: any
}

defineProps<Props>()
const { t } = useI18n()
</script>

<template>
  <div v-if="phases.length" class="mt-3">
    <p class="text-sm font-bold text-foreground mb-2">{{ t('draft') || 'Draft' }}</p>
    <div class="flex flex-wrap gap-2">
      <div v-for="phase in phases" :key="phase.label" class="rounded-lg bg-surface/80 px-3 py-2">
        <span class="text-[10px] font-medium text-muted-foreground mb-1.5 block">{{ phase.label }}</span>
        <div v-for="teamSide in [1, 0]" :key="teamSide" class="flex items-center gap-0.5 mb-0.5">
          <template v-for="pb in phase.items.filter((p) => p.team === teamSide)" :key="pb.order">
            <div class="relative overflow-hidden rounded-sm" :title="dota.heroName(pb.hero_id)" style="width: 44px; height: 24px;">
              <img v-if="dota.heroImg(pb.hero_id)" :src="dota.heroImg(pb.hero_id)"
                   class="w-full h-full object-cover" :class="!pb.is_pick ? 'opacity-40' : ''" />
              <svg v-if="!pb.is_pick" class="absolute inset-0 w-full h-full" viewBox="0 0 44 24" preserveAspectRatio="none">
                <line x1="0" y1="0" x2="44" y2="24" stroke="rgb(239 68 68)" stroke-width="2.5" />
              </svg>
            </div>
            <span class="text-[10px] font-mono font-bold text-muted-foreground mr-1.5">{{ pb.order + 1 }}</span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
