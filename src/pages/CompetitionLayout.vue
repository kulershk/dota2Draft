<script setup lang="ts">
import { Users, Gavel, Trophy, Info, Swords, Star, BookOpen, ListChecks } from 'lucide-vue-next'
import AppFooter from '@/components/common/AppFooter.vue'
import { useRoute, useRouter } from 'vue-router'
import { watch, onMounted, computed } from 'vue'
import { useDraftStore } from '@/composables/useDraftStore'
import { useI18n } from 'vue-i18n'
import { AUCTION_STATUS } from '@/utils/constants'

const { t } = useI18n()
const route = useRoute()
const store = useDraftStore()

const compId = computed(() => Number(route.params.compId))

const navItems = computed(() => [
  { label: t('navInfo'), icon: Info, name: 'comp-info' },
  { label: t('navParticipants'), icon: Users, name: 'comp-players' },
  ...(store.auction.status !== AUCTION_STATUS.FINISHED ? [{ label: t('navLiveAuction'), icon: Gavel, name: 'comp-auction' }] : []),
  { label: t('navTeams'), icon: Trophy, name: 'comp-results' },
  { label: t('navTournament'), icon: Swords, name: 'comp-tournament' },
  { label: t('navMatches'), icon: ListChecks, name: 'comp-matches' },
  ...(store.settings.fantasyEnabled ? [{ label: t('navFantasy'), icon: Star, name: 'comp-fantasy' }] : []),
  ...(store.currentCompetition.value?.rules_content ? [{ label: t('rules') || 'Rules', icon: BookOpen, name: 'comp-rules' }] : []),
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
    <!-- Tab Bar -->
    <div class="bg-muted">
      <div class="max-w-[1200px] mx-auto w-full px-6 md:px-12 flex items-center overflow-x-auto">
        <router-link
          v-for="item in navItems"
          :key="item.name"
          :to="{ name: item.name, params: { compId: compId } }"
          class="flex items-center gap-1.5 px-6 py-3.5 text-sm transition-colors whitespace-nowrap border-b-2"
          :class="route.name === item.name
            ? 'text-primary font-semibold border-primary'
            : 'text-text-tertiary border-transparent hover:text-foreground'"
        >
          <component :is="item.icon" class="w-3.5 h-3.5" />
          {{ item.label }}
        </router-link>
      </div>
    </div>

    <!-- Divider -->
    <div class="h-px bg-border" />

    <!-- Page Content -->
    <div class="flex-1 overflow-y-auto flex flex-col">
      <router-view class="flex-1" />
      <AppFooter />
    </div>
  </div>
</template>
