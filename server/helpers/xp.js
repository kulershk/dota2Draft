import { query, queryOne, execute } from '../db.js'

/**
 * Award XP to a player. Idempotent via UNIQUE constraint on (player_id, reason, ref_type, ref_id).
 * @param {number} playerId
 * @param {number} amount
 * @param {string} reason - e.g. 'match_win', 'placement_1st'
 * @param {string} refType - e.g. 'match_game', 'competition'
 * @param {string} refId - unique ref within type
 * @param {object} [opts] - { competitionId, competitionName, detail }
 * @returns {{ awarded: boolean, total_xp: number, level: number }}
 */
export async function awardXp(playerId, amount, reason, refType, refId, opts = {}) {
  if (!amount || amount <= 0) return { awarded: false, total_xp: 0, level: 1 }
  try {
    const { rowCount } = await execute(
      `INSERT INTO xp_log (player_id, amount, reason, ref_type, ref_id, competition_id, competition_name, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (player_id, reason, ref_type, ref_id) DO NOTHING`,
      [playerId, amount, reason, refType, String(refId),
       opts.competitionId || null, opts.competitionName || null, opts.detail || null]
    )
    if (rowCount > 0) {
      await execute(
        `UPDATE players SET total_xp = (SELECT COALESCE(SUM(amount), 0) FROM xp_log WHERE player_id = $1) WHERE id = $1`,
        [playerId]
      )
    }
    const player = await queryOne('SELECT total_xp FROM players WHERE id = $1', [playerId])
    const totalXp = player?.total_xp || 0
    return { awarded: rowCount > 0, total_xp: totalXp, level: getLevel(totalXp) }
  } catch (e) {
    console.error(`[XP] Failed to award ${amount} XP to player ${playerId}:`, e.message)
    return { awarded: false, total_xp: 0, level: 1 }
  }
}

export function getLevel(totalXp) {
  return Math.floor((totalXp || 0) / 1000) + 1
}

export function getLevelProgress(totalXp) {
  return (totalXp || 0) % 1000
}

/** Get all player_ids on a team (drafted players + captain themselves) */
export async function getTeamPlayerIds(captainId, compId) {
  const rows = await query(`
    SELECT DISTINCT cp.player_id FROM competition_players cp
    JOIN captains cap ON cap.id = $1
    WHERE (cp.drafted_by = $1 OR (cap.player_id IS NOT NULL AND cp.player_id = cap.player_id AND cp.competition_id = $2))
      AND cp.competition_id = $2
  `, [captainId, compId])
  return rows.map(r => r.player_id)
}

/**
 * Compute the placement map (captainId → place) for a stage, plus the blocking
 * reason if placements cannot be awarded. Does not write anything.
 *
 * @returns {{ placements: Map<number, number>, final: object|null, blocked: string|null }}
 */
export async function computeStagePlacements(compId, stage) {
  if (!stage) return { placements: new Map(), final: null, blocked: 'Stage not found' }
  if (stage.format === 'group_stage') {
    return { placements: new Map(), final: null, blocked: 'Group stage — no placements awarded' }
  }

  const pendingRows = await query(
    "SELECT COUNT(*)::int AS n FROM matches WHERE competition_id = $1 AND stage = $2 AND status != 'completed'",
    [compId, stage.id]
  )
  if ((pendingRows[0]?.n || 0) > 0) {
    return { placements: new Map(), final: null, blocked: `${pendingRows[0].n} match(es) still pending in this stage` }
  }

  const allStageMatches = await query(
    'SELECT * FROM matches WHERE competition_id = $1 AND stage = $2 ORDER BY round DESC, match_order',
    [compId, stage.id]
  )
  const final = allStageMatches.find(m => !m.next_match_id && m.winner_captain_id && m.bracket !== 'lower') || null
  if (!final) {
    return { placements: new Map(), final: null, blocked: 'Final match missing winner' }
  }

  const placements = new Map()
  placements.set(final.winner_captain_id, 1)
  const finalLoser = final.team1_captain_id === final.winner_captain_id
    ? final.team2_captain_id : final.team1_captain_id
  if (finalLoser) placements.set(finalLoser, 2)

  if (stage.format === 'single_elimination' && stage.totalRounds) {
    const semiRound = stage.totalRounds - 1
    const semis = allStageMatches.filter(m => m.round === semiRound && m.bracket !== 'lower')
    for (const semi of semis) {
      if (!semi.winner_captain_id) continue
      const loser = semi.team1_captain_id === semi.winner_captain_id
        ? semi.team2_captain_id : semi.team1_captain_id
      if (loser && !placements.has(loser)) placements.set(loser, 3)
    }
  }
  return { placements, final, blocked: null }
}

/**
 * Award placement XP for a completed stage. Idempotent — already-awarded
 * entries are skipped by the unique constraint inside awardXp.
 *
 * @returns {Promise<{ awarded: number, skipped: number, blocked: string|null }>}
 */
export async function awardStagePlacements(comp, stage, settings) {
  const { placements, blocked } = await computeStagePlacements(comp.id, stage)
  if (blocked) return { awarded: 0, skipped: 0, blocked }

  const xpAmounts = { 1: settings.xpPlacement1st, 2: settings.xpPlacement2nd, 3: settings.xpPlacement3rd }
  const labels = { 1: '1st place', 2: '2nd place', 3: '3rd place' }
  let awarded = 0, skipped = 0
  for (const [captainId, place] of placements) {
    const xp = xpAmounts[place]
    if (!xp) continue
    const players = await getTeamPlayerIds(captainId, comp.id)
    const cap = await queryOne('SELECT team FROM captains WHERE id = $1', [captainId])
    for (const pid of players) {
      const r = await awardXp(pid, xp, `placement_${place}`, 'stage', `${comp.id}:${stage.id}:${pid}`, {
        competitionId: comp.id, competitionName: comp.name,
        detail: `${labels[place]} — ${cap?.team || 'Team'} in ${stage.name || 'Stage'}`,
      })
      if (r.awarded) awarded++
      else skipped++
    }
  }
  return { awarded, skipped, blocked: null }
}
