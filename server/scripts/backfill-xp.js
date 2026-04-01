/**
 * Backfill XP for all completed match games and matches that were
 * auto-resolved by the bot but never received XP awards.
 *
 * Safe to run multiple times — awardXp is idempotent via
 * UNIQUE(player_id, reason, ref_type, ref_id).
 *
 * Usage: node --experimental-vm-modules server/scripts/backfill-xp.js
 */
import { query, queryOne, execute, initDb } from '../db.js'
import { awardXp, getTeamPlayerIds } from '../helpers/xp.js'
import { getCompetition, parseCompSettings } from '../helpers/competition.js'

async function backfill() {
  await initDb()

  let totalAwarded = 0

  // ── 1. Game win/loss XP ──
  console.log('[Backfill] Scanning completed match games...')
  const games = await query(`
    SELECT mg.match_id, mg.game_number, mg.winner_captain_id,
           m.team1_captain_id, m.team2_captain_id, m.competition_id
    FROM match_games mg
    JOIN matches m ON m.id = mg.match_id
    WHERE mg.winner_captain_id IS NOT NULL
    ORDER BY mg.match_id, mg.game_number
  `)

  // Group by competition to avoid repeated settings lookups
  const compCache = new Map()
  async function getCompSettings(compId) {
    if (compCache.has(compId)) return compCache.get(compId)
    const comp = await getCompetition(compId)
    if (!comp) return null
    const settings = parseCompSettings(comp)
    const result = { comp, settings }
    compCache.set(compId, result)
    return result
  }

  for (const game of games) {
    const cached = await getCompSettings(game.competition_id)
    if (!cached) continue
    const { comp, settings } = cached

    const winCapId = game.winner_captain_id
    const loseCapId = winCapId === game.team1_captain_id ? game.team2_captain_id : game.team1_captain_id

    const winPlayers = await getTeamPlayerIds(winCapId, game.competition_id)
    const losePlayers = loseCapId ? await getTeamPlayerIds(loseCapId, game.competition_id) : []
    const winCap = await queryOne('SELECT team FROM captains WHERE id = $1', [winCapId])
    const loseCap = loseCapId ? await queryOne('SELECT team FROM captains WHERE id = $1', [loseCapId]) : null

    for (const pid of winPlayers) {
      const r = await awardXp(pid, settings.xpGameWin, 'game_win', 'match_game', `${game.match_id}:${game.game_number}:${pid}`, {
        competitionId: game.competition_id, competitionName: comp.name,
        detail: `Game ${game.game_number} win vs ${loseCap?.team || 'TBD'}`,
      })
      if (r.awarded) totalAwarded++
    }
    for (const pid of losePlayers) {
      const r = await awardXp(pid, settings.xpGameLoss, 'game_loss', 'match_game', `${game.match_id}:${game.game_number}:${pid}`, {
        competitionId: game.competition_id, competitionName: comp.name,
        detail: `Game ${game.game_number} loss vs ${winCap?.team || 'TBD'}`,
      })
      if (r.awarded) totalAwarded++
    }
  }
  console.log(`[Backfill] Processed ${games.length} games`)

  // ── 2. Match win XP ──
  console.log('[Backfill] Scanning completed matches...')
  const matches = await query(`
    SELECT id, team1_captain_id, team2_captain_id, winner_captain_id, competition_id
    FROM matches
    WHERE status = 'completed' AND winner_captain_id IS NOT NULL
    ORDER BY id
  `)

  for (const match of matches) {
    const cached = await getCompSettings(match.competition_id)
    if (!cached) continue
    const { comp, settings } = cached

    const winPlayers = await getTeamPlayerIds(match.winner_captain_id, match.competition_id)
    const loserId = match.winner_captain_id === match.team1_captain_id ? match.team2_captain_id : match.team1_captain_id
    const loseCap = loserId ? await queryOne('SELECT team FROM captains WHERE id = $1', [loserId]) : null

    for (const pid of winPlayers) {
      const r = await awardXp(pid, settings.xpMatchWin, 'match_win', 'match', `${match.id}:${pid}`, {
        competitionId: match.competition_id, competitionName: comp.name,
        detail: `Series win vs ${loseCap?.team || 'TBD'}`,
      })
      if (r.awarded) totalAwarded++
    }
  }
  console.log(`[Backfill] Processed ${matches.length} matches`)

  // ── 3. Placement XP ──
  console.log('[Backfill] Scanning tournament placements...')
  const comps = await query(`
    SELECT id, name, tournament_state, settings FROM competitions
    WHERE tournament_state IS NOT NULL AND tournament_state != '{}'::jsonb
  `)

  for (const comp of comps) {
    const settings = parseCompSettings(comp)
    const ts = comp.tournament_state || {}
    if (!ts.stages) continue

    for (const stage of ts.stages) {
      if (stage.status !== 'completed' || stage.format === 'group_stage') continue

      const allStageMatches = await query(
        'SELECT * FROM matches WHERE competition_id = $1 AND stage = $2 ORDER BY round DESC, match_order',
        [comp.id, stage.id]
      )
      const finalMatch = allStageMatches.find(m => !m.next_match_id && m.winner_captain_id && m.bracket !== 'lower')
      if (!finalMatch) continue

      const placementMap = new Map()
      placementMap.set(finalMatch.winner_captain_id, 1)
      const finalistLoser = finalMatch.team1_captain_id === finalMatch.winner_captain_id
        ? finalMatch.team2_captain_id : finalMatch.team1_captain_id
      if (finalistLoser) placementMap.set(finalistLoser, 2)

      if (stage.format === 'single_elimination' && stage.totalRounds) {
        const semiRound = stage.totalRounds - 1
        const semis = allStageMatches.filter(m => m.round === semiRound && m.bracket !== 'lower')
        for (const semi of semis) {
          if (semi.winner_captain_id) {
            const loser = semi.team1_captain_id === semi.winner_captain_id
              ? semi.team2_captain_id : semi.team1_captain_id
            if (loser && !placementMap.has(loser)) placementMap.set(loser, 3)
          }
        }
      }

      const xpAmounts = { 1: settings.xpPlacement1st, 2: settings.xpPlacement2nd, 3: settings.xpPlacement3rd }
      const placementLabels = { 1: '1st place', 2: '2nd place', 3: '3rd place' }
      for (const [captainId, place] of placementMap) {
        const xp = xpAmounts[place]
        if (!xp) continue
        const players = await getTeamPlayerIds(captainId, comp.id)
        const cap = await queryOne('SELECT team FROM captains WHERE id = $1', [captainId])
        for (const pid of players) {
          const r = await awardXp(pid, xp, `placement_${place}`, 'stage', `${comp.id}:${stage.id}:${pid}`, {
            competitionId: comp.id, competitionName: comp.name,
            detail: `${placementLabels[place]} — ${cap?.team || 'Team'} in ${stage.name || 'Stage'}`,
          })
          if (r.awarded) totalAwarded++
        }
      }
    }
  }
  console.log(`[Backfill] Processed ${comps.length} competitions for placements`)

  console.log(`\n[Backfill] Done! ${totalAwarded} new XP entries awarded.`)
  process.exit(0)
}

backfill().catch(e => {
  console.error('[Backfill] Fatal error:', e)
  process.exit(1)
})
