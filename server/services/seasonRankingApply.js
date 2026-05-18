// Apply a completed queue match to a season's rankings.
//
// One transaction per match: read everyone's current points, compute deltas
// (via the pure rating module), insert season_match_log rows, upsert
// season_rankings. Idempotent — if season_match_log already has rows for
// this queue_match_id, we no-op.
//
// Caller is expected to have queue_matches.season_id set; if it's NULL we
// don't touch rankings.

import pool, { query, queryOne, execute } from '../db.js'
import { computeDelta, clampPoints, teamAvgMmr, withDefaults, mmrDiffBonus, winstreakBonus } from './seasonRating.js'

export async function applyMatchToSeason({
  queueMatchId,
  seasonId,
  poolId,
  team1PlayerIds,
  team2PlayerIds,
  winnerTeam, // 1 or 2
  // Optional per-player leaver info. Map/object keyed by playerId, value
  // { leaveMinute: number }. Until the bot reports leaver state this is
  // omitted and the formula degrades to no-leaver behaviour.
  leaverByPid,
}) {
  if (!seasonId || !queueMatchId) return { skipped: 'no season' }
  if (winnerTeam !== 1 && winnerTeam !== 2) return { skipped: 'no winner' }
  if (!team1PlayerIds?.length || !team2PlayerIds?.length) return { skipped: 'empty teams' }

  const leaverInfo = (() => {
    if (!leaverByPid) return null
    if (leaverByPid instanceof Map) return leaverByPid
    return new Map(Object.entries(leaverByPid).map(([k, v]) => [Number(k), v]))
  })()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Idempotency: already applied?
    const existing = await client.query(
      'SELECT 1 FROM season_match_log WHERE queue_match_id = $1 LIMIT 1',
      [queueMatchId]
    )
    if (existing.rows.length) {
      await client.query('COMMIT')
      return { skipped: 'already applied' }
    }

    const season = (await client.query(
      'SELECT settings FROM seasons WHERE id = $1',
      [seasonId]
    )).rows[0]
    if (!season) {
      await client.query('ROLLBACK')
      return { skipped: 'season not found' }
    }
    const settings = withDefaults(season.settings || {})

    // Inhouse settings come from the pool; if poolId wasn't passed, look it
    // up via queue_matches. A NULL pool or inhouse_enabled=false means we
    // skip the inhouse formula and behave exactly like the legacy path.
    let inhousePool = null
    if (poolId) {
      inhousePool = (await client.query('SELECT * FROM queue_pools WHERE id = $1', [poolId])).rows[0] || null
    } else {
      const qm = (await client.query('SELECT pool_id FROM queue_matches WHERE id = $1', [queueMatchId])).rows[0]
      if (qm?.pool_id) inhousePool = (await client.query('SELECT * FROM queue_pools WHERE id = $1', [qm.pool_id])).rows[0] || null
    }
    const inhouse = !!inhousePool?.inhouse_enabled
    const isFriday = new Date().getDay() === 5

    // Pull MMR + winstreak for everyone in both teams.
    const allIds = [...new Set([...team1PlayerIds, ...team2PlayerIds])]
    const playerRows = (await client.query(
      'SELECT id, mmr, toxic_strikes, toxic_clean_games_since_last_strike FROM players WHERE id = ANY($1::int[])',
      [allIds]
    )).rows
    const mmrById = Object.fromEntries(playerRows.map(r => [r.id, Number(r.mmr) || 0]))
    const playerById = Object.fromEntries(playerRows.map(r => [r.id, r]))

    const rankingRows = (await client.query(
      'SELECT player_id, points, peak_points, games_played, wins, losses, current_winstreak, peak_winstreak FROM season_rankings WHERE season_id = $1 AND player_id = ANY($2::int[])',
      [seasonId, allIds]
    )).rows
    const rankById = Object.fromEntries(rankingRows.map(r => [r.player_id, r]))

    // Did either team have a player leave before the grace minute? Drives
    // the "teammate cushion" — losers on a team with an early leaver get
    // their loss halved.
    const graceMin = Number(inhousePool?.leaver_grace_minutes ?? 15)
    function teamHasEarlyLeaver(pids) {
      if (!leaverInfo) return false
      for (const pid of pids) {
        const info = leaverInfo.get(pid)
        if (info && Number(info.leaveMinute) < graceMin) return true
      }
      return false
    }
    const team1EarlyLeaver = teamHasEarlyLeaver(team1PlayerIds)
    const team2EarlyLeaver = teamHasEarlyLeaver(team2PlayerIds)

    // Team strength input — either real Dota MMR or season points. Using points
    // makes the season fully self-contained; using MMR keeps the calc anchored
    // to actual skill from match #1 of the season.
    const strengthFor = (pid) => settings.strength_basis === 'points'
      ? (rankById[pid] ? Number(rankById[pid].points) : settings.starting_points)
      : (mmrById[pid] || 0)
    const team1Avg = teamAvgMmr(team1PlayerIds.map(strengthFor))
    const team2Avg = teamAvgMmr(team2PlayerIds.map(strengthFor))

    const updates = []
    const log = []

    function buildSide(playerIds, ownTeam, won) {
      const teamAvg = ownTeam === 1 ? team1Avg : team2Avg
      const oppAvg  = ownTeam === 1 ? team2Avg : team1Avg
      const teamHadEarlyLeaver = ownTeam === 1 ? team1EarlyLeaver : team2EarlyLeaver
      for (const pid of playerIds) {
        const row = rankById[pid]
        const before = row ? Number(row.points) : settings.starting_points
        const streakBefore = row ? Number(row.current_winstreak || 0) : 0
        const peakStreakBefore = row ? Number(row.peak_winstreak || 0) : 0

        const isLeaver = !!(leaverInfo && leaverInfo.get(pid))
        const leaveMinute = isLeaver ? Number(leaverInfo.get(pid).leaveMinute) : null

        let rawDelta
        let expected = null, kUsed = null
        let fridayBonusAccrued = 0
        if (inhouse && isLeaver) {
          // Leaver penalty overrides the entire delta per spec.
          rawDelta = Number(inhousePool.leaver_penalty ?? -50)
        } else {
          const base = computeDelta({
            teamAvgMmr: teamAvg,
            oppAvgMmr:  oppAvg,
            won,
            settings,
          })
          expected = base.expected
          kUsed = base.kUsed
          rawDelta = base.delta
          if (inhouse) {
            rawDelta += mmrDiffBonus({
              myAvgMmr: teamAvg,
              oppAvgMmr: oppAvg,
              won,
              tiers: inhousePool.mmr_diff_tiers || [],
            })
            if (won) {
              rawDelta += winstreakBonus(streakBefore + 1, inhousePool.winstreak_tiers || [])
              if (isFriday) {
                const fwb = Number(inhousePool.friday_win_bonus ?? 5)
                rawDelta += fwb
                fridayBonusAccrued += fwb
              }
            } else if (teamHadEarlyLeaver) {
              // Teammate cushion: a survivor on a losing team with an early
              // leaver only takes half the hit. Wins or leavers themselves
              // are unaffected.
              rawDelta = Math.round(rawDelta * 0.5)
            }
          }
        }

        const after = clampPoints(before + rawDelta, settings)
        const realDelta = after - before
        const newStreak = isLeaver ? 0 : (won ? streakBefore + 1 : 0)
        const newPeakStreak = Math.max(peakStreakBefore, newStreak)
        updates.push({
          pid,
          before,
          after,
          delta: realDelta,
          won,
          isLeaver,
          newStreak,
          newPeakStreak,
          isNew: !row,
          peakBefore: row ? Number(row.peak_points) : settings.starting_points,
          gamesBefore: row ? row.games_played : 0,
          winsBefore:  row ? row.wins         : 0,
          lossesBefore:row ? row.losses       : 0,
        })
        log.push({
          pid,
          team: ownTeam,
          won,
          before,
          after,
          delta: realDelta,
          teamAvg,
          oppAvg,
          expected,
          kUsed,
          wasLeaver: isLeaver,
          leaveMinute,
          fridayBonusApplied: fridayBonusAccrued,
        })
      }
    }
    buildSide(team1PlayerIds, 1, winnerTeam === 1)
    buildSide(team2PlayerIds, 2, winnerTeam === 2)

    // Upsert rankings.
    for (const u of updates) {
      const newPeak = Math.max(u.peakBefore, u.after)
      const newGames  = u.gamesBefore + 1
      const newWins   = u.winsBefore   + (u.won ? 1 : 0)
      const newLosses = u.lossesBefore + (u.won ? 0 : 1)
      await client.query(`
        INSERT INTO season_rankings (
          season_id, player_id, points, peak_points,
          games_played, wins, losses, last_match_at,
          current_winstreak, peak_winstreak
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $10, $11)
        ON CONFLICT (season_id, player_id) DO UPDATE
          SET points            = EXCLUDED.points,
              peak_points       = GREATEST(season_rankings.peak_points, EXCLUDED.points),
              games_played      = season_rankings.games_played + 1,
              wins              = season_rankings.wins   + ($8::int),
              losses            = season_rankings.losses + ($9::int),
              last_match_at     = NOW(),
              current_winstreak = $10,
              peak_winstreak    = GREATEST(season_rankings.peak_winstreak, $10)
      `, [
        seasonId, u.pid, u.after, newPeak,
        newGames, newWins, newLosses,
        u.won ? 1 : 0, u.won ? 0 : 1,
        u.newStreak, u.newPeakStreak,
      ])
    }

    // Audit log.
    for (const l of log) {
      await client.query(`
        INSERT INTO season_match_log (
          season_id, queue_match_id, player_id, team, won,
          points_before, points_after, delta,
          team_avg_mmr, opponent_avg_mmr, expected_win, k_used,
          was_leaver, leave_minute, friday_bonus_applied
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `, [
        seasonId, queueMatchId, l.pid, l.team, l.won,
        l.before, l.after, l.delta,
        l.teamAvg, l.oppAvg, l.expected, l.kUsed,
        !!l.wasLeaver, l.leaveMinute, l.fridayBonusApplied || 0,
      ])
    }

    // Inhouse clean-games decay: a player serving toxic strikes shaves one
    // off after `clean_games_to_decay_strike` strike-free matches in a row.
    // Leavers don't count as "clean". The counter lives on players (not
    // season-scoped) since strikes themselves are global.
    if (inhouse) {
      const decayN = Math.max(1, Number(inhousePool.clean_games_to_decay_strike ?? 5))
      for (const u of updates) {
        const pr = playerById[u.pid]
        if (!pr || (pr.toxic_strikes | 0) <= 0) continue
        if (u.isLeaver) continue
        const prevCount = pr.toxic_clean_games_since_last_strike | 0
        const nextCount = prevCount + 1
        if (nextCount >= decayN) {
          await client.query(
            `UPDATE players SET toxic_strikes = GREATEST(0, toxic_strikes - 1), toxic_clean_games_since_last_strike = 0 WHERE id = $1`,
            [u.pid]
          )
          await client.query(
            `INSERT INTO inhouse_strike_log (player_id, kind, delta, reason, source_queue_match_id) VALUES ($1, 'toxic_decay', -1, $2, $3)`,
            [u.pid, `Decayed after ${decayN} clean games`, queueMatchId]
          )
        } else {
          await client.query(
            `UPDATE players SET toxic_clean_games_since_last_strike = $1 WHERE id = $2`,
            [nextCount, u.pid]
          )
        }
      }
    }

    await client.query('COMMIT')
    return { applied: updates.length, team1Avg, team2Avg }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}

