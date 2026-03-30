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
