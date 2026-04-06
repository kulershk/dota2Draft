<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Swords, ChevronDown, ChevronUp, EyeOff, BarChart3 } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { MATCH_STATUS } from '@/utils/constants'
import UserName from '@/components/common/UserName.vue'
import TeamName from '@/components/common/TeamName.vue'

const { t } = useI18n()

const props = defineProps<{
  matches: any[]
  tournamentState: any
  captains: any[]
  rosters: Record<number, any[]>
  isAdmin: boolean
}>()

const emit = defineEmits<{
  'edit-match': [match: any]
}>()

const collapsedGroups = ref<Set<string>>(new Set())
const showSos = ref(false)

function toggleMatches(groupName: string) {
  const s = new Set(collapsedGroups.value)
  if (s.has(groupName)) s.delete(groupName)
  else s.add(groupName)
  collapsedGroups.value = s
}

function isGroupExpanded(groupName: string) {
  return !collapsedGroups.value.has(groupName)
}

const groupsList = computed(() => props.tournamentState.groups || [])

function getRowColor(groupName: string, idx: number): string | null {
  const group = groupsList.value.find((g: any) => g.name === groupName)
  if (!group?.colorLines?.length) return null
  let pos = 0
  for (const cl of group.colorLines) {
    pos += cl.count
    if (idx < pos) return cl.color
  }
  return null
}

// Compute standings per group
const standings = computed(() => {
  const result: Record<string, any[]> = {}
  for (const group of groupsList.value) {
    const entries: any[] = []
    const statsById: Record<number, any> = {}

    for (let ti = 0; ti < group.teamIds.length; ti++) {
      const id = group.teamIds[ti]
      if (id == null) {
        entries.push({ key: `tbd-${ti}`, id: null, team: t('tbd'), avatar: '', w: 0, d: 0, l: 0, mw: 0, ml: 0, pts: 0, isTbd: true })
      } else {
        const cap = props.captains.find(c => c.id === id)
        const entry = { key: id, id, team: cap?.team || '?', avatar: cap?.banner_url || cap?.avatar_url || '', hasBanner: !!cap?.banner_url, w: 0, d: 0, l: 0, mw: 0, ml: 0, pts: 0, isTbd: false }
        entries.push(entry)
        statsById[id] = entry
      }
    }

    const groupMatches = props.matches.filter(m => m.group_name === group.name)
    for (const m of groupMatches) {
      if (m.status !== MATCH_STATUS.COMPLETED) continue
      const s1 = m.score1 || 0
      const s2 = m.score2 || 0
      if (m.winner_captain_id === m.team1_captain_id) {
        if (statsById[m.team1_captain_id]) { statsById[m.team1_captain_id].w++; statsById[m.team1_captain_id].pts += 2; statsById[m.team1_captain_id].mw += s1; statsById[m.team1_captain_id].ml += s2 }
        if (statsById[m.team2_captain_id]) { statsById[m.team2_captain_id].l++; statsById[m.team2_captain_id].mw += s2; statsById[m.team2_captain_id].ml += s1 }
      } else if (m.winner_captain_id === m.team2_captain_id) {
        if (statsById[m.team2_captain_id]) { statsById[m.team2_captain_id].w++; statsById[m.team2_captain_id].pts += 2; statsById[m.team2_captain_id].mw += s2; statsById[m.team2_captain_id].ml += s1 }
        if (statsById[m.team1_captain_id]) { statsById[m.team1_captain_id].l++; statsById[m.team1_captain_id].mw += s1; statsById[m.team1_captain_id].ml += s2 }
      } else if (s1 === s2 && s1 > 0) {
        if (statsById[m.team1_captain_id]) { statsById[m.team1_captain_id].d++; statsById[m.team1_captain_id].pts += 1; statsById[m.team1_captain_id].mw += s1; statsById[m.team1_captain_id].ml += s2 }
        if (statsById[m.team2_captain_id]) { statsById[m.team2_captain_id].d++; statsById[m.team2_captain_id].pts += 1; statsById[m.team2_captain_id].mw += s2; statsById[m.team2_captain_id].ml += s1 }
      }
    }

    // Calculate SOS (Strength of Schedule) for each team
    // SOS = sum of points of all opponents played
    for (const entry of entries) {
      if (entry.isTbd) { entry.sos = 0; continue }
      let totalOppPts = 0
      for (const m of groupMatches) {
        if (m.status !== MATCH_STATUS.COMPLETED) continue
        if (m.team1_captain_id === entry.id && statsById[m.team2_captain_id]) totalOppPts += statsById[m.team2_captain_id].pts
        else if (m.team2_captain_id === entry.id && statsById[m.team1_captain_id]) totalOppPts += statsById[m.team1_captain_id].pts
      }
      entry.sos = totalOppPts
    }

    result[group.name] = entries.sort((a, b) => {
      if (a.isTbd !== b.isTbd) return a.isTbd ? 1 : -1
      if (b.pts !== a.pts) return b.pts - a.pts
      return (b.mw - b.ml) - (a.mw - a.ml)
    })
  }
  return result
})

