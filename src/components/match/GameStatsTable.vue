<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trophy } from 'lucide-vue-next'
import PositionIcon from '@/components/common/PositionIcon.vue'

interface Stat {
  account_id: number
  profile_id?: number | null
  profile_name?: string
  profile_display_name?: string
  player_name?: string
  hero_id: number
  level: number
  kills: number
  deaths: number
  assists: number
  last_hits: number
  denies: number
  net_worth: number
  gpm: number
  xpm: number
  hero_damage: number
  tower_damage: number
  hero_healing: number
  is_radiant: boolean
  win: boolean | number
  item_0: number; item_1: number; item_2: number
  item_3: number; item_4: number; item_5: number
  item_neutral: number
  backpack_0: number; backpack_1: number; backpack_2: number
}

interface Props {
  stats: Stat[]
  playerPositions?: Record<number, number>
  team1Name: string
  team2Name: string
  dota: any
}

const props = defineProps<Props>()
const { t } = useI18n()

function playerDisplayName(p: Stat): string {
  return p.profile_display_name || p.profile_name || p.player_name || String(p.account_id)
}

function sortedTeamStats(isRadiant: boolean): Stat[] {
  const team = (props.stats || []).filter(s => s.is_radiant === isRadiant)
  if (!props.playerPositions) return team
  const pos = props.playerPositions
  return [...team].sort((a, b) => (pos[a.account_id] || 9) - (pos[b.account_id] || 9))
}
function teamTotalKills(isRadiant: boolean): number {
  return (props.stats || []).filter(s => s.is_radiant === isRadiant).reduce((sum, p) => sum + (p.kills || 0), 0)
}
function teamTotalNW(isRadiant: boolean): string {
  const total = (props.stats || []).filter(s => s.is_radiant === isRadiant).reduce((sum, p) => sum + (p.net_worth || 0), 0)
  return (total / 1000).toFixed(1) + 'k'
}
function teamWon(isRadiant: boolean): boolean {
  return !!(props.stats || []).find(s => s.is_radiant === isRadiant && s.win)
}

const sides = computed(() => [
  { isRadiant: true, name: props.team1Name, color: 'green' },
  { isRadiant: false, name: props.team2Name, color: 'red' },
])
</script>

