import { query, queryOne, execute } from '../db.js'

export function parseCompSettings(comp) {
  const s = comp.settings || {}
  return {
    playersPerTeam: Number(s.playersPerTeam) || 5,
    bidTimer: Number(s.bidTimer) || 30,
    startingBudget: Number(s.startingBudget) || 1000,
    minimumBid: Number(s.minimumBid) || 10,
    bidIncrement: Number(s.bidIncrement) || 5,
    maxBid: Number(s.maxBid) || 0,
    nominationOrder: s.nominationOrder || 'normal',
    requireAllOnline: s.requireAllOnline !== false,
    allowSteamRegistration: s.allowSteamRegistration !== false,
  }
}

export function parseAuctionState(comp) {
  return comp.auction_state || {}
}

export async function getCompetition(compId) {
  return await queryOne('SELECT * FROM competitions WHERE id = $1', [compId])
}

export async function setAuctionState(compId, updates) {
  const comp = await queryOne('SELECT auction_state FROM competitions WHERE id = $1', [compId])
  const state = comp?.auction_state || {}
  Object.assign(state, updates)
  await execute('UPDATE competitions SET auction_state = $1 WHERE id = $2', [JSON.stringify(state), compId])
}

export async function getCaptains(compId) {
  return await query(`
    SELECT c.id, c.name, c.team, c.budget, c.status, c.mmr, c.player_id, c.competition_id,
           c.banner_url, COALESCE(p.avatar_url, '') as avatar_url
    FROM captains c
    LEFT JOIN players p ON c.player_id = p.id
    WHERE c.competition_id = $1
    ORDER BY c.id
  `, [compId])
}

export async function getCompPlayers(compId) {
  const captainPlayerIds = (await query(
    'SELECT player_id FROM captains WHERE competition_id = $1 AND player_id IS NOT NULL', [compId]
  )).map(r => r.player_id)

  const rows = await query(`
    SELECT cp.*, p.name, p.steam_id, p.avatar_url, p.is_admin
    FROM competition_players cp
    JOIN players p ON cp.player_id = p.id
    WHERE cp.competition_id = $1
    ORDER BY cp.id
  `, [compId])

  return rows.filter(p => p.in_pool || captainPlayerIds.includes(p.player_id)).map(p => ({
    id: p.player_id,
    name: p.name,
    roles: JSON.parse(p.roles || '[]'),
    mmr: p.mmr,
    info: p.info || '',
    drafted: !!p.drafted,
    drafted_by: p.drafted_by,
    draft_price: p.draft_price,
    draft_round: p.draft_round,
    steam_id: p.steam_id || null,
    avatar_url: p.avatar_url || null,
    is_admin: !!p.is_admin,
    is_captain: captainPlayerIds.includes(p.player_id),
    in_pool: !!p.in_pool,
  }))
}

export async function getBidHistory(compId, round) {
  if (round !== undefined) {
    return await query('SELECT * FROM bid_history WHERE competition_id = $1 AND round = $2 ORDER BY id DESC', [compId, round])
  }
  return await query('SELECT * FROM bid_history WHERE competition_id = $1 ORDER BY id DESC LIMIT 50', [compId])
}

export async function saveAuctionLog(compId, type, message) {
  await execute('INSERT INTO auction_log (competition_id, type, message) VALUES ($1, $2, $3)', [compId, type, message])
}

export async function getAuctionLog(compId) {
  const rows = await query(
    'SELECT type, message, created_at as time FROM auction_log WHERE competition_id = $1 ORDER BY id DESC LIMIT 200', [compId]
  )
  return rows.map(r => ({ type: r.type, message: r.message, time: new Date(r.time).getTime() }))
}

export async function getCaptainPlayerCount(compId, captainId) {
  const row = await queryOne(
    'SELECT COUNT(*) as count FROM competition_players WHERE competition_id = $1 AND drafted = 1 AND drafted_by = $2',
    [compId, captainId]
  )
  return parseInt(row.count)
}

export async function getCaptainAvgMmr(compId, captain) {
  const players = await query(
    'SELECT mmr FROM competition_players WHERE competition_id = $1 AND drafted = 1 AND drafted_by = $2',
    [compId, captain.id]
  )
  const totalMmr = captain.mmr + players.reduce((s, p) => s + p.mmr, 0)
  return totalMmr / (1 + players.length)
}

