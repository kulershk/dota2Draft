const ranks = [
  { name: 'Herald', min: 0, max: 769, color: 'text-gray-500', icon: 1 },
  { name: 'Guardian', min: 770, max: 1539, color: 'text-gray-400', icon: 2 },
  { name: 'Crusader', min: 1540, max: 2309, color: 'text-emerald-600', icon: 3 },
  { name: 'Archon', min: 2310, max: 3079, color: 'text-sky-500', icon: 4 },
  { name: 'Legend', min: 3080, max: 3849, color: 'text-green-500', icon: 5 },
  { name: 'Ancient', min: 3850, max: 4619, color: 'text-amber-600', icon: 6 },
  { name: 'Divine', min: 4620, max: 5619, color: 'text-yellow-500', icon: 7 },
  { name: 'Immortal', min: 5620, max: Infinity, color: 'text-red-500', icon: 8 },
]

export function getRank(mmr: number) {
  const rank = ranks.findLast(r => mmr >= r.min) || ranks[0]
  if (rank.name === 'Immortal') {
    return { label: 'Immortal', color: rank.color, icon: `/ranks/rank_icon_${rank.icon}.png`, star: null }
  }
  const range = rank.max - rank.min + 1
  const tier = Math.min(5, Math.floor((mmr - rank.min) / (range / 5)) + 1)
  return {
    label: `${rank.name} ${tier}`,
    color: rank.color,
    icon: `/ranks/rank_icon_${rank.icon}.png`,
    star: `/ranks/rank_star_${tier}.png`,
  }
}