const recentMatches = computed(() => {
  return props.matches
    .filter(m => m.status === MATCH_STATUS.COMPLETED && (props.isAdmin || !m.hidden))
    .sort((a, b) => (b.updated_at || b.id) - (a.updated_at || a.id))
    .slice(0, 10)
})

const matchesByGroup = computed(() => {
  const result: Record<string, any[]> = {}
  for (const group of groupsList.value) {
    result[group.name] = props.matches
      .filter(m => m.group_name === group.name && (props.isAdmin || !m.hidden))
      .sort((a, b) => a.match_order - b.match_order)
  }
  return result
})
</script>

<template>
  <div class="flex flex-col gap-8">
    <!-- Group standings tables -->
    <div v-for="group in groupsList" :key="group.name" class="card overflow-hidden flex flex-col gap-0">
      <!-- Group title bar -->
      <div class="flex items-center justify-between bg-card px-4 py-3">
        <span class="text-sm font-bold text-foreground uppercase tracking-wider">{{ group.name }}</span>
        <button class="p-1 rounded hover:bg-accent transition-colors" :class="showSos ? 'text-primary' : 'text-muted-foreground'" @click="showSos = !showSos" title="Strength of Schedule">
          <BarChart3 class="w-4 h-4" />
        </button>
      </div>

      <!-- Table header -->
      <div class="flex items-center bg-surface px-4 py-2.5">
        <span class="w-10 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">#</span>
        <span class="flex-1 text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">{{ t('team') }}</span>
        <span class="w-[50px] text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary text-center">W</span>
        <span class="w-[50px] text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary text-center">L</span>
        <span class="w-[60px] text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary text-right">PTS</span>
        <span v-if="showSos" class="w-[50px] text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary text-right" title="Strength of Schedule">SOS</span>
      </div>

      <!-- Team rows -->
      <div
        v-for="(team, idx) in standings[group.name]"
        :key="team.key"
        class="flex items-center px-4 py-2.5 border-b border-border last:border-0 relative"
      >
        <div v-if="getRowColor(group.name, idx)" class="absolute left-0 top-0 bottom-0 w-1 rounded-r-sm" :style="{ backgroundColor: getRowColor(group.name, idx)! }" />
        <span class="w-10 text-sm font-mono"
          :class="idx === 0 ? 'text-primary font-bold' : 'text-muted-foreground'">{{ idx + 1 }}</span>
        <div class="flex-1 min-w-0">
          <TeamName v-if="team.id" :id="team.id" :name="team.team" :avatar-url="team.avatar" />
          <span v-else class="text-sm font-medium truncate text-muted-foreground italic">{{ team.team }}</span>
          <!-- Team members -->
          <div v-if="team.id && props.rosters[team.id]?.length" class="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 ml-[30px]">
            <UserName
              v-for="player in props.rosters[team.id]"
              :key="player.player_id"
              :id="player.player_id"
              :name="player.name"
              :avatar-url="player.avatar"
              size="xs"
            />
          </div>
        </div>
        <span class="w-[50px] text-sm font-mono font-semibold text-center text-color-success">{{ team.mw }}</span>
        <span class="w-[50px] text-sm font-mono text-center text-destructive">{{ team.ml }}</span>
        <span class="w-[60px] text-sm font-mono font-bold text-right text-foreground">{{ team.pts }}</span>
        <span v-if="showSos" class="w-[50px] text-sm font-mono text-right text-muted-foreground">{{ team.isTbd ? '-' : team.sos }}</span>
      </div>
    </div>

    <!-- Recent Match Results -->
    <div v-if="recentMatches.length > 0" class="flex flex-col gap-4">
      <div class="flex items-center gap-2">
        <Swords class="w-[18px] h-[18px] text-primary" />
        <span class="text-lg font-semibold text-foreground">{{ t('recentMatchResults') || 'Recent Match Results' }}</span>
      </div>

      <div class="flex flex-col gap-3">
        <div
          v-for="match in recentMatches"
          :key="match.id"
          class="flex items-center justify-between rounded-md bg-card px-5 py-3.5 cursor-pointer hover:bg-card/80 transition-colors"
          :class="match.hidden ? 'opacity-40' : ''"
          @click="emit('edit-match', match)"
        >
          <!-- Team 1 -->
          <div class="flex-1 flex items-center justify-end gap-2.5 min-w-0">
            <router-link v-if="match.team1_captain_id" :to="{ name: 'team-profile', params: { id: match.team1_captain_id } }" class="text-sm font-medium text-foreground truncate hover:text-primary transition-colors" :class="match.winner_captain_id === match.team1_captain_id ? 'font-bold' : ''" @click.stop>
              {{ match.team1_name || t('tbd') }}
            </router-link>
            <span v-else class="text-sm font-medium text-muted-foreground truncate">{{ t('tbd') }}</span>
            <div class="w-7 h-7 rounded bg-surface overflow-hidden shrink-0">
              <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-full h-full object-cover" />
            </div>
          </div>

          <!-- Score -->
          <div class="flex items-center gap-2 px-6">
            <span class="text-lg font-bold font-mono"
              :class="match.winner_captain_id === match.team1_captain_id ? 'text-color-success' : 'text-destructive'">
              {{ match.score1 != null ? match.score1 : '-' }}
            </span>
            <span class="text-text-tertiary font-mono">:</span>
            <span class="text-lg font-bold font-mono"
              :class="match.winner_captain_id === match.team2_captain_id ? 'text-color-success' : 'text-destructive'">
              {{ match.score2 != null ? match.score2 : '-' }}
            </span>
            <!-- Status badge for non-normal results -->
            <span v-if="match.status === 'cancelled'" class="badge-danger ml-1">Cancelled</span>
          </div>

          <!-- Team 2 -->
          <div class="flex-1 flex items-center gap-2.5 min-w-0">
            <div class="w-7 h-7 rounded bg-surface overflow-hidden shrink-0">
              <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-full h-full object-cover" />
            </div>
            <router-link v-if="match.team2_captain_id" :to="{ name: 'team-profile', params: { id: match.team2_captain_id } }" class="text-sm font-medium text-foreground truncate hover:text-primary transition-colors" :class="match.winner_captain_id === match.team2_captain_id ? 'font-bold' : ''" @click.stop>
              {{ match.team2_name || t('tbd') }}
            </router-link>
            <span v-else class="text-sm font-medium text-muted-foreground truncate">{{ t('tbd') }}</span>
          </div>

          <EyeOff v-if="match.hidden && isAdmin" class="w-3.5 h-3.5 text-muted-foreground shrink-0 ml-2" :title="t('hiddenMatch')" />
        </div>
      </div>
    </div>

    <!-- All matches by group (expandable) -->
    <div v-for="group in groupsList" :key="'matches-' + group.name" class="flex flex-col gap-3">
      <button
        class="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors self-start"
        @click="toggleMatches(group.name)"
      >
        <component :is="isGroupExpanded(group.name) ? ChevronUp : ChevronDown" class="w-4 h-4" />
        {{ group.name }} {{ t('matches') || 'Matches' }}
        <span class="text-xs text-text-tertiary">({{ matchesByGroup[group.name]?.length || 0 }})</span>
      </button>

      <div v-if="isGroupExpanded(group.name)" class="flex flex-col gap-2">
        <div
          v-for="match in matchesByGroup[group.name]"
          :key="match.id"
          class="flex items-center justify-between rounded-md bg-card px-5 py-3.5 cursor-pointer hover:bg-card/80 transition-colors"
          :class="match.hidden ? 'opacity-40' : ''"
          @click="emit('edit-match', match)"
        >
          <span class="text-[9px] font-bold uppercase tracking-wider w-20 shrink-0"
            :class="match.status === MATCH_STATUS.LIVE ? 'text-amber-500' : match.status === MATCH_STATUS.COMPLETED ? 'text-color-success' : 'text-muted-foreground'">
            {{ match.status === MATCH_STATUS.LIVE ? t('matchLive') : match.status === MATCH_STATUS.COMPLETED ? t('matchCompleted') : t('matchUpcoming') }}
          </span>
          <div class="flex-1 flex items-center justify-end gap-2.5 min-w-0">
            <router-link v-if="match.team1_captain_id" :to="{ name: 'team-profile', params: { id: match.team1_captain_id } }" class="text-sm font-medium text-foreground truncate hover:text-primary transition-colors" @click.stop>{{ match.team1_name || t('tbd') }}</router-link>
            <span v-else class="text-sm font-medium text-muted-foreground truncate">{{ t('tbd') }}</span>
            <div class="w-6 h-6 rounded bg-surface overflow-hidden shrink-0">
              <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-full h-full object-cover" />
            </div>
          </div>
          <div class="flex items-center gap-2 px-4">
            <span class="text-sm font-bold font-mono" :class="match.winner_captain_id === match.team1_captain_id ? 'text-color-success' : match.score1 != null ? 'text-destructive' : 'text-muted-foreground'">
              {{ match.score1 != null ? match.score1 : '-' }}
            </span>
            <span class="text-xs text-text-tertiary">:</span>
            <span class="text-sm font-bold font-mono" :class="match.winner_captain_id === match.team2_captain_id ? 'text-color-success' : match.score2 != null ? 'text-destructive' : 'text-muted-foreground'">
              {{ match.score2 != null ? match.score2 : '-' }}
            </span>
          </div>
          <div class="flex-1 flex items-center gap-2.5 min-w-0">
            <div class="w-6 h-6 rounded bg-surface overflow-hidden shrink-0">
              <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-full h-full object-cover" />
            </div>
            <router-link v-if="match.team2_captain_id" :to="{ name: 'team-profile', params: { id: match.team2_captain_id } }" class="text-sm font-medium text-foreground truncate hover:text-primary transition-colors" @click.stop>{{ match.team2_name || t('tbd') }}</router-link>
            <span v-else class="text-sm font-medium text-muted-foreground truncate">{{ t('tbd') }}</span>
          </div>
          <EyeOff v-if="match.hidden && isAdmin" class="w-3.5 h-3.5 text-muted-foreground shrink-0 ml-2" />
          <div v-if="match.games?.length" class="flex gap-1 shrink-0 ml-2">
            <a
              v-for="game in match.games.filter((g: any) => g.dotabuff_id)"
              :key="game.id"
              :href="`https://www.dotabuff.com/matches/${game.dotabuff_id}`"
              target="_blank" rel="noopener"
              class="text-[10px] text-primary hover:underline"
              @click.stop
            >G{{ game.game_number }}</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