// Wipe rankings and replay every completed queue_match (and manual adjust)
// in this season under the season's *current* settings. Returns { players, events }.
//
// Used by the admin Recompute button and by the Backfill flow after it claims
// past matches into the season.
export async function recomputeSeasonFromHistory(seasonId) {
  const s = await queryOne('SELECT id, settings FROM seasons WHERE id = $1', [seasonId])
  if (!s) throw new Error('season not found')
  const cfg = withDefaults(s.settings || {})

  await execute('DELETE FROM season_rankings WHERE season_id = $1', [seasonId])

  const matches = await query(`
    SELECT qm.id, qm.team1_players, qm.team2_players, qm.pool_id,
           (SELECT winner_captain_id FROM matches WHERE id = qm.match_id) AS winner_captain_id,
           qm.captain1_player_id, qm.captain2_player_id, qm.completed_at,
           qp.inhouse_enabled, qp.mmr_diff_tiers, qp.winstreak_tiers, qp.friday_win_bonus
    FROM queue_matches qm
    LEFT JOIN queue_pools qp ON qp.id = qm.pool_id
    WHERE qm.season_id = $1 AND qm.status = 'completed'
    ORDER BY qm.completed_at ASC NULLS LAST, qm.id ASC
  `, [seasonId])

  // Wipe match-derived audit rows; preserve manual adjusts and re-insert in order.
  const manualAdjusts = await query(`
    SELECT id, player_id, delta, reason, created_at, created_by
    FROM season_match_log
    WHERE season_id = $1 AND queue_match_id IS NULL
    ORDER BY created_at ASC, id ASC
  `, [seasonId])
  await execute('DELETE FROM season_match_log WHERE season_id = $1', [seasonId])

  const points = new Map()
  const stats  = new Map()
  const streaks = new Map()       // pid -> current_winstreak
  const peakStreaks = new Map()   // pid -> peak_winstreak
  const getPts = (pid) => points.has(pid) ? points.get(pid) : cfg.starting_points
  const getStreak = (pid) => streaks.get(pid) || 0
  const bumpStats = (pid, won, newPts) => {
    const cur = stats.get(pid) || { games: 0, wins: 0, losses: 0, peak: cfg.starting_points }
    cur.games++; if (won) cur.wins++; else cur.losses++
    if (newPts > cur.peak) cur.peak = newPts
    stats.set(pid, cur)
    const newStreak = won ? getStreak(pid) + 1 : 0
    streaks.set(pid, newStreak)
    peakStreaks.set(pid, Math.max(peakStreaks.get(pid) || 0, newStreak))
  }

  // Pull MMR for every player we'll touch.
  const allIdsSet = new Set()
  for (const m of matches) {
    for (const p of (m.team1_players || [])) allIdsSet.add(p.playerId)
    for (const p of (m.team2_players || [])) allIdsSet.add(p.playerId)
  }
  const mmrRows = allIdsSet.size
    ? (await query('SELECT id, mmr FROM players WHERE id = ANY($1::int[])', [[...allIdsSet]]))
    : []
  const mmrById = Object.fromEntries(mmrRows.map(r => [r.id, Number(r.mmr) || 0]))

  // Merge matches and adjusts in time order so they apply correctly.
  const events = [
    ...matches.map(m => ({ kind: 'match', when: m.completed_at, data: m })),
    ...manualAdjusts.map(a => ({ kind: 'adjust', when: a.created_at, data: a })),
  ].sort((a, b) => new Date(a.when || 0) - new Date(b.when || 0))

  for (const ev of events) {
    if (ev.kind === 'match') {
      const m = ev.data
      const t1 = (m.team1_players || []).map(p => p.playerId)
      const t2 = (m.team2_players || []).map(p => p.playerId)
      const team1Won = !!m.winner_captain_id && m.winner_captain_id === m.captain1_player_id
      const team2Won = !!m.winner_captain_id && m.winner_captain_id === m.captain2_player_id
      if (!team1Won && !team2Won) continue
      // Strength input: when basis = 'points', use the running points map at
      // this point in time (so each match sees the standings as they were).
      const strengthFor = (pid) => cfg.strength_basis === 'points' ? getPts(pid) : (mmrById[pid] || 0)
      const t1Avg = teamAvgMmr(t1.map(strengthFor))
      const t2Avg = teamAvgMmr(t2.map(strengthFor))
      // Inhouse bonuses on replay: MMR-diff, winstreak, Friday win bonus.
      // Leaver penalty + teammate cushion CANNOT be replayed (the bot's
      // leaver state isn't snapshotted on queue_matches), so recompute
      // diverges from the live path by that amount when an inhouse match
      // had a leaver. Acceptable for an admin diagnostic — re-apply via a
      // future manual adjust if absolute parity is needed.
      const inhouseHere = !!m.inhouse_enabled
      const matchIsFriday = m.completed_at ? new Date(m.completed_at).getDay() === 5 : false
      for (const pid of t1) {
        const before = getPts(pid)
        const { delta, expected, kUsed } = computeDelta({ teamAvgMmr: t1Avg, oppAvgMmr: t2Avg, won: team1Won, settings: cfg })
        let bonus = 0
        if (inhouseHere) {
          bonus += mmrDiffBonus({ myAvgMmr: t1Avg, oppAvgMmr: t2Avg, won: team1Won, tiers: m.mmr_diff_tiers || [] })
          if (team1Won) {
            bonus += winstreakBonus(getStreak(pid) + 1, m.winstreak_tiers || [])
            if (matchIsFriday) bonus += Number(m.friday_win_bonus ?? 5)
          }
        }
        const after = clampPoints(before + delta + bonus, cfg)
        points.set(pid, after); bumpStats(pid, team1Won, after)
        await execute(`
          INSERT INTO season_match_log (season_id, queue_match_id, player_id, team, won,
            points_before, points_after, delta, team_avg_mmr, opponent_avg_mmr, expected_win, k_used, created_at)
          VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, NOW()))
        `, [seasonId, m.id, pid, team1Won, before, after, after - before, t1Avg, t2Avg, expected, kUsed, m.completed_at])
      }
      for (const pid of t2) {
        const before = getPts(pid)
        const { delta, expected, kUsed } = computeDelta({ teamAvgMmr: t2Avg, oppAvgMmr: t1Avg, won: team2Won, settings: cfg })
        let bonus = 0
        if (inhouseHere) {
          bonus += mmrDiffBonus({ myAvgMmr: t2Avg, oppAvgMmr: t1Avg, won: team2Won, tiers: m.mmr_diff_tiers || [] })
          if (team2Won) {
            bonus += winstreakBonus(getStreak(pid) + 1, m.winstreak_tiers || [])
            if (matchIsFriday) bonus += Number(m.friday_win_bonus ?? 5)
          }
        }
        const after = clampPoints(before + delta + bonus, cfg)
        points.set(pid, after); bumpStats(pid, team2Won, after)
        await execute(`
          INSERT INTO season_match_log (season_id, queue_match_id, player_id, team, won,
            points_before, points_after, delta, team_avg_mmr, opponent_avg_mmr, expected_win, k_used, created_at)
          VALUES ($1,$2,$3,2,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, NOW()))
        `, [seasonId, m.id, pid, team2Won, before, after, after - before, t2Avg, t1Avg, expected, kUsed, m.completed_at])
      }
    } else {
      const a = ev.data
      const pid = a.player_id
      const before = getPts(pid)
      const after = clampPoints(before + Number(a.delta), cfg)
      points.set(pid, after)
      const cur = stats.get(pid) || { games: 0, wins: 0, losses: 0, peak: cfg.starting_points }
      if (after > cur.peak) cur.peak = after
      stats.set(pid, cur)
      await execute(`
        INSERT INTO season_match_log (season_id, queue_match_id, player_id, team, won,
          points_before, points_after, delta, reason, created_by, created_at)
        VALUES ($1, NULL, $2, NULL, NULL, $3, $4, $5, $6, $7, $8)
      `, [seasonId, pid, before, after, after - before, a.reason || null, a.created_by || null, a.created_at])
    }
  }

  for (const [pid, pts] of points.entries()) {
    const st = stats.get(pid) || { games: 0, wins: 0, losses: 0, peak: cfg.starting_points }
    await execute(`
      INSERT INTO season_rankings (season_id, player_id, points, peak_points, games_played, wins, losses, last_match_at, current_winstreak, peak_winstreak)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)
      ON CONFLICT (season_id, player_id) DO UPDATE SET
        points = EXCLUDED.points, peak_points = EXCLUDED.peak_points,
        games_played = EXCLUDED.games_played, wins = EXCLUDED.wins, losses = EXCLUDED.losses,
        last_match_at = EXCLUDED.last_match_at,
        current_winstreak = EXCLUDED.current_winstreak,
        peak_winstreak = EXCLUDED.peak_winstreak
    `, [seasonId, pid, pts, st.peak, st.games, st.wins, st.losses, getStreak(pid), peakStreaks.get(pid) || 0])
  }

  return { players: points.size, events: events.length }
}

