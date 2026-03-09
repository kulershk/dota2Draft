<script setup lang="ts">
import { Users, Gavel, Trophy, Info, Swords } from 'lucide-vue-next'
import { useRoute, useRouter } from 'vue-router'
import { watch, onMounted, computed } from 'vue'
import { useDraftStore } from '@/composables/useDraftStore'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const route = useRoute()
const store = useDraftStore()

const compId = computed(() => Number(route.params.compId))

const navItems = computed(() => [
  { label: t('navInfo'), icon: Info, name: 'comp-info' },
  { label: t('navParticipants'), icon: Users, name: 'comp-players' },
  { label: t('navLiveAuction'), icon: Gavel, name: 'comp-auction' },
  { label: t('navTeams'), icon: Trophy, name: 'comp-results' },
  { label: t('navTournament'), icon: Swords, name: 'comp-tournament' },
])

async function enterCompetition(id: number) {
  await store.joinCompetition(id)
  await store.fetchCompData()
}

onMounted(() => {
  if (compId.value) enterCompetition(compId.value)
})

watch(compId, (newId) => {
  if (newId) enterCompetition(newId)
})
</script>

<template>
  <div class="flex flex-col flex-1 overflow-hidden">
    <!-- Competition sub-nav -->
    <div class="border-b border-border bg-accent/30">
      <div class="max-w-[1440px] mx-auto w-full flex items-center gap-1 px-4 py-1.5 overflow-x-auto">
        <span v-if="store.currentCompetition.value" class="text-sm font-semibold text-foreground mr-3 whitespace-nowrap">
          {{ store.currentCompetition.value.name }}
        </span>
        <router-link
          v-for="item in navItems"
          :key="item.name"
          :to="{ name: item.name, params: { compId: compId } }"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors whitespace-nowrap"
          :class="route.name === item.name
            ? 'bg-primary text-primary-foreground font-medium'
            : 'text-muted-foreground hover:bg-accent'"
        >
          <component :is="item.icon" class="w-3.5 h-3.5" />
          {{ item.label }}
        </router-link>
      </div>
    </div>
    <div class="flex-1 overflow-y-auto">
      <router-view />
    </div>
  </div>
</template>
