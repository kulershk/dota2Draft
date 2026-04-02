/**
 * Backfill favorite_position for all players who have match stats.
 * Usage: node --experimental-vm-modules server/scripts/backfill-positions.js
 */
import { query, initDb } from '../db.js'
import { recalcFavoritePosition } from '../helpers/position.js'

async function backfill() {
  await initDb()

  const players = await query(`
    SELECT DISTINCT account_id FROM match_game_player_stats WHERE account_id > 0
  `)

  console.log(`[Backfill] Recalculating positions for ${players.length} players...`)

  let updated = 0
  for (const { account_id } of players) {
    try {
      await recalcFavoritePosition(account_id)
      updated++
    } catch {}
  }

  console.log(`[Backfill] Done! Updated ${updated} players.`)
  process.exit(0)
}

backfill().catch(e => {
  console.error('[Backfill] Fatal:', e)
  process.exit(1)
})
