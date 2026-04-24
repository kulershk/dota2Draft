// Dota 2 medal tier mapping from MMR.
// Each tier is 770 MMR wide (except Immortal, which is open-ended).
// Within a tier, 5 stars (I–V) are spread evenly every 154 MMR.
// Colors match Pencil's tournament-placements palette where applicable.

export type RankTier = 'Herald' | 'Guardian' | 'Crusader' | 'Archon' | 'Legend' | 'Ancient' | 'Divine' | 'Immortal'

export interface RankInfo {
  tier: RankTier
  star: number        // 1..5, or 0 for Immortal
  label: string       // e.g. "Legend IV" or "Immortal"
  color: string       // Tailwind arbitrary-value class for text
  bgClass: string     // badge bg class
  borderClass: string // badge border class
}

const TIERS: { name: RankTier; base: number; color: string; bgClass: string; borderClass: string }[] = [
  { name: 'Herald',   base:    0, color: 'text-[#94A3B8]', bgClass: 'bg-[#94A3B8]/10', borderClass: 'border-[#94A3B8]/30' },
  { name: 'Guardian', base:  770, color: 'text-[#22C55E]', bgClass: 'bg-[#22C55E]/10', borderClass: 'border-[#22C55E]/30' },
  { name: 'Crusader', base: 1540, color: 'text-[#67E8F9]', bgClass: 'bg-[#67E8F9]/10', borderClass: 'border-[#67E8F9]/30' },
  { name: 'Archon',   base: 2310, color: 'text-[#A78BFA]', bgClass: 'bg-[#A78BFA]/10', borderClass: 'border-[#A78BFA]/30' },
  { name: 'Legend',   base: 3080, color: 'text-[#FACC15]', bgClass: 'bg-[#FACC15]/10', borderClass: 'border-[#FACC15]/30' },
  { name: 'Ancient',  base: 3850, color: 'text-[#CBD5E1]', bgClass: 'bg-[#CBD5E1]/10', borderClass: 'border-[#CBD5E1]/30' },
  { name: 'Divine',   base: 4620, color: 'text-[#F47222]', bgClass: 'bg-[#F47222]/10', borderClass: 'border-[#F47222]/30' },
  { name: 'Immortal', base: 5630, color: 'text-[#EF4444]', bgClass: 'bg-[#EF4444]/10', borderClass: 'border-[#EF4444]/30' },
]

const STAR_NUMERALS = ['I', 'II', 'III', 'IV', 'V']

export function mmrToRank(mmr: number | null | undefined): RankInfo | null {
  if (mmr == null || mmr < 0) return null
  // Walk tiers in reverse to find the first whose base is <= mmr.
  for (let i = TIERS.length - 1; i >= 0; i--) {
    const t = TIERS[i]
    if (mmr >= t.base) {
      if (t.name === 'Immortal') {
        return { tier: t.name, star: 0, label: t.name, color: t.color, bgClass: t.bgClass, borderClass: t.borderClass }
      }
      const star = Math.min(5, Math.floor((mmr - t.base) / 154) + 1)
      return {
        tier: t.name,
        star,
        label: `${t.name} ${STAR_NUMERALS[star - 1]}`,
        color: t.color,
        bgClass: t.bgClass,
        borderClass: t.borderClass,
      }
    }
  }
  return null
}
