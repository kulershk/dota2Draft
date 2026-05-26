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
import { isInFridayWindow, fridayWindowSql, clampHour } from './fridayWindow.js'
import { applyFridayBonusForSeason } from './inhouseFridayBonus.js'

// Human-readable breakdown of how a per-match delta was computed, stored in
// season_match_log.reason so the audit log can show the math (base ± bonuses =
// total). Amounts are rounded for display; `realDelta` (the stored total) is
// authoritative, and a `(clamped)` tag appears when min/max points capped it.
function fmtDeltaReason({
  leaverPenalty = null, base = null, staticBase = null, expected = null, kUsed = null,
  mmrDiff = 0, winstreak = 0, winRun = 0, friday = 0, cushion = false,
  rawDelta = 0, realDelta = 0,
}) {
  const sign = (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}`
  const parts = []
  if (leaverPenalty != null) {
    parts.push(`Leaver penalty ${sign(leaverPenalty)}`)
  } else {
    if (staticBase != null) {
      parts.push(`Base ${sign(staticBase)}`)
    } else if (base != null) {
      const meta = []
      if (kUsed != null) meta.push(`K${Math.round(kUsed)}`)
      if (expected != null) meta.push(`exp ${Math.round(expected * 100)}%`)
      parts.push(`ELO ${sign(base)}${meta.length ? ` (${meta.join(', ')})` : ''}`)
    }
    if (mmrDiff) parts.push(`MMR-diff ${sign(mmrDiff)}`)
    if (winstreak) parts.push(`streak ${sign(winstreak)} (run ${winRun})`)
    if (friday) parts.push(`Friday ${sign(friday)}`)
    if (cushion) parts.push('teammate cushion ×0.5')
  }
  let s = `${parts.join(' · ')} = ${sign(realDelta)}`
  if (Math.round(realDelta) !== Math.round(rawDelta)) s += ' (clamped)'
  return s
}

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
    // Friday is the pool's configurable Riga window, evaluated at match-end
    // (now). Falls back to the plain calendar Friday when hours are 0/0.
    const isFriday = isInFridayWindow(new Date(), inhousePool?.friday_window_start_hour, inhousePool?.friday_window_end_hour)

    // Pull MMR + winstreak for everyone in both teams.
    const allIds = [...new Set([...team1PlayerIds, ...team2PlayerIds])]
    const playerRows = (await client.query(
      'SELECT id, mmr, toxic_strikes, toxic_clean_games_since_last_strike, grief_strikes, grief_clean_games_since_last_strike FROM players WHERE id = ANY($1::int[])',
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
        // Signed streak: positive = consecutive wins, negative = losses.
        // winRun is the new win-streak length used for the win bonus (loss
        // streaks never earn a bonus).
        const streakBefore = row ? Number(row.current_winstreak || 0) : 0
        const peakStreakBefore = row ? Number(row.peak_winstreak || 0) : 0
        const winRun = streakBefore >= 0 ? streakBefore + 1 : 1

        const isLeaver = !!(leaverInfo && leaverInfo.get(pid))
        const leaveMinute = isLeaver ? Number(leaverInfo.get(pid).leaveMinute) : null

        let rawDelta
        let expected = null, kUsed = null
        let fridayBonusAccrued = 0
        // Captured for the audit-log breakdown (fmtDeltaReason); no effect on math.
        let baseAmt = null, staticBaseAmt = null, mmrDiffAmt = 0, winstreakAmt = 0
        let cushionApplied = false, leaverPenaltyAmt = null
        if (inhouse && isLeaver) {
          // Leaver penalty overrides the entire delta per spec.
          rawDelta = Number(inhousePool.leaver_penalty ?? -50)
          leaverPenaltyAmt = rawDelta
        } else if (inhouse && inhousePool.use_static_points) {
          // Static-points mode: skip ELO entirely. The flat win/loss
          // numbers become the base, and the same MMR-diff / winstreak /
          // Friday / teammate-cushion bonuses stack on top below.
          staticBaseAmt = won
            ? Number(inhousePool.inhouse_win_points ?? 21)
            : -Number(inhousePool.inhouse_loss_points ?? 19)
          rawDelta = staticBaseAmt
          if (inhouse) {
            mmrDiffAmt = mmrDiffBonus({
              myAvgMmr: teamAvg,
              oppAvgMmr: oppAvg,
              won,
              tiers: inhousePool.mmr_diff_tiers || [],
            })
            rawDelta += mmrDiffAmt
            if (won) {
              winstreakAmt = winstreakBonus(winRun, inhousePool.winstreak_tiers || [])
              rawDelta += winstreakAmt
              if (isFriday) {
                const fwb = Number(inhousePool.friday_win_bonus ?? 5)
                rawDelta += fwb
                fridayBonusAccrued += fwb
              }
            } else if (teamHadEarlyLeaver) {
              rawDelta = Math.round(rawDelta * 0.5)
              cushionApplied = true
            }
          }
        } else {
          const base = computeDelta({
            teamAvgMmr: teamAvg,
            oppAvgMmr:  oppAvg,
            won,
            settings,
          })
          expected = base.expected
          kUsed = base.kUsed
          baseAmt = base.delta
          rawDelta = base.delta
          if (inhouse) {
            mmrDiffAmt = mmrDiffBonus({
              myAvgMmr: teamAvg,
              oppAvgMmr: oppAvg,
              won,
              tiers: inhousePool.mmr_diff_tiers || [],
            })
            rawDelta += mmrDiffAmt
            if (won) {
              winstreakAmt = winstreakBonus(winRun, inhousePool.winstreak_tiers || [])
              rawDelta += winstreakAmt
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
              cushionApplied = true
            }
          }
        }

        const after = clampPoints(before + rawDelta, settings)
        const realDelta = after - before
        // Signed: a win extends/starts a win streak (+), a loss extends/
        // starts a loss streak (−). peak_winstreak tracks the best positive
        // run only.
        const newStreak = won
          ? (streakBefore >= 0 ? streakBefore + 1 : 1)
          : (streakBefore <= 0 ? streakBefore - 1 : -1)
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
          reason: fmtDeltaReason({
            leaverPenalty: leaverPenaltyAmt, base: baseAmt, staticBase: staticBaseAmt,
            expected, kUsed, mmrDiff: mmrDiffAmt, winstreak: winstreakAmt, winRun,
            friday: fridayBonusAccrued, cushion: cushionApplied, rawDelta, realDelta,
          }),
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
          was_leaver, leave_minute, friday_bonus_applied, reason
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `, [
        seasonId, queueMatchId, l.pid, l.team, l.won,
        l.before, l.after, l.delta,
        l.teamAvg, l.oppAvg, l.expected, l.kUsed,
        !!l.wasLeaver, l.leaveMinute, l.fridayBonusApplied || 0, l.reason || null,
      ])
    }

    // Inhouse clean-games decay: a player serving strikes shaves one off after
    // `clean_games_to_decay_strike` strike-free matches in a row. Toxic and
    // grief strikes decay independently, each with its own clean-games counter.
    // Leavers don't count as "clean". Counters live on players (not
    // season-scoped) since strikes themselves are global. Column names below
    // are a fixed all-list, never user input — safe to interpolate.
    if (inhouse) {
      const decayN = Math.max(1, Number(inhousePool.clean_games_to_decay_strike ?? 5))
      const DECAY_KINDS = [
        { strikes: 'toxic_strikes', clean: 'toxic_clean_games_since_last_strike', logKind: 'toxic_decay' },
        { strikes: 'grief_strikes', clean: 'grief_clean_games_since_last_strike', logKind: 'grief_decay' },
      ]
      for (const u of updates) {
        if (u.isLeaver) continue
        const pr = playerById[u.pid]
        if (!pr) continue
        for (const k of DECAY_KINDS) {
          if ((pr[k.strikes] | 0) <= 0) continue
          const nextCount = (pr[k.clean] | 0) + 1
          if (nextCount >= decayN) {
            await client.query(
              `UPDATE players SET ${k.strikes} = GREATEST(0, ${k.strikes} - 1), ${k.clean} = 0 WHERE id = $1`,
              [u.pid]
            )
            await client.query(
              `INSERT INTO inhouse_strike_log (player_id, kind, delta, reason, source_queue_match_id) VALUES ($1, $2, -1, $3, $4)`,
              [u.pid, k.logKind, `Decayed after ${decayN} clean games`, queueMatchId]
            )
          } else {
            await client.query(
              `UPDATE players SET ${k.clean} = $1 WHERE id = $2`,
              [nextCount, u.pid]
            )
          }
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
           qp.inhouse_enabled, qp.mmr_diff_tiers, qp.winstreak_tiers, qp.friday_win_bonus,
           qp.friday_window_start_hour, qp.friday_window_end_hour,
           qp.use_static_points, qp.inhouse_win_points, qp.inhouse_loss_points
    FROM queue_matches qm
    LEFT JOIN queue_pools qp ON qp.id = qm.pool_id
    WHERE qm.season_id = $1 AND qm.status = 'completed'
    ORDER BY qm.completed_at ASC NULLS LAST, qm.id ASC
  `, [seasonId])

  // Wipe match-derived audit rows; preserve genuine manual adjusts and re-insert
  // in order. Friday top-3 bonus rows are EXCLUDED here on purpose — they are
  // re-derived from the rebuilt match history below under current logic, never
  // replayed at their stale stored delta.
  const manualAdjusts = await query(`
    SELECT id, player_id, delta, reason, created_at, created_by
    FROM season_match_log
    WHERE season_id = $1 AND queue_match_id IS NULL
      AND reason IS DISTINCT FROM 'friday_top_bonus'
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
    // Signed streak (see live path): + win run, − loss run.
    const cs = getStreak(pid)
    const newStreak = won ? (cs >= 0 ? cs + 1 : 1) : (cs <= 0 ? cs - 1 : -1)
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
      const matchIsFriday = m.completed_at
        ? isInFridayWindow(m.completed_at, m.friday_window_start_hour, m.friday_window_end_hour)
        : false
      // Compute the base delta for one player on a given side. Mirrors the
      // live path: static-points mode skips ELO, leaver penalty still
      // overrides everything (but recompute has no leaver snapshot, so
      // that case is unreachable here — documented elsewhere).
      function basePart(teamAvg, oppAvg, won) {
        if (inhouseHere && m.use_static_points) {
          const flat = won
            ? Number(m.inhouse_win_points ?? 21)
            : -Number(m.inhouse_loss_points ?? 19)
          return { delta: flat, expected: null, kUsed: null }
        }
        return computeDelta({ teamAvgMmr: teamAvg, oppAvgMmr: oppAvg, won, settings: cfg })
      }
      // Score one side. Captures the per-component breakdown into reason so the
      // audit log shows the math (recompute can't replay leaver penalty/cushion
      // — see note above — so those never appear here).
      const isStatic = inhouseHere && !!m.use_static_points
      async function scoreSide(pid, team, teamAvg, oppAvg, won) {
        const before = getPts(pid)
        const { delta, expected, kUsed } = basePart(teamAvg, oppAvg, won)
        const winRun = getStreak(pid) >= 0 ? getStreak(pid) + 1 : 1
        let mmrDiffAmt = 0, winstreakAmt = 0, fridayAmt = 0
        if (inhouseHere) {
          mmrDiffAmt = mmrDiffBonus({ myAvgMmr: teamAvg, oppAvgMmr: oppAvg, won, tiers: m.mmr_diff_tiers || [] })
          if (won) {
            winstreakAmt = winstreakBonus(winRun, m.winstreak_tiers || [])
            if (matchIsFriday) fridayAmt = Number(m.friday_win_bonus ?? 5)
          }
        }
        const bonus = mmrDiffAmt + winstreakAmt + fridayAmt
        const after = clampPoints(before + delta + bonus, cfg)
        points.set(pid, after); bumpStats(pid, won, after)
        const reason = fmtDeltaReason({
          base: isStatic ? null : delta, staticBase: isStatic ? delta : null,
          expected, kUsed, mmrDiff: mmrDiffAmt, winstreak: winstreakAmt, winRun,
          friday: fridayAmt, rawDelta: before + delta + bonus - before, realDelta: after - before,
        })
        await execute(`
          INSERT INTO season_match_log (season_id, queue_match_id, player_id, team, won,
            points_before, points_after, delta, team_avg_mmr, opponent_avg_mmr, expected_win, k_used, reason, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, COALESCE($14, NOW()))
        `, [seasonId, m.id, pid, team, won, before, after, after - before, teamAvg, oppAvg, expected, kUsed, reason, m.completed_at])
      }
      for (const pid of t1) await scoreSide(pid, 1, t1Avg, t2Avg, team1Won)
      for (const pid of t2) await scoreSide(pid, 2, t2Avg, t1Avg, team2Won)
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

  // Re-derive the Friday top-3 podium bonuses from the freshly-rebuilt match
  // rows. Recompute owns these rows (the blanket delete above cleared the stale
  // ones, and they were excluded from the replayed adjusts), so this is the one
  // place they get recomputed under current logic. applyFridayBonusForSeason
  // reads season_rankings (just upserted) + the match rows, inserts the
  // synthetic bonus rows dated to their Friday, and bumps points/peak. Called
  // WITHOUT force, so it self-skips any Friday whose window is still open — that
  // one stays for the Saturday scheduler.
  let fridaysApplied = 0
  const inhousePool = await queryOne(
    `SELECT friday_window_start_hour, friday_window_end_hour
       FROM queue_pools WHERE season_id = $1 AND inhouse_enabled = TRUE ORDER BY id LIMIT 1`,
    [seasonId]
  )
  if (inhousePool) {
    const windowExpr = fridayWindowSql('created_at',
      clampHour(inhousePool.friday_window_start_hour), clampHour(inhousePool.friday_window_end_hour))
    const fdates = await query(`
      SELECT DISTINCT to_char(${windowExpr}, 'YYYY-MM-DD') AS fdate
        FROM season_match_log
       WHERE season_id = $1 AND queue_match_id IS NOT NULL AND (${windowExpr}) IS NOT NULL
       ORDER BY fdate ASC
    `, [seasonId])
    for (const { fdate } of fdates) {
      const r = await applyFridayBonusForSeason(seasonId, fdate)
      if (r && typeof r.applied === 'number') fridaysApplied += r.applied
    }
  }

  return { players: points.size, events: events.length, fridaysApplied }
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
