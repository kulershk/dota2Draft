<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import TeamName from '@/components/common/TeamName.vue'

const { t } = useI18n()

const props = defineProps<{
  stage: any
  matches: any[]
  captains: any[]
  isAdmin: boolean
}>()

const emit = defineEmits<{ 'edit-match': [match: any] }>()

function captainName(id: number | null): string {
  if (id == null) return t('tbd')
  const c = props.captains.find((x: any) => x.id === id)
  return c?.team || `#${id}`
}

// Group matches by `round` for column layout; matches without a round fall
// into round 1.
const rounds = computed(() => {
  const r: Record<number, any[]> = {}
  for (const m of props.matches) {
    const round = m.round || 1
    if (!r[round]) r[round] = []
    r[round].push(m)
  }
  for (const k in r) {
    r[k].sort((a: any, b: any) => (a.match_order || 0) - (b.match_order || 0) || a.id - b.id)
  }
  return r
})

const sortedRoundNumbers = computed(() =>
  Object.keys(rounds.value).map(Number).sort((a, b) => a - b)
)

// Tree layout: compute a floating-point vertical slot for every match so
// feeders line up around the match they feed into. We walk rounds from
// right to left: the rightmost round gets evenly spaced slots 0, 1, 2…
// and each earlier match is centered on the average slot of the match(es)
// it links forward to.
const CARD_H = 140   // card slot height (visible card ~110px + ~30px gap)
const COL_W = 280    // column width (260px card + 20px gap)

const layout = computed(() => {
  const slotByMatch = new Map<number, number>()

  // Build "incoming feeders" map: matchId -> [source matchIds whose
  // next_match_id or loser_next_match_id points at this match].
  const incoming = new Map<number, number[]>()
  for (const m of props.matches) {
    if (m.next_match_id != null) {
      const list = incoming.get(m.next_match_id) || []
      list.push(m.id)
      incoming.set(m.next_match_id, list)
    }
    if (m.loser_next_match_id != null) {
      const list = incoming.get(m.loser_next_match_id) || []
      list.push(m.id)
      incoming.set(m.loser_next_match_id, list)
    }
  }

  function resolveCollisions(list: any[]) {
    const placed = list
      .map((m: any) => ({ id: m.id, slot: slotByMatch.get(m.id)! }))
      .sort((a, b) => a.slot - b.slot)
    let prev = -Infinity
    for (const p of placed) {
      if (p.slot - prev < 1) p.slot = prev + 1
      slotByMatch.set(p.id, p.slot)
      prev = p.slot
    }
    return prev
  }

  // ── Pass 1: RIGHT → LEFT ──────────────────────────────────────────────
  // Rightmost column gets sequential slots (by match_order); earlier
  // columns are placed at the average slot of their outgoing targets,
  // falling back to sequential for unlinked matches. This handles
  // expanding brackets (e.g. play-ins feeding into a wider round).
  let fallback = 0
  const rtl = [...sortedRoundNumbers.value].reverse()
  for (let i = 0; i < rtl.length; i++) {
    const round = rtl[i]
    const list = rounds.value[round]
    if (i === 0) {
      list.forEach((m: any) => { slotByMatch.set(m.id, fallback++) })
    } else {
      for (const m of list) {
        const targets: number[] = []
        if (m.next_match_id != null) {
          const s = slotByMatch.get(m.next_match_id)
          if (s != null) targets.push(s)
        }
        if (m.loser_next_match_id != null) {
          const s = slotByMatch.get(m.loser_next_match_id)
          if (s != null) targets.push(s)
        }
        if (targets.length > 0) {
          slotByMatch.set(m.id, targets.reduce((a, b) => a + b, 0) / targets.length)
        } else {
          slotByMatch.set(m.id, fallback++)
        }
      }
      const maxSlot = resolveCollisions(list)
      fallback = Math.max(fallback, maxSlot + 1)
    }
  }

  // ── Pass 2: LEFT → RIGHT refinement ──────────────────────────────────
  // For shrinking brackets (wide round feeding a narrower successor), the
  // successor should sit at the centroid of its feeders. Walk columns
  // left to right and recenter any match that has placed incoming
  // feeders. Collisions are resolved again per column.
  for (let i = 1; i < sortedRoundNumbers.value.length; i++) {
    const round = sortedRoundNumbers.value[i]
    const list = rounds.value[round]
    for (const m of list) {
      const feeders = incoming.get(m.id) || []
      const placedFeeders = feeders
        .map(id => slotByMatch.get(id))
        .filter((s): s is number => s != null)
      if (placedFeeders.length > 0) {
        slotByMatch.set(m.id, placedFeeders.reduce((a, b) => a + b, 0) / placedFeeders.length)
      }
    }
    resolveCollisions(list)
  }

  // Normalize slots to start at 0 and compute container height
  let minSlot = Infinity, maxSlot = -Infinity
  for (const v of slotByMatch.values()) {
    if (v < minSlot) minSlot = v
    if (v > maxSlot) maxSlot = v
  }
  if (!Number.isFinite(minSlot)) { minSlot = 0; maxSlot = 0 }

  const positions: Record<number, { top: number; left: number }> = {}
  for (let i = 0; i < sortedRoundNumbers.value.length; i++) {
    const round = sortedRoundNumbers.value[i]
    for (const m of rounds.value[round]) {
      const slot = (slotByMatch.get(m.id) ?? 0) - minSlot
      positions[m.id] = { top: slot * CARD_H, left: i * COL_W }
    }
  }
  return {
    positions,
    width: sortedRoundNumbers.value.length * COL_W,
    height: (maxSlot - minSlot + 1) * CARD_H,
  }
})