<template>
  <div class="overflow-x-auto rounded-lg">
    <table class="w-full text-xs" style="border-collapse: separate; border-spacing: 0;">
      <thead>
        <tr class="text-[10px] text-muted-foreground border-b border-border/20">
          <th class="text-left py-1 px-1.5 min-w-[200px] sticky left-0 bg-card z-10"></th>
          <th class="text-center px-1 w-5"></th>
          <th class="text-center px-1.5">K/D/A</th>
          <th class="text-center px-1">LH/DN</th>
          <th class="text-center px-1">NET</th>
          <th class="text-center px-1">GPM/XPM</th>
          <th class="text-left px-1.5">{{ t('items') }}</th>
          <th class="text-center px-1">HD</th>
          <th class="text-center px-1">TD</th>
          <th class="text-center px-1">HH</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="side in sides" :key="side.color">
          <!-- Team header row -->
          <tr :class="side.isRadiant ? 'bg-green-500/10' : 'bg-red-500/10'">
            <td class="py-2 px-3 sticky left-0 z-10"
                :class="side.isRadiant ? 'bg-green-500/10 border-l-4 border-green-500' : 'bg-red-500/10 border-l-4 border-red-500'">
              <div class="flex items-center gap-2">
                <span class="text-sm font-bold" :class="side.isRadiant ? 'text-green-500' : 'text-red-400'">{{ side.name }}</span>
                <Trophy v-if="teamWon(side.isRadiant)" class="w-4 h-4 text-amber-500" />
              </div>
            </td>
            <td :colspan="9" class="py-2 px-3 text-right" :class="side.isRadiant ? 'bg-green-500/10' : 'bg-red-500/10'">
              <span class="text-xs font-mono text-muted-foreground">{{ teamTotalKills(side.isRadiant) }} kills</span>
              <span class="text-xs font-mono text-amber-500 ml-3">{{ teamTotalNW(side.isRadiant) }}</span>
            </td>
          </tr>
          <!-- Player rows -->
          <tr v-for="p in sortedTeamStats(side.isRadiant)" :key="p.account_id"
              class="hover:bg-accent/30 transition-colors border-b"
              :class="side.isRadiant ? 'border-green-500/5' : 'border-red-500/5'">
            <!-- Hero + Name -->
            <td class="py-1.5 px-1.5 sticky left-0 bg-card z-10">
              <div class="flex items-center gap-2">
                <div class="relative shrink-0">
                  <img v-if="dota.heroImg(p.hero_id)" :src="dota.heroImg(p.hero_id)"
                       class="w-[60px] h-[42px] rounded object-cover border"
                       :class="side.isRadiant ? 'border-green-500/30' : 'border-red-500/30'" />
                  <span class="absolute -bottom-1 -right-1 text-[9px] font-bold bg-surface text-foreground rounded-full w-5 h-5 flex items-center justify-center border border-border/50">{{ p.level }}</span>
                </div>
                <div class="flex flex-col min-w-0">
                  <router-link v-if="p.profile_id" :to="{ name: 'player-profile', params: { id: p.profile_id } }"
                               class="font-semibold truncate text-xs leading-tight hover:text-primary transition-colors"
                               :class="p.win ? 'text-foreground' : 'text-muted-foreground'">
                    {{ playerDisplayName(p) }}
                  </router-link>
                  <span v-else class="font-semibold truncate text-xs leading-tight" :class="p.win ? 'text-foreground' : 'text-muted-foreground'">{{ playerDisplayName(p) }}</span>
                  <span class="text-[10px] text-muted-foreground/70 leading-tight">{{ dota.heroName(p.hero_id) }}</span>
                </div>
              </div>
            </td>
            <!-- Position -->
            <td class="text-center px-0.5">
              <PositionIcon v-if="playerPositions?.[p.account_id]" :position="playerPositions[p.account_id]" />
            </td>
            <!-- KDA -->
            <td class="text-center px-1.5 font-mono font-medium whitespace-nowrap">
              <span class="text-green-500">{{ p.kills }}</span><span class="text-muted-foreground">/</span><span class="text-red-400">{{ p.deaths }}</span><span class="text-muted-foreground">/</span><span>{{ p.assists }}</span>
            </td>
            <td class="text-center px-1 font-mono whitespace-nowrap">{{ p.last_hits }}<span class="text-muted-foreground">/</span>{{ p.denies }}</td>
            <td class="text-center px-1 font-mono font-medium text-amber-500">{{ (p.net_worth / 1000).toFixed(1) }}k</td>
            <td class="text-center px-1 font-mono whitespace-nowrap">{{ p.gpm }}<span class="text-muted-foreground">/</span>{{ p.xpm }}</td>
            <!-- Items -->
            <td class="py-1 px-1.5 whitespace-nowrap">
              <div class="inline-flex flex-col gap-px">
                <div class="flex gap-px">
                  <template v-for="(itemId, idx) in [p.item_0, p.item_1, p.item_2]" :key="'t-' + idx">
                    <img v-if="itemId && dota.itemImg(itemId)" :src="dota.itemImg(itemId)" :title="dota.itemName(itemId)" class="w-[36px] h-[27px] rounded-[2px] object-cover border border-border/20" />
                    <div v-else class="w-[36px] h-[27px] rounded-[2px] bg-surface/60 border border-border/10"></div>
                  </template>
                  <img v-if="p.item_neutral && dota.itemImg(p.item_neutral)" :src="dota.itemImg(p.item_neutral)" :title="dota.itemName(p.item_neutral)"
                       class="w-[27px] h-[27px] rounded-full object-cover border border-amber-500/30 ml-1" />
                </div>
                <div class="flex gap-px">
                  <template v-for="(itemId, idx) in [p.item_3, p.item_4, p.item_5]" :key="'b-' + idx">
                    <img v-if="itemId && dota.itemImg(itemId)" :src="dota.itemImg(itemId)" :title="dota.itemName(itemId)" class="w-[36px] h-[27px] rounded-[2px] object-cover border border-border/20" />
                    <div v-else class="w-[36px] h-[27px] rounded-[2px] bg-surface/60 border border-border/10"></div>
                  </template>
                  <template v-for="(itemId, idx) in [p.backpack_0, p.backpack_1, p.backpack_2]" :key="'bp-' + idx">
                    <img v-if="itemId && dota.itemImg(itemId)" :src="dota.itemImg(itemId)" :title="dota.itemName(itemId)" class="w-[27px] h-[21px] rounded-[1px] object-cover border border-border/10 opacity-40 ml-px" />
                  </template>
                </div>
              </div>
            </td>
            <td class="text-center px-1 font-mono">{{ (p.hero_damage / 1000).toFixed(1) }}k</td>
            <td class="text-center px-1 font-mono">{{ (p.tower_damage / 1000).toFixed(1) }}k</td>
            <td class="text-center px-1 font-mono">{{ (p.hero_healing / 1000).toFixed(1) }}k</td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
