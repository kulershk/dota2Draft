<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, Clock, Shield, Medal, Swords, Users } from 'lucide-vue-next'

interface SidePerson {
  id: number
  name: string
  type: 'player' | 'team'
  mmr?: number
  points?: number
  imageUrl?: string | null
}

interface Props {
  back?: { onClick?: () => void; label: string; subtitle?: string | null } | null
  matchId: number | string
  matchIdPrefix?: string
  status: string
  statusLabel: string
  season?: { name: string; slug: string } | null
  tournament?: { name: string; to?: any } | null
  playerCount?: number | null
  gameCount?: number | null
  left: SidePerson
  right: SidePerson
  scoreLeft: number
  scoreRight: number
  leftWon?: boolean
  rightWon?: boolean
  hasPoints?: boolean
  leftLabel?: string
  rightLabel?: string
}

const props = defineProps<Props>()
const { t } = useI18n()

function statusColor(status: string) {
  switch (status) {
    case 'completed': return 'bg-green-500/10 text-green-500'
    case 'live':
    case 'in_progress':
    case 'active': return 'bg-amber-500/10 text-amber-500'
    case 'picking': return 'bg-blue-500/10 text-blue-500'
    case 'cancelled': return 'bg-destructive/10 text-destructive'
    default: return 'bg-accent text-muted-foreground'
  }
}

function sideHref(side: SidePerson) {
  return side.type === 'team'
    ? { name: 'team-profile', params: { id: side.id } }
    : { name: 'player-profile', params: { id: side.id } }
}

const leftLabelText = computed(() => props.leftLabel || t('queueRadiant').toUpperCase())
const rightLabelText = computed(() => props.rightLabel || t('queueDire').toUpperCase())
</script>

<template>
  <div>
    <!-- Breadcrumb / back -->
    <button
      v-if="back"
      class="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
      @click="back.onClick?.()"
    >
      <ArrowLeft class="w-3.5 h-3.5 text-primary" />
      <span class="text-primary font-semibold">{{ back.label }}</span>
      <span v-if="back.subtitle" class="text-muted-foreground">·</span>
      <span v-if="back.subtitle" class="text-muted-foreground">{{ back.subtitle }}</span>
    </button>

    <!-- Hero card -->
    <div class="card p-7 flex flex-col gap-6">
      <!-- Tournament name (above the title row) -->
      <router-link
        v-if="tournament && tournament.to"
        :to="tournament.to"
        class="-mb-3 text-lg font-bold text-foreground hover:text-primary transition-colors"
      >
        {{ tournament.name }}
      </router-link>
      <span v-else-if="tournament" class="-mb-3 text-lg font-bold text-foreground">{{ tournament.name }}</span>

      <!-- Meta row -->
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div class="flex items-center gap-3">
          <Swords class="w-5 h-5 text-primary" />
          <h1 class="text-lg font-bold">{{ matchIdPrefix || '#' }}{{ matchId }}</h1>
          <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded" :class="statusColor(status)">
            {{ statusLabel }}
          </span>
          <router-link
            v-if="season"
            :to="{ name: 'season-leaderboard', params: { slug: season.slug } }"
            class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[11px] font-bold hover:bg-amber-500/25 transition-colors"
          >
            <Medal class="w-3 h-3" />
            {{ season.name }}
          </router-link>
        </div>
        <div class="flex items-center gap-4 text-[11px] text-muted-foreground font-mono">
          <span v-if="playerCount" class="flex items-center gap-1.5">
            <Users class="w-3.5 h-3.5" /> {{ playerCount }}
          </span>
          <span v-if="gameCount" class="flex items-center gap-1.5">
            <Clock class="w-3.5 h-3.5" /> {{ gameCount }}{{ gameCount === 1 ? ' game' : ' games' }}
          </span>
        </div>
      </div>

      <!-- Score row -->
      <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-6">
        <!-- Left -->
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-10 h-10 rounded-lg shrink-0 overflow-hidden flex items-center justify-center"
               :class="left.imageUrl ? 'border border-green-500/30' : 'bg-green-500/15 border border-green-500/30'">
            <img v-if="left.imageUrl" :src="left.imageUrl" class="w-full h-full object-cover" />
            <Shield v-else class="w-5 h-5 text-green-500" />
          </div>
          <div class="min-w-0">
            <router-link :to="sideHref(left)" class="font-bold truncate block hover:text-primary transition-colors">
              {{ left.name }}
            </router-link>
            <div class="text-[10px] font-mono text-muted-foreground tabular-nums">
              <span class="text-green-400 font-bold">{{ leftLabelText }}</span>
              <template v-if="left.mmr !== undefined">
                <span class="mx-1.5">·</span>
                <span>{{ left.mmr }} MMR</span>
              </template>
              <template v-if="hasPoints && left.points !== undefined">
                <span class="mx-1.5">·</span>
                <span>{{ left.points }} {{ t('seasonPoints').toUpperCase() }}</span>
              </template>
            </div>
          </div>
        </div>

        <!-- Score -->
        <div class="flex items-center gap-4 px-5 py-3 rounded-2xl bg-[#0A0F1C] border border-border/40">
          <span class="text-4xl font-bold tabular-nums" :class="leftWon ? 'text-green-400' : 'text-foreground/70'">{{ scoreLeft }}</span>
          <span class="text-muted-foreground/40 text-2xl font-bold">·</span>
          <span class="text-4xl font-bold tabular-nums" :class="rightWon ? 'text-red-400' : 'text-foreground/70'">{{ scoreRight }}</span>
        </div>

        <!-- Right -->
        <div class="flex items-center gap-3 min-w-0 justify-end">
          <div class="min-w-0 text-right">
            <router-link :to="sideHref(right)" class="font-bold truncate block hover:text-primary transition-colors">
              {{ right.name }}
            </router-link>
            <div class="text-[10px] font-mono text-muted-foreground tabular-nums">
              <template v-if="hasPoints && right.points !== undefined">
                <span>{{ right.points }} {{ t('seasonPoints').toUpperCase() }}</span>
                <span class="mx-1.5">·</span>
              </template>
              <template v-if="right.mmr !== undefined">
                <span>{{ right.mmr }} MMR</span>
                <span class="mx-1.5">·</span>
              </template>
              <span class="text-red-400 font-bold">{{ rightLabelText }}</span>
            </div>
          </div>
          <div class="w-10 h-10 rounded-lg shrink-0 overflow-hidden flex items-center justify-center"
               :class="right.imageUrl ? 'border border-red-500/30' : 'bg-red-500/15 border border-red-500/30'">
            <img v-if="right.imageUrl" :src="right.imageUrl" class="w-full h-full object-cover" />
            <Shield v-else class="w-5 h-5 text-red-500" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
