// Inhouse Friday top-3 daily aggregator.
//
// At the end of every Friday window (Europe/Riga, configured per inhouse pool —
// see services/fridayWindow.js), the players who earned the most net points
// across that window's inhouse matches collect a flat bonus on top of their
// normal per-match deltas:
//
//   1st place — pool.friday_top1_bonus (default 12)
//   2nd place — pool.friday_top2_bonus (default  6)
//   3rd place — pool.friday_top3_bonus (default  6)
//
// Ties at a boundary split the combined bonus across the tied players, per
// spec "punkti dalās vienādi". Idempotent via the season_match_log unique
// partial index on (season_id, player_id, DATE(created_at)) WHERE
// reason='friday_top_bonus'. The scheduler runs only on the Saturday a window
// ends, so DATE(created_at) is stable per Friday and can't double-apply.

import pool, { query } from '../db.js'
import { clampPoints, withDefaults } from './seasonRating.js'
import { clampHour, fridayWindowSql, fridayWindowClosed, addDays, rigaParts } from './fridayWindow.js'

// Apply Friday bonuses for one (season_id, friday_date) pair. Uses a single
// transaction so the synthetic season_match_log rows + ranking upserts are
// atomic — idempotency comes from the unique index, not from retry tracking.
//
// `force` bypasses the window-closed guard (used by the admin manual trigger);
// the scheduler always runs guarded so it never finalizes an open window.
export async function applyFridayBonusForSeason(seasonId, fridayDate /* YYYY-MM-DD */, { force = false } = {}) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const season = (await client.query('SELECT id, settings FROM seasons WHERE id = $1', [seasonId])).rows[0]
    if (!season) { await client.query('ROLLBACK'); return { skipped: 'season not found' } }
    const cfg = withDefaults(season.settings || {})

    // One inhouse pool per season is the common case, but a season can host
    // several pools; we pull bonus amounts + the Friday window from any inhouse
    // pool attached to this season. If they disagree, pick the smallest id.
    const inhousePool = (await client.query(
      `SELECT * FROM queue_pools WHERE season_id = $1 AND inhouse_enabled = TRUE ORDER BY id LIMIT 1`,
      [seasonId]
    )).rows[0]
    if (!inhousePool) { await client.query('ROLLBACK'); return { skipped: 'no inhouse pool' } }

    const startHour = clampHour(inhousePool.friday_window_start_hour)
    const endHour = clampHour(inhousePool.friday_window_end_hour)

    // Don't finalize a window that hasn't closed yet — otherwise we'd lock in
    // an incomplete ranking (the idempotent insert would block later updates).
    if (!force && !fridayWindowClosed(fridayDate, endHour)) {
      await client.query('ROLLBACK')
      return { skipped: 'window open', fridayDate }
    }

    // Sum net delta per player from match-derived rows inside this Friday's
    // window only. Exclude prior friday_top_bonus rows (synthetic) — those are
    // the bonus itself, not ranking input.
    const windowExpr = fridayWindowSql('created_at', startHour, endHour)
    const rows = (await client.query(`
      SELECT player_id, SUM(delta)::float8 AS net_points
        FROM season_match_log
       WHERE season_id = $1
         AND queue_match_id IS NOT NULL
         AND (${windowExpr}) = $2::date
       GROUP BY player_id
       HAVING SUM(delta) > 0
       ORDER BY SUM(delta) DESC
    `, [seasonId, fridayDate])).rows

    if (!rows.length) { await client.query('COMMIT'); return { applied: 0, fridayDate } }

    // Walk the sorted list and bucket players into slot 1 / 2 / 3 by net
    // points. Ties at a slot pool that slot's prize with the next, and split
    // equally across all tied players.
    const slots = [
      { name: 1, prize: Number(inhousePool.friday_top1_bonus ?? 12) },
      { name: 2, prize: Number(inhousePool.friday_top2_bonus ?? 6)  },
      { name: 3, prize: Number(inhousePool.friday_top3_bonus ?? 6)  },
    ]
    const awards = new Map() // pid -> bonus
    let slotIdx = 0
    let i = 0
    while (slotIdx < slots.length && i < rows.length) {
      const tiedAt = rows[i].net_points
      const tied = []
      while (i < rows.length && rows[i].net_points === tiedAt) {
        tied.push(rows[i]); i++
      }
      const slotsConsumed = Math.min(tied.length, slots.length - slotIdx)
      let combined = 0
      for (let k = 0; k < slotsConsumed; k++) combined += slots[slotIdx + k].prize
      const perPlayer = tied.length ? (combined / tied.length) : 0
      for (const r of tied) awards.set(r.player_id, perPlayer)
      slotIdx += tied.length
    }

    let appliedCount = 0
    for (const [pid, bonus] of awards) {
      if (!bonus) continue
      const rk = (await client.query(
        `SELECT points, peak_points FROM season_rankings WHERE season_id = $1 AND player_id = $2`,
        [seasonId, pid]
      )).rows[0]
      const before = rk ? Number(rk.points) : cfg.starting_points
      const after = clampPoints(before + bonus, cfg)
      const realDelta = after - before
      const peak = Math.max(rk ? Number(rk.peak_points) : cfg.starting_points, after)

      // The unique partial index blocks a duplicate insert; ON CONFLICT DO
      // NOTHING lets us treat that as a no-op (idempotent re-run).
      const inserted = await client.query(`
        INSERT INTO season_match_log (
          season_id, queue_match_id, player_id, team, won,
          points_before, points_after, delta,
          reason, friday_bonus_applied, created_at
        ) VALUES ($1, NULL, $2, NULL, NULL, $3, $4, $5, 'friday_top_bonus', $6, NOW())
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [seasonId, pid, before, after, realDelta, Math.round(bonus)])
      if (!inserted.rows.length) continue // already awarded today

      await client.query(`
        INSERT INTO season_rankings (season_id, player_id, points, peak_points, games_played, wins, losses, last_match_at)
        VALUES ($1, $2, $3, $4, 0, 0, 0, NOW())
        ON CONFLICT (season_id, player_id) DO UPDATE SET
          points = $3,
          peak_points = GREATEST(season_rankings.peak_points, $3)
      `, [seasonId, pid, after, peak])
      appliedCount++
    }

    await client.query('COMMIT')
    return { applied: appliedCount, fridayDate }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}

// Run the aggregator for every inhouse season for the given Friday date. Each
// season self-skips until its own window has closed, so a too-early call is a
// harmless no-op.
export async function applyFridayBonusAll(fridayDate) {
  if (!fridayDate) return { error: 'fridayDate required' }
  const seasons = await query(`
    SELECT DISTINCT s.id FROM seasons s
    WHERE EXISTS (SELECT 1 FROM queue_pools qp WHERE qp.season_id = s.id AND qp.inhouse_enabled = TRUE)
  `)
  const results = []
  for (const s of seasons) {
    try { results.push({ seasonId: s.id, ...(await applyFridayBonusForSeason(s.id, fridayDate)) }) }
    catch (e) { results.push({ seasonId: s.id, error: e.message }) }
  }
  return { fridayDate, results }
}

// In-process scheduler: every 5 minutes, on the Saturday a Friday window ends
// (Europe/Riga), run the aggregator for that Friday. Each season's apply
// self-skips until its configured window end_hour has passed, and the insert
// is idempotent, so repeated ticks (and restarts) cost nothing. Running only
// on Saturday keeps DATE(created_at) — the idempotency key — stable per Friday.
let _interval = null
export function startFridayBonusScheduler() {
  if (_interval) return
  const tick = async () => {
    try {
      const { date, dow } = rigaParts(new Date())
      if (dow !== 6) return // 6 = Saturday
      await applyFridayBonusAll(addDays(date, -1)) // the Friday that just ended
    } catch (e) {
      console.error('[friday-bonus] scheduler tick failed:', e?.message)
    }
  }
  _interval = setInterval(tick, 5 * 60 * 1000)
  // Run once at startup so a restart doesn't miss a fire.
  tick()
}
