<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Shield } from 'lucide-vue-next'
import UserName from '@/components/common/UserName.vue'

interface RosterPlayer {
  id: number  // playerId
  name: string
  avatarUrl?: string | null
  mmr?: number
  pointsAfter?: number | null
  seasonDelta?: number | null
  verified?: string | null
  isCaptain?: boolean
}

interface Props {
  teamName: string
  teamColor?: 'green' | 'red'
  teamResultLabel: string  // "Victory" / "Defeat" / "Live" / etc
  teamWon?: boolean
  players: RosterPlayer[]
  hasPointChanges?: boolean
  /** Custom slot for an admin/captain action button on each row (right side). */
}

const props = withDefaults(defineProps<Props>(), {
  teamColor: 'green',
  hasPointChanges: false,
})
const { t } = useI18n()

const colorClasses = computed(() => {
  if (props.teamColor === 'red') return {
    border: 'border-red-500/40',
    bgHeader: 'bg-red-500/10',
    borderHeader: 'border-red-500/30',
    text: 'text-red-500',
    badgeWin: 'bg-green-500/15 text-green-500',
    captainBadge: 'text-red-400 bg-red-500/10',
  }
  return {
    border: 'border-green-500/40',
    bgHeader: 'bg-green-500/10',
    borderHeader: 'border-green-500/30',
    text: 'text-green-500',
    badgeWin: 'bg-green-500/15 text-green-500',
    captainBadge: 'text-green-400 bg-green-500/10',
  }
})

function fmtSignedDelta(d: number | null | undefined): string {
  const n = Number(d)
  if (!Number.isFinite(n)) return ''
  const r = Math.round(n * 10) / 10
  return r > 0 ? `+${r}` : String(r)
}
</script>

<template>
  <div class="card overflow-hidden" :class="colorClasses.border">
    <!-- Header -->
    <div class="flex items-center justify-between px-5 py-4 border-b" :class="[colorClasses.bgHeader, colorClasses.borderHeader]">
      <div class="flex items-center gap-2">
        <Shield class="w-4 h-4" :class="colorClasses.text" />
        <span class="font-bold text-sm">{{ teamName }}</span>
        <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ml-1"
              :class="teamWon ? colorClasses.badgeWin : 'bg-muted/40 text-muted-foreground'">
          {{ teamResultLabel }}
        </span>
      </div>
      <slot name="header-right" />
    </div>

    <!-- Column headers -->
    <div
      class="px-5 py-2.5 grid items-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground border-b border-border/30"
      :style="hasPointChanges ? 'grid-template-columns: 1fr 80px 90px 80px;' : 'grid-template-columns: 1fr 100px;'"
    >
      <span>{{ t('player') }}</span>
      <span class="text-right">MMR</span>
      <template v-if="hasPointChanges">
        <span class="text-right">{{ t('seasonPoints') }}</span>
        <span class="text-right">{{ t('seasonChange') }}</span>
      </template>
    </div>

    <!-- Player rows -->
    <div>
      <div
        v-for="(p, idx) in players" :key="p.id || idx"
        class="px-5 py-2.5 grid items-center border-b border-border/20 last:border-b-0 hover:bg-accent/15 transition-colors"
        :style="hasPointChanges ? 'grid-template-columns: 1fr 80px 90px 80px;' : 'grid-template-columns: 1fr 100px;'"
      >
        <div class="flex items-center gap-2 min-w-0">
          <UserName :id="p.id" :name="p.name" :avatar-url="p.avatarUrl" :verified="p.verified" size="md" class="min-w-0" />
          <span v-if="p.isCaptain || idx === 0" class="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0" :class="colorClasses.captainBadge">CPT</span>
          <slot name="row-action" :player="p" :index="idx" />
        </div>
        <span class="text-right text-xs font-mono text-muted-foreground tabular-nums">{{ p.mmr ?? '—' }}</span>
        <template v-if="hasPointChanges">
          <span class="text-right text-xs font-mono font-bold tabular-nums">
            <template v-if="Number.isFinite(Number(p.pointsAfter))">{{ Math.round(Number(p.pointsAfter)) }}</template>
            <template v-else>—</template>
          </span>
          <span class="text-right text-xs font-mono font-bold tabular-nums"
                :class="Number(p.seasonDelta) > 0 ? 'text-green-500' : (Number(p.seasonDelta) < 0 ? 'text-red-500' : 'text-muted-foreground')">
            {{ fmtSignedDelta(p.seasonDelta) || '—' }}
          </span>
        </template>
      </div>
    </div>
  </div>
</template>