// Claim past completed queue matches in pools assigned to this season.
// Sets queue_matches.season_id = $seasonId where it was previously NULL.
// Optionally restricted by the season's starts_at / ends_at window.
// Returns the number of rows updated.
export async function backfillSeasonFromPoolHistory(seasonId) {
  const season = await queryOne('SELECT id, starts_at, ends_at FROM seasons WHERE id = $1', [seasonId])
  if (!season) throw new Error('season not found')
  const params = [seasonId]
  let where = `qm.season_id IS NULL
               AND qm.status = 'completed'
               AND qm.pool_id IN (SELECT id FROM queue_pools WHERE season_id = $1)`
  if (season.starts_at) { params.push(season.starts_at); where += ` AND qm.completed_at >= $${params.length}` }
  if (season.ends_at)   { params.push(season.ends_at);   where += ` AND qm.completed_at <= $${params.length}` }
  const updated = await query(`
    UPDATE queue_matches qm SET season_id = $1
    WHERE ${where}
    RETURNING qm.id
  `, params)
  return updated.length
}

// Manual admin point adjustment. Writes a single audit-log row with
// queue_match_id = NULL plus the upserted ranking.
export async function adjustPlayerPoints({ seasonId, playerId, delta, reason, adminPlayerId }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const season = (await client.query('SELECT settings FROM seasons WHERE id = $1', [seasonId])).rows[0]
    if (!season) { await client.query('ROLLBACK'); throw new Error('season not found') }
    const settings = withDefaults(season.settings || {})
    const row = (await client.query(
      'SELECT points, peak_points FROM season_rankings WHERE season_id = $1 AND player_id = $2',
      [seasonId, playerId]
    )).rows[0]
    const before = row ? Number(row.points) : settings.starting_points
    const after = clampPoints(before + Number(delta), settings)
    const peak = Math.max(row ? Number(row.peak_points) : settings.starting_points, after)
    await client.query(`
      INSERT INTO season_rankings (season_id, player_id, points, peak_points, games_played, wins, losses, last_match_at)
      VALUES ($1, $2, $3, $4, 0, 0, 0, NULL)
      ON CONFLICT (season_id, player_id) DO UPDATE SET points = EXCLUDED.points, peak_points = GREATEST(season_rankings.peak_points, EXCLUDED.points)
    `, [seasonId, playerId, after, peak])
    await client.query(`
      INSERT INTO season_match_log (
        season_id, queue_match_id, player_id, team, won,
        points_before, points_after, delta, reason, created_by
      ) VALUES ($1, NULL, $2, NULL, NULL, $3, $4, $5, $6, $7)
    `, [seasonId, playerId, before, after, after - before, reason || null, adminPlayerId || null])
    await client.query('COMMIT')
    return { before, after, delta: after - before }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}
