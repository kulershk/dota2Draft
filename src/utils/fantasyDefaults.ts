import type { FantasyScoring } from '@/composables/useDraftStore'

export function getDefaultFantasyScoring(): FantasyScoring {
  return {
    carry:   { kill: 3, death: -3, assist: 0.5, lastHit: 0.02, deny: 0.1, gpm: 0.005, xpm: 0.003, heroDamage: 0.3, towerDamage: 0.5, heroHealing: 0.1, obsPlaced: 0.1, senPlaced: 0.05, obsKilled: 0.5, senKilled: 0.1, campsStacked: 0.2, stuns: 0.01, teamfight: 3, towerKill: 2, roshanKill: 1.5, firstBlood: 3, runePickup: 0.1, tripleKill: 5, ultraKill: 10, rampage: 15, courierKill: 1 },
    mid:     { kill: 3, death: -3, assist: 0.5, lastHit: 0.02, deny: 0.15, gpm: 0.005, xpm: 0.005, heroDamage: 0.4, towerDamage: 0.3, heroHealing: 0.1, obsPlaced: 0.1, senPlaced: 0.05, obsKilled: 0.3, senKilled: 0.1, campsStacked: 0.2, stuns: 0.02, teamfight: 3, towerKill: 1.5, roshanKill: 1, firstBlood: 4, runePickup: 0.3, tripleKill: 5, ultraKill: 10, rampage: 15, courierKill: 1 },
    offlane: { kill: 2, death: -1.5, assist: 1, lastHit: 0.01, deny: 0.1, gpm: 0.003, xpm: 0.003, heroDamage: 0.2, towerDamage: 0.4, heroHealing: 0.2, obsPlaced: 0.15, senPlaced: 0.1, obsKilled: 0.5, senKilled: 0.2, campsStacked: 0.3, stuns: 0.05, teamfight: 4, towerKill: 1.5, roshanKill: 1, firstBlood: 2, runePickup: 0.05, tripleKill: 8, ultraKill: 15, rampage: 25, courierKill: 1 },
    pos4:    { kill: 1.5, death: -1, assist: 1.5, lastHit: 0.005, deny: 0.05, gpm: 0.002, xpm: 0.002, heroDamage: 0.15, towerDamage: 0.1, heroHealing: 0.5, obsPlaced: 0.5, senPlaced: 0.3, obsKilled: 1, senKilled: 0.5, campsStacked: 1, stuns: 0.04, teamfight: 4, towerKill: 0.5, roshanKill: 0.5, firstBlood: 2, runePickup: 0.1, tripleKill: 12, ultraKill: 20, rampage: 40, courierKill: 2 },
    pos5:    { kill: 1, death: -0.5, assist: 2, lastHit: 0.005, deny: 0.05, gpm: 0.002, xpm: 0.002, heroDamage: 0.1, towerDamage: 0.1, heroHealing: 1, obsPlaced: 1, senPlaced: 0.5, obsKilled: 1.5, senKilled: 0.5, campsStacked: 1.5, stuns: 0.03, teamfight: 5, towerKill: 0.5, roshanKill: 0.5, firstBlood: 5, runePickup: 0.05, tripleKill: 15, ultraKill: 25, rampage: 50, courierKill: 2 },
  }
}