export async function getNextNominator(compId, round, captains, settings) {
  const active = []
  for (const c of captains) {
    if (await getCaptainPlayerCount(compId, c.id) < settings.playersPerTeam) {
      active.push(c)
    }
  }
  if (active.length === 0) return captains[0]

  if (settings.nominationOrder === 'lowest_avg') {
    let lowest = active[0]
    let lowestAvg = await getCaptainAvgMmr(compId, lowest)
    for (let i = 1; i < active.length; i++) {
      const avg = await getCaptainAvgMmr(compId, active[i])
      if (avg < lowestAvg) {
        lowest = active[i]
        lowestAvg = avg
      }
    }
    return lowest
  }

  if (settings.nominationOrder === 'fewest_then_lowest') {
    let best = active[0]
    let bestCount = await getCaptainPlayerCount(compId, best.id)
    let bestAvg = await getCaptainAvgMmr(compId, best)
    for (let i = 1; i < active.length; i++) {
      const c = active[i]
      const count = await getCaptainPlayerCount(compId, c.id)
      const avg = await getCaptainAvgMmr(compId, c)
      if (count < bestCount || (count === bestCount && avg < bestAvg)) {
        best = c
        bestCount = count
        bestAvg = avg
      }
    }
    return best
  }

  // Normal: round-robin
  const nominatorIndex = (round - 1) % captains.length
  for (let i = 0; i < captains.length; i++) {
    const candidate = captains[(nominatorIndex + i) % captains.length]
    if (active.some(a => a.id === candidate.id)) return candidate
  }
  return captains[nominatorIndex]
}

export async function computeAndSyncCompStatus(comp) {
  const stored = comp.status || 'draft'
  if (stored === 'active' || stored === 'finished') return stored

  const now = new Date()
  let newStatus = stored

  if (stored === 'draft' || stored === 'registration') {
    const regStart = comp.registration_start ? new Date(comp.registration_start) : null
    const regEnd = comp.registration_end ? new Date(comp.registration_end) : null

    if (regStart && regStart <= now && (!regEnd || regEnd > now)) {
      newStatus = 'registration'
    } else if (regEnd && regEnd <= now && stored === 'registration') {
      newStatus = 'draft'
    }
  }

  if (newStatus !== stored) {
    await execute('UPDATE competitions SET status = $1 WHERE id = $2', [newStatus, comp.id])
    comp.status = newStatus
  }

  return newStatus
}

export async function getFullAuctionState(compId) {
  const comp = await getCompetition(compId)
  const state = parseAuctionState(comp)
  const settings = parseCompSettings(comp)

  const nominatedPlayer = state.nominatedPlayerId
    ? await queryOne(`
        SELECT cp.*, p.name, p.steam_id, p.avatar_url
        FROM competition_players cp JOIN players p ON cp.player_id = p.id
        WHERE cp.competition_id = $1 AND cp.player_id = $2
      `, [compId, state.nominatedPlayerId])
    : null
  const nominator = state.nominatorId
    ? await queryOne('SELECT id, name, team FROM captains WHERE id = $1', [state.nominatorId])
    : null
  const currentBidder = state.currentBidderId
    ? await queryOne('SELECT id, name, team FROM captains WHERE id = $1', [state.currentBidderId])
    : null
  const history = state.currentRound ? await getBidHistory(compId, Number(state.currentRound)) : []

  return {
    status: state.status || 'idle',
    currentRound: Number(state.currentRound) || 0,
    totalRounds: Number(state.totalRounds) || 0,
    nominator,
    nominatedPlayer: nominatedPlayer ? {
      id: nominatedPlayer.player_id,
      name: nominatedPlayer.name,
      roles: JSON.parse(nominatedPlayer.roles || '[]'),
      mmr: nominatedPlayer.mmr,
      info: nominatedPlayer.info,
      drafted: !!nominatedPlayer.drafted,
      steam_id: nominatedPlayer.steam_id,
      avatar_url: nominatedPlayer.avatar_url,
    } : null,
    currentBid: Number(state.currentBid) || 0,
    currentBidder,
    bidTimerEnd: Number(state.bidTimerEnd) || 0,
    bidHistory: history,
    captains: await getCaptains(compId),
    players: await getCompPlayers(compId),
    settings,
  }
}
