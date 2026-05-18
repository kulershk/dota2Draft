// Pure ELO math for season rankings. No DB, no side effects — easy to unit-test.
//
// Inputs: each team's average MMR, the per-season settings (k_win, k_loss,
// mmr_scale). Output: each player's point delta plus the expected-win figure
// used to compute it.

export const SEASON_DEFAULTS = Object.freeze({
  starting_points: 1000,
  k_win: 30,
  k_loss: 15,
  mmr_scale: 1500,
  min_points: 0,
  max_points: null,
  min_games_for_leaderboard: 5,
  // 'mmr'    — team strength = avg of players.mmr (default; uses real Dota skill)
  // 'points' — team strength = avg of season_rankings.points (self-contained;
  //            new players use starting_points until they have a rating)
  strength_basis: 'mmr',
})

export function withDefaults(settings) {
  return { ...SEASON_DEFAULTS, ...(settings || {}) }
}

// Standard ELO win-probability curve, but with a configurable scale so we can
// match Dota MMR ranges (chess uses 400; Dota MMR fits ~1500 better — a 1500
// gap means roughly 91% expected for the higher team).
export function expectedWin(teamAvgMmr, oppAvgMmr, scale) {
  const s = scale || SEASON_DEFAULTS.mmr_scale
  return 1 / (1 + Math.pow(10, (oppAvgMmr - teamAvgMmr) / s))
}

// Compute a single player's delta. Asymmetric K so wins can be larger than
// losses (max gain = k_win, max loss = k_loss).
export function computeDelta({ teamAvgMmr, oppAvgMmr, won, settings }) {
  const cfg = withDefaults(settings)
  const expected = expectedWin(teamAvgMmr, oppAvgMmr, cfg.mmr_scale)
  const delta = won
    ? cfg.k_win * (1 - expected)
    : -cfg.k_loss * expected
  return { delta, expected, kUsed: won ? cfg.k_win : cfg.k_loss }
}

// Clamp helper for applying min/max to a candidate points value.
export function clampPoints(points, settings) {
  const cfg = withDefaults(settings)
  let p = points
  if (cfg.min_points != null && p < cfg.min_points) p = cfg.min_points
  if (cfg.max_points != null && p > cfg.max_points) p = cfg.max_points
  return p
}

export function teamAvgMmr(playerMmrs) {
  if (!playerMmrs?.length) return 0
  const valid = playerMmrs.filter(m => Number.isFinite(m) && m > 0)
  if (!valid.length) return 0
  return Math.round(valid.reduce((s, m) => s + m, 0) / valid.length)
}

// ─── Inhouse bonuses (pure) ──────────────────────────────────
// Underdog bonus: when an outmatched team wins they earn a tier-based bump;
// when a favoured team loses they take a symmetric extra hit. The favoured-
// side win and underdog-side loss earn nothing extra — base ELO already
// accounts for the expected outcome. tiers: [{min,max,bonus}].
export function mmrDiffBonus({ myAvgMmr, oppAvgMmr, won, tiers }) {
  if (!Array.isArray(tiers) || !tiers.length) return 0
  const diff = Math.abs(Number(oppAvgMmr) - Number(myAvgMmr))
  const tier = tiers.find(t => diff >= Number(t.min) && diff <= Number(t.max))
  if (!tier) return 0
  const amIUnderdog = Number(myAvgMmr) < Number(oppAvgMmr)
  const bonus = Math.abs(Number(tier.bonus) || 0)
  if (amIUnderdog && won) return bonus
  if (!amIUnderdog && !won) return -bonus
  return 0
}

// Winstreak bonus: highest matching tier wins (so 8+ caps at the top tier).
// `streak` is the streak count AFTER counting this win.
export function winstreakBonus(streak, tiers) {
  const s = Number(streak)
  if (!Array.isArray(tiers) || s <= 0) return 0
  let best = 0
  for (const t of tiers) {
    if (s >= Number(t.streak) && Number(t.bonus) > best) best = Number(t.bonus)
  }
  return best
}
