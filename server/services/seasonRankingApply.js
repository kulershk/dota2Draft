// Apply a completed queue match to a season's rankings.
//
// One transaction per match: read everyone's current points, compute deltas
// (via the pure rating module), insert season_match_log rows, upsert
// season_rankings. Idempotent — if season_match_log already has rows for
// this queue_match_id, we no-op.
//
// Caller is expected to have queue_matches.season_id set; if it's NULL we
// don't touch rankings.

import pool from '../db.js'
import { computeDelta, clampPoints, teamAvgMmr, withDefaults } from './seasonRating.js'

export async function applyMatchToSeason({
  queueMatchId,
  seasonId,
  team1PlayerIds,
  team2PlayerIds,
  winnerTeam, // 1 or 2
}) {
  if (!seasonId || !queueMatchId) return { skipped: 'no season' }
  if (winnerTeam !== 1 && winnerTeam !== 2) return { skipped: 'no winner' }
  if (!team1PlayerIds?.length || !team2PlayerIds?.length) return { skipped: 'empty teams' }

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

    // Pull MMR for everyone in both teams + their current ranking row (if any).
    const allIds = [...new Set([...team1PlayerIds, ...team2PlayerIds])]
    const playerRows = (await client.query(
      'SELECT id, mmr FROM players WHERE id = ANY($1::int[])',
      [allIds]
    )).rows
    const mmrById = Object.fromEntries(playerRows.map(r => [r.id, Number(r.mmr) || 0]))

    const rankingRows = (await client.query(
      'SELECT player_id, points, peak_points, games_played, wins, losses FROM season_rankings WHERE season_id = $1 AND player_id = ANY($2::int[])',
      [seasonId, allIds]
    )).rows
    const rankById = Object.fromEntries(rankingRows.map(r => [r.player_id, r]))

    const team1Avg = teamAvgMmr(team1PlayerIds.map(id => mmrById[id] || 0))
    const team2Avg = teamAvgMmr(team2PlayerIds.map(id => mmrById[id] || 0))

    const updates = []
    const log = []

    function buildSide(playerIds, ownTeam, won) {
      const teamAvg = ownTeam === 1 ? team1Avg : team2Avg
      const oppAvg  = ownTeam === 1 ? team2Avg : team1Avg
      for (const pid of playerIds) {
        const row = rankById[pid]
        const before = row ? Number(row.points) : settings.starting_points
        const { delta, expected, kUsed } = computeDelta({
          teamAvgMmr: teamAvg,
          oppAvgMmr:  oppAvg,
          won,
          settings,
        })
        const after = clampPoints(before + delta, settings)
        const realDelta = after - before
        updates.push({
          pid,
          before,
          after,
          delta: realDelta,
          won,
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
          games_played, wins, losses, last_match_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (season_id, player_id) DO UPDATE
          SET points        = EXCLUDED.points,
              peak_points   = GREATEST(season_rankings.peak_points, EXCLUDED.points),
              games_played  = season_rankings.games_played + 1,
              wins          = season_rankings.wins   + ($8::int),
              losses        = season_rankings.losses + ($9::int),
              last_match_at = NOW()
      `, [
        seasonId, u.pid, u.after, newPeak,
        newGames, newWins, newLosses,
        u.won ? 1 : 0, u.won ? 0 : 1,
      ])
    }

    // Audit log.
    for (const l of log) {
      await client.query(`
        INSERT INTO season_match_log (
          season_id, queue_match_id, player_id, team, won,
          points_before, points_after, delta,
          team_avg_mmr, opponent_avg_mmr, expected_win, k_used
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        seasonId, queueMatchId, l.pid, l.team, l.won,
        l.before, l.after, l.delta,
        l.teamAvg, l.oppAvg, l.expected, l.kUsed,
      ])
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