// Build SVG connector paths for winner/loser links so the layout looks
// like a real pyramid bracket.
const connectors = computed(() => {
  const pos = layout.value.positions
  const CARD_W = 260
  const H = 110
  const out: { d: string; kind: 'winner' | 'loser' }[] = []
  for (const m of props.matches) {
    const from = pos[m.id]
    if (!from) continue
    const x1 = from.left + CARD_W
    const y1 = from.top + H / 2
    if (m.next_match_id != null && pos[m.next_match_id]) {
      const to = pos[m.next_match_id]
      const x2 = to.left
      const y2 = to.top + H / 2
      const mx = (x1 + x2) / 2
      out.push({ d: `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`, kind: 'winner' })
    }
    if (m.loser_next_match_id != null && pos[m.loser_next_match_id]) {
      const to = pos[m.loser_next_match_id]
      const x2 = to.left
      const y2 = to.top + H / 2
      const mx = (x1 + x2) / 2
      out.push({ d: `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`, kind: 'loser' })
    }
  }
  return out
})

function slotLabel(match: any, slot: 1 | 2): string {
  const captainId = slot === 1 ? match.team1_captain_id : match.team2_captain_id
  if (captainId) {
    const name = slot === 1 ? match.team1_name : match.team2_name
    return name || captainName(captainId)
  }
  for (const m of props.matches) {
    if (m.id === match.id) continue
    if (m.next_match_id === match.id && m.next_match_slot === slot) return `← W #${m.id}`
    if (m.loser_next_match_id === match.id && m.loser_next_match_slot === slot) return `← L #${m.id}`
  }
  return t('tbd')
}

function slotTeam(match: any, slot: 1 | 2): { id: number; name: string; avatarUrl: string; bannerUrl: string } | null {
  const captainId = slot === 1 ? match.team1_captain_id : match.team2_captain_id
  if (!captainId) return null
  return {
    id: captainId,
    name: (slot === 1 ? match.team1_name : match.team2_name) || captainName(captainId),
    avatarUrl: slot === 1 ? match.team1_avatar : match.team2_avatar,
    bannerUrl: slot === 1 ? match.team1_banner : match.team2_banner,
  }
}

function score(match: any, slot: 1 | 2): string {
  const s = slot === 1 ? match.score1 : match.score2
  return s != null ? String(s) : '-'
}

function isWinner(match: any, slot: 1 | 2): boolean {
  if (match.status !== 'completed' || !match.winner_captain_id) return false
  const id = slot === 1 ? match.team1_captain_id : match.team2_captain_id
  return id === match.winner_captain_id
}

