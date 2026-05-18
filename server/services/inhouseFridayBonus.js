// Inhouse Friday top-3 daily aggregator.
//
// At the end of every Friday in Europe/Riga local time, players who earned
// the most net points across all inhouse matches in a season's pools that
// day collect a flat bonus on top of their normal per-match deltas:
//
//   1st place — pool.friday_top1_bonus (default 12)
//   2nd place — pool.friday_top2_bonus (default  6)
//   3rd place — pool.friday_top3_bonus (default  6)
//
// Ties at a boundary split the combined bonus across the tied players, per
// spec "punkti dalās vienādi". Idempotent via the season_match_log unique
// partial index on (season_id, player_id, DATE(created_at)) WHERE
// reason='friday_top_bonus'.

import pool, { query, queryOne, execute } from '../db.js'
import { clampPoints, withDefaults } from './seasonRating.js'

const TZ = 'Europe/Riga'

// Returns "YYYY-MM-DD" for the given JS Date interpreted in Europe/Riga.
function rigaDateString(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const lookup = Object.fromEntries(parts.map(p => [p.type, p.value]))
  return `${lookup.year}-${lookup.month}-${lookup.day}`
}

// Returns 0..6 (Sun..Sat) for a date interpreted in Europe/Riga.
function rigaWeekday(d) {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(w)
}

// Apply Friday bonuses for one (season_id, friday_date) pair. Uses a single
// transaction so the synthetic season_match_log rows + ranking upserts are
// atomic — idempotency comes from the unique index, not from retry tracking.
export async function applyFridayBonusForSeason(seasonId, fridayDate /* YYYY-MM-DD */) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const season = (await client.query('SELECT id, settings FROM seasons WHERE id = $1', [seasonId])).rows[0]
    if (!season) { await client.query('ROLLBACK'); return { skipped: 'season not found' } }
    const cfg = withDefaults(season.settings || {})

    // One inhouse pool per season is the common case, but a season can host
    // several pools; we pull bonus amounts from any inhouse pool attached to
    // this season. If they disagree, pick the smallest id deterministically.
    const inhousePool = (await client.query(
      `SELECT * FROM queue_pools WHERE season_id = $1 AND inhouse_enabled = TRUE ORDER BY id LIMIT 1`,
      [seasonId]
    )).rows[0]
    if (!inhousePool) { await client.query('ROLLBACK'); return { skipped: 'no inhouse pool' } }

    // Sum net delta per player from match-derived rows on this Friday only.
    // Exclude any prior friday_top_bonus rows (synthetic) — those are the
    // bonus itself, not the ranking input.
    const rows = (await client.query(`
      SELECT player_id, SUM(delta)::float8 AS net_points
        FROM season_match_log
       WHERE season_id = $1
         AND queue_match_id IS NOT NULL
         AND DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Riga') = $2::date
       GROUP BY player_id
       HAVING SUM(delta) > 0
       ORDER BY SUM(delta) DESC
    `, [seasonId, fridayDate])).rows

    if (!rows.length) { await client.query('COMMIT'); return { applied: 0 } }

    // Walk the sorted list and bucket players into slot 1 / 2 / 3 by net
    // points. Ties at a slot pool that slot's prize with the next, and
    // split equally across all tied players.
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
      // Combined prize across however many slots this tie occupies.
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
      // Read current points to compute clamped before/after for the log row
      // and the ranking update.
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

// Run the aggregator for every season that has a Friday's worth of data
// for the given date (defaults to "yesterday" — meaning the just-finished
// Friday for the scheduled run that fires after midnight).
export async function applyFridayBonusAll(fridayDate) {
  const date = fridayDate || rigaDateString(new Date(Date.now() - 24 * 60 * 60 * 1000))
  const seasons = await query(`
    SELECT DISTINCT s.id FROM seasons s
    WHERE EXISTS (SELECT 1 FROM queue_pools qp WHERE qp.season_id = s.id AND qp.inhouse_enabled = TRUE)
  `)
  const results = []
  for (const s of seasons) {
    try { results.push({ seasonId: s.id, ...(await applyFridayBonusForSeason(s.id, date)) }) }
    catch (e) { results.push({ seasonId: s.id, error: e.message }) }
  }
  return { fridayDate: date, results }
}

// In-process scheduler: every 5 minutes check whether we have crossed
// midnight Europe/Riga and the previous day was a Friday; if yes, run the
// aggregator for that Friday's date. The aggregator is idempotent so a
// duplicate trigger from a restart costs nothing.
let _lastRunFor = null
let _interval = null
export function startFridayBonusScheduler() {
  if (_interval) return
  const tick = async () => {
    try {
      const now = new Date()
      const todayDate = rigaDateString(now)
      const yesterdayDate = rigaDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000))
      const yesterdayWasFriday = rigaWeekday(new Date(now.getTime() - 24 * 60 * 60 * 1000)) === 5
      const fireKey = `${todayDate}|${yesterdayDate}`
      if (yesterdayWasFriday && _lastRunFor !== fireKey) {
        await applyFridayBonusAll(yesterdayDate)
        _lastRunFor = fireKey
      }
    } catch (e) {
      console.error('[friday-bonus] scheduler tick failed:', e?.message)
    }
  }
  _interval = setInterval(tick, 5 * 60 * 1000)
  // Run once at startup so a restart doesn't miss a fire.
  tick()
}
