<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, EyeOff } from 'lucide-vue-next'
import { computed, ref } from 'vue'

const { t } = useI18n()

const props = defineProps<{
  matches: any[]
  tournamentState: any
  captains: any[]
  isAdmin: boolean
}>()

const emit = defineEmits<{
  'edit-match': [match: any]
}>()

const expandedGroups = ref<Set<string>>(new Set())

function toggleMatches(groupName: string) {
  const s = new Set(expandedGroups.value)
  if (s.has(groupName)) s.delete(groupName)
  else s.add(groupName)
  expandedGroups.value = s
}

const groupsList = computed(() => props.tournamentState.groups || [])

// Compute standings per group
const standings = computed(() => {
  const result: Record<string, any[]> = {}
  for (const group of groupsList.value) {
    const entries: any[] = []
    const statsById: Record<number, any> = {}

    for (let ti = 0; ti < group.teamIds.length; ti++) {
      const id = group.teamIds[ti]
      if (id == null) {
        // TBD entry — unique key, no stats
        entries.push({ key: `tbd-${ti}`, id: null, team: t('tbd'), avatar: '', w: 0, l: 0, mw: 0, ml: 0, isTbd: true })
      } else {
        const cap = props.captains.find(c => c.id === id)
        const entry = { key: id, id, team: cap?.team || '?', avatar: cap?.banner_url || cap?.avatar_url || '', hasBanner: !!cap?.banner_url, w: 0, l: 0, mw: 0, ml: 0, isTbd: false }
        entries.push(entry)
        statsById[id] = entry
      }
    }

    const groupMatches = props.matches.filter(m => m.group_name === group.name)
    for (const m of groupMatches) {
      if (m.status !== 'completed') continue
      if (m.winner_captain_id === m.team1_captain_id) {
        if (statsById[m.team1_captain_id]) { statsById[m.team1_captain_id].w++; statsById[m.team1_captain_id].mw += m.score1 || 0; statsById[m.team1_captain_id].ml += m.score2 || 0 }
        if (statsById[m.team2_captain_id]) { statsById[m.team2_captain_id].l++; statsById[m.team2_captain_id].mw += m.score2 || 0; statsById[m.team2_captain_id].ml += m.score1 || 0 }
      } else if (m.winner_captain_id === m.team2_captain_id) {
        if (statsById[m.team2_captain_id]) { statsById[m.team2_captain_id].w++; statsById[m.team2_captain_id].mw += m.score2 || 0; statsById[m.team2_captain_id].ml += m.score1 || 0 }
        if (statsById[m.team1_captain_id]) { statsById[m.team1_captain_id].l++; statsById[m.team1_captain_id].mw += m.score1 || 0; statsById[m.team1_captain_id].ml += m.score2 || 0 }
      }
    }

    // Sort: real teams by wins/diff first, TBD entries at the bottom
    result[group.name] = entries.sort((a, b) => {
      if (a.isTbd !== b.isTbd) return a.isTbd ? 1 : -1
      if (b.w !== a.w) return b.w - a.w
      return (b.mw - b.ml) - (a.mw - a.ml)
    })
  }
  return result
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

function statusBadge(status: string) {
  if (status === 'completed') return 'bg-green-500/15 text-green-600 dark:text-green-400'
  if (status === 'live') return 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
  return 'bg-accent text-muted-foreground'
}

function statusText(status: string) {
  if (status === 'completed') return t('matchCompleted')
  if (status === 'live') return t('matchLive')
  return t('matchPending')
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div v-for="group in groupsList" :key="group.name" class="flex flex-col gap-4">
      <h2 class="text-lg font-semibold text-foreground">{{ group.name }}</h2>

      <!-- Standings table -->
      <div class="card overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-accent/50">
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground">#</th>
              <th class="text-left px-4 py-2.5 font-medium text-muted-foreground">{{ t('team') }}</th>
              <th class="text-center px-4 py-2.5 font-medium text-muted-foreground">{{ t('wins') }}</th>
              <th class="text-center px-4 py-2.5 font-medium text-muted-foreground">{{ t('losses') }}</th>
              <th class="text-center px-4 py-2.5 font-medium text-muted-foreground">{{ t('points') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(team, idx) in standings[group.name]" :key="team.key" class="border-b border-border last:border-0">
              <td class="px-4 py-2.5 text-muted-foreground">{{ idx + 1 }}</td>
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-2">
                  <img v-if="team.avatar" :src="team.avatar" class="w-5 h-5 object-cover" :class="team.hasBanner ? 'rounded' : 'rounded-full'" />
                  <span class="font-medium" :class="team.isTbd ? 'text-muted-foreground italic' : 'text-foreground'">{{ team.team }}</span>
                </div>
              </td>
              <td class="text-center px-4 py-2.5 text-green-600 dark:text-green-400 font-medium">{{ team.w }}</td>
              <td class="text-center px-4 py-2.5 text-red-500 font-medium">{{ team.l }}</td>
              <td class="text-center px-4 py-2.5 font-bold text-foreground">{{ team.w * 3 }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Matches toggle -->
      <button
        class="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors self-start"
        @click="toggleMatches(group.name)"
      >
        <component :is="expandedGroups.has(group.name) ? ChevronUp : ChevronDown" class="w-4 h-4" />
        {{ expandedGroups.has(group.name) ? t('hideMatches') : t('showMatches') }}
        <span class="text-xs text-muted-foreground/60">({{ matchesByGroup[group.name]?.length || 0 }})</span>
      </button>

      <!-- Matches list -->
      <div v-if="expandedGroups.has(group.name)" class="flex flex-col gap-2">
        <div
          v-for="match in matchesByGroup[group.name]"
          :key="match.id"
          class="card p-3 flex items-center gap-3 cursor-pointer hover:shadow-sm transition-shadow"
          :class="match.hidden ? 'opacity-40' : ''"
          @click="isAdmin ? emit('edit-match', match) : null"
        >
          <!-- Team 1 -->
          <div class="flex-1 flex items-center justify-end gap-2">
            <span class="text-sm font-medium text-foreground truncate" :class="match.winner_captain_id === match.team1_captain_id ? 'font-bold' : ''">
              {{ match.team1_name || t('tbd') }}
            </span>
            <img v-if="match.team1_banner || match.team1_avatar" :src="match.team1_banner || match.team1_avatar" class="w-5 h-5 object-cover" :class="match.team1_banner ? 'rounded' : 'rounded-full'" />
          </div>
          <!-- Score -->
          <div class="flex items-center gap-1.5 px-3">
            <span class="text-sm font-bold" :class="match.winner_captain_id === match.team1_captain_id ? 'text-primary' : 'text-muted-foreground'">
              {{ match.score1 != null ? match.score1 : '-' }}
            </span>
            <span class="text-xs text-muted-foreground">:</span>
            <span class="text-sm font-bold" :class="match.winner_captain_id === match.team2_captain_id ? 'text-primary' : 'text-muted-foreground'">
              {{ match.score2 != null ? match.score2 : '-' }}
            </span>
          </div>
          <!-- Team 2 -->
          <div class="flex-1 flex items-center gap-2">
            <img v-if="match.team2_banner || match.team2_avatar" :src="match.team2_banner || match.team2_avatar" class="w-5 h-5 object-cover" :class="match.team2_banner ? 'rounded' : 'rounded-full'" />
            <span class="text-sm font-medium text-foreground truncate" :class="match.winner_captain_id === match.team2_captain_id ? 'font-bold' : ''">
              {{ match.team2_name || t('tbd') }}
            </span>
          </div>
          <!-- Hidden indicator -->
          <EyeOff v-if="match.hidden && isAdmin" class="w-3.5 h-3.5 text-muted-foreground shrink-0" :title="t('hiddenMatch')" />
          <!-- Status -->
          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0" :class="statusBadge(match.status)">
            {{ statusText(match.status) }}
          </span>
          <!-- Dotabuff links -->
          <div v-if="match.games?.length" class="flex gap-1 shrink-0">
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
