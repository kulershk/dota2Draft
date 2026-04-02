import { query, queryOne, execute } from '../db.js'

const OPENDOTA_API = 'https://api.opendota.com/api'

export async function fetchOpenDotaMatch(dotabuffId) {
  const matchId = dotabuffId.replace(/\D/g, '')
  if (!matchId) return null

  const res = await fetch(`${OPENDOTA_API}/matches/${matchId}`)
  if (!res.ok) {
    if (res.status === 404) return null
    throw new Error(`OpenDota API error: ${res.status}`)
  }
  return res.json()
}

export async function requestOpenDotaParse(dotabuffId) {
  const matchId = dotabuffId.replace(/\D/g, '')
  if (!matchId) return false

  const res = await fetch(`${OPENDOTA_API}/request/${matchId}`, { method: 'POST' })
  return res.ok
}

export async function saveMatchGameStats(matchGameId, matchData) {
  if (!matchData?.players?.length) return { saved: 0, parsed: false }

  const parsed = matchData.players[0].obs_placed != null
  const duration = matchData.duration || 0

  for (const p of matchData.players) {
    const multiKills = p.multi_kills || {}
    const killStreaks = p.kill_streaks || {}

    await execute(`
      INSERT INTO match_game_player_stats (
        match_game_id, account_id, player_name, hero_id,
        kills, deaths, assists, last_hits, denies, gpm, xpm,
        hero_damage, tower_damage, hero_healing, net_worth, level,
        multi_kills, kill_streaks,
        obs_placed, sen_placed, observer_kills, sentry_kills,
        camps_stacked, stuns, teamfight_participation,
        towers_killed, roshans_killed, firstblood_claimed,
        rune_pickups, courier_kills, win, is_radiant, duration_seconds, lane_role,
        item_0, item_1, item_2, item_3, item_4, item_5,
        backpack_0, backpack_1, backpack_2, item_neutral
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16,
        $17, $18,
        $19, $20, $21, $22,
        $23, $24, $25,
        $26, $27, $28,
        $29, $30, $31, $32, $33, $34,
        $35, $36, $37, $38, $39, $40,
        $41, $42, $43, $44
      ) ON CONFLICT (match_game_id, account_id) DO UPDATE SET
        player_name = $3, hero_id = $4,
        kills = $5, deaths = $6, assists = $7, last_hits = $8, denies = $9, gpm = $10, xpm = $11,
        hero_damage = $12, tower_damage = $13, hero_healing = $14, net_worth = $15, level = $16,
        multi_kills = $17, kill_streaks = $18,
        obs_placed = $19, sen_placed = $20, observer_kills = $21, sentry_kills = $22,
        camps_stacked = $23, stuns = $24, teamfight_participation = $25,
        towers_killed = $26, roshans_killed = $27, firstblood_claimed = $28,
        rune_pickups = $29, courier_kills = $30, win = $31, is_radiant = $32, duration_seconds = $33, lane_role = $34,
        item_0 = $35, item_1 = $36, item_2 = $37, item_3 = $38, item_4 = $39, item_5 = $40,
        backpack_0 = $41, backpack_1 = $42, backpack_2 = $43, item_neutral = $44
    `, [
      matchGameId, p.account_id || 0, p.personaname || '', p.hero_id || 0,
      p.kills || 0, p.deaths || 0, p.assists || 0, p.last_hits || 0, p.denies || 0,
      p.gold_per_min || 0, p.xp_per_min || 0,
      p.hero_damage || 0, p.tower_damage || 0, p.hero_healing || 0, p.net_worth || 0, p.level || 0,
      JSON.stringify(multiKills), JSON.stringify(killStreaks),
      p.obs_placed || 0, p.sen_placed || 0, p.observer_kills || 0, p.sentry_kills || 0,
      p.camps_stacked || 0, p.stuns || 0, p.teamfight_participation || 0,
      p.towers_killed || 0, p.roshans_killed || 0, p.firstblood_claimed || 0,
      p.rune_pickups || 0, p.courier_kills || 0,
      p.win || 0, !!p.isRadiant, duration, p.lane_role ?? null,
      p.item_0 || 0, p.item_1 || 0, p.item_2 || 0, p.item_3 || 0, p.item_4 || 0, p.item_5 || 0,
      p.backpack_0 || 0, p.backpack_1 || 0, p.backpack_2 || 0, p.item_neutral || 0
    ])
  }

  // Update match_game duration, parsed flag, and picks/bans
  const durationMinutes = Math.round(duration / 60)
  const picksBans = matchData.picks_bans || []
  await execute('UPDATE match_games SET duration_minutes = COALESCE($1, duration_minutes), parsed = $2, picks_bans = $3 WHERE id = $4',
    [durationMinutes > 0 ? durationMinutes : null, parsed, JSON.stringify(picksBans), matchGameId])

  // Recalculate favorite position for all players in this game
  try {
    const { recalcFavoritePosition } = await import('./position.js')
    for (const p of matchData.players) {
      if (p.account_id) recalcFavoritePosition(p.account_id).catch(() => {})
    }
  } catch {}

  return { saved: matchData.players.length, parsed }
}

export async function fetchAndSaveGameStats(matchGameId, dotabuffId) {
  const matchData = await fetchOpenDotaMatch(dotabuffId)
  if (!matchData) return { error: 'Match not found on OpenDota' }

  const result = await saveMatchGameStats(matchGameId, matchData)

  // If match data is not fully parsed, request a parse from OpenDota
  // so detailed stats (ward kills, items, etc.) become available later
  if (!result.parsed) {
    requestOpenDotaParse(dotabuffId).catch(() => {})
    result.parse_requested = true
  }

  return result
}