function onMatchClick(match: any) {
  if (props.isAdmin) emit('edit-match', match)
}
</script>

<template>
  <div class="overflow-x-auto">
    <div class="relative min-w-fit pb-4"
      :style="{ width: layout.width + 'px', height: (layout.height + 40) + 'px' }">

      <!-- Column round labels across the top -->
      <div v-for="(round, idx) in sortedRoundNumbers" :key="'label-' + round"
        class="absolute text-[10px] font-bold uppercase tracking-wider text-muted-foreground"
        :style="{ left: (idx * 280) + 'px', top: '0px', width: '260px' }">
        {{ t('customBracketRound') }} {{ round }}
      </div>

      <!-- SVG connector layer -->
      <svg class="absolute top-8 left-0 pointer-events-none"
        :width="layout.width" :height="layout.height"
        :viewBox="'0 0 ' + layout.width + ' ' + layout.height">
        <path v-for="(c, i) in connectors" :key="i"
          :d="c.d"
          fill="none"
          :stroke="c.kind === 'winner' ? 'hsl(var(--border))' : 'hsl(var(--destructive))'"
          stroke-width="1.5"
          stroke-opacity="0.6"
        />
      </svg>

      <!-- Match cards (absolutely positioned) -->
      <div v-for="match in matches" :key="match.id"
        class="card p-3 transition-colors absolute"
        :class="isAdmin ? 'cursor-pointer hover:bg-accent/30' : ''"
        :style="{
          top: (layout.positions[match.id]?.top + 32) + 'px',
          left: layout.positions[match.id]?.left + 'px',
          width: '260px',
        }"
        @click="onMatchClick(match)">
        <div class="flex items-center gap-2 mb-2">
          <span class="text-[10px] font-mono text-muted-foreground">#{{ match.id }}</span>
          <span v-if="match.label" class="text-[10px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">{{ match.label }}</span>
          <span class="text-[10px] text-muted-foreground ml-auto">Bo{{ match.best_of }}</span>
        </div>
        <div class="flex flex-col gap-1">
          <div class="flex items-center gap-2 px-2 py-1.5 rounded"
            :class="isWinner(match, 1) ? 'bg-green-500/10' : 'bg-accent/40'">
            <div class="flex-1 min-w-0" :class="isWinner(match, 1) ? 'font-bold text-green-400' : ''">
              <TeamName v-if="slotTeam(match, 1)"
                :id="slotTeam(match, 1)!.id"
                :name="slotTeam(match, 1)!.name"
                :avatar-url="slotTeam(match, 1)!.avatarUrl"
                :banner-url="slotTeam(match, 1)!.bannerUrl"
                size="sm"
                no-link
              />
              <span v-else class="text-sm text-muted-foreground truncate block">{{ slotLabel(match, 1) }}</span>
            </div>
            <span class="text-sm font-mono tabular-nums" :class="isWinner(match, 1) ? 'text-green-400 font-bold' : 'text-muted-foreground'">
              {{ score(match, 1) }}
            </span>
          </div>
          <div class="flex items-center gap-2 px-2 py-1.5 rounded"
            :class="isWinner(match, 2) ? 'bg-green-500/10' : 'bg-accent/40'">
            <div class="flex-1 min-w-0" :class="isWinner(match, 2) ? 'font-bold text-green-400' : ''">
              <TeamName v-if="slotTeam(match, 2)"
                :id="slotTeam(match, 2)!.id"
                :name="slotTeam(match, 2)!.name"
                :avatar-url="slotTeam(match, 2)!.avatarUrl"
                :banner-url="slotTeam(match, 2)!.bannerUrl"
                size="sm"
                no-link
              />
              <span v-else class="text-sm text-muted-foreground truncate block">{{ slotLabel(match, 2) }}</span>
            </div>
            <span class="text-sm font-mono tabular-nums" :class="isWinner(match, 2) ? 'text-green-400 font-bold' : 'text-muted-foreground'">
              {{ score(match, 2) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
