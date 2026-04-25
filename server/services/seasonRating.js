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
