import { query, queryOne, execute } from '../db.js'

const DEFAULT_FANTASY_SCORING = {
  carry:   { kill: 3, death: -3, assist: 0.5, lastHit: 0.02, deny: 0.1, gpm: 0.005, xpm: 0.003, heroDamage: 0.3, towerDamage: 0.5, heroHealing: 0.1, obsPlaced: 0.1, senPlaced: 0.05, obsKilled: 0.5, senKilled: 0.1, campsStacked: 0.2, stuns: 0.01, teamfight: 3, towerKill: 2, roshanKill: 1.5, firstBlood: 3, runePickup: 0.1, tripleKill: 5, ultraKill: 10, rampage: 15, courierKill: 1 },
  mid:     { kill: 3, death: -3, assist: 0.5, lastHit: 0.02, deny: 0.15, gpm: 0.005, xpm: 0.005, heroDamage: 0.4, towerDamage: 0.3, heroHealing: 0.1, obsPlaced: 0.1, senPlaced: 0.05, obsKilled: 0.3, senKilled: 0.1, campsStacked: 0.2, stuns: 0.02, teamfight: 3, towerKill: 1.5, roshanKill: 1, firstBlood: 4, runePickup: 0.3, tripleKill: 5, ultraKill: 10, rampage: 15, courierKill: 1 },
  offlane: { kill: 2, death: -1.5, assist: 1, lastHit: 0.01, deny: 0.1, gpm: 0.003, xpm: 0.003, heroDamage: 0.2, towerDamage: 0.4, heroHealing: 0.2, obsPlaced: 0.15, senPlaced: 0.1, obsKilled: 0.5, senKilled: 0.2, campsStacked: 0.3, stuns: 0.05, teamfight: 4, towerKill: 1.5, roshanKill: 1, firstBlood: 2, runePickup: 0.05, tripleKill: 8, ultraKill: 15, rampage: 25, courierKill: 1 },
  pos4:    { kill: 1.5, death: -1, assist: 1.5, lastHit: 0.005, deny: 0.05, gpm: 0.002, xpm: 0.002, heroDamage: 0.15, towerDamage: 0.1, heroHealing: 0.5, obsPlaced: 0.5, senPlaced: 0.3, obsKilled: 1, senKilled: 0.5, campsStacked: 1, stuns: 0.04, teamfight: 4, towerKill: 0.5, roshanKill: 0.5, firstBlood: 2, runePickup: 0.1, tripleKill: 12, ultraKill: 20, rampage: 40, courierKill: 2 },
  pos5:    { kill: 1, death: -0.5, assist: 2, lastHit: 0.005, deny: 0.05, gpm: 0.002, xpm: 0.002, heroDamage: 0.1, towerDamage: 0.1, heroHealing: 1, obsPlaced: 1, senPlaced: 0.5, obsKilled: 1.5, senKilled: 0.5, campsStacked: 1.5, stuns: 0.03, teamfight: 5, towerKill: 0.5, roshanKill: 0.5, firstBlood: 5, runePickup: 0.05, tripleKill: 15, ultraKill: 25, rampage: 50, courierKill: 2 },
}

export function getDefaultFantasyScoring() {
  return JSON.parse(JSON.stringify(DEFAULT_FANTASY_SCORING))
}

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
    biddingType: s.biddingType || 'default',
    blindTopBidders: Number(s.blindTopBidders) || 3,
    blindBidTimer: Number(s.blindBidTimer) || Number(s.bidTimer) || 30,
    autoFinish: s.autoFinish !== false,
    fantasyEnabled: !!s.fantasyEnabled,
    fantasyScoring: s.fantasyScoring || getDefaultFantasyScoring(),
    fantasyRepeatPenalty: s.fantasyRepeatPenalty != null ? Number(s.fantasyRepeatPenalty) : 0.15,
  }
}

export function parseAuctionState(comp) {
  return comp?.auction_state || {}
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
    SELECT c.id, COALESCE(p.display_name, c.name) as name, c.team, c.budget, c.status, c.mmr, c.player_id, c.competition_id,
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
    SELECT cp.*, COALESCE(p.display_name, p.name) as name, p.steam_id, p.avatar_url, p.is_admin
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
      if (avg < lowestAvg || (avg === lowestAvg && active[i].mmr < lowest.mmr)) {
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
      if (count < bestCount || (count === bestCount && (avg < bestAvg || (avg === bestAvg && c.mmr < best.mmr)))) {
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
  if (!comp) return { status: 'idle', currentRound: 0, totalRounds: 0, nominator: null, nominatedPlayer: null, currentBid: 0, currentBidder: null, bidTimerEnd: 0, bidHistory: [], captains: [], players: [], settings: parseCompSettings({}), blindPhase: false, blindBidCount: 0, topBidderIds: [], revealedBids: null }
  const state = parseAuctionState(comp)
  const settings = parseCompSettings(comp)

  const nominatedPlayer = state.nominatedPlayerId
    ? await queryOne(`
        SELECT cp.*, COALESCE(p.display_name, p.name) as name, p.steam_id, p.avatar_url
        FROM competition_players cp JOIN players p ON cp.player_id = p.id
        WHERE cp.competition_id = $1 AND cp.player_id = $2
      `, [compId, state.nominatedPlayerId])
    : null
  const nominator = state.nominatorId
    ? await queryOne('SELECT c.id, COALESCE(p.display_name, c.name) as name, c.team FROM captains c LEFT JOIN players p ON c.player_id = p.id WHERE c.id = $1', [state.nominatorId])
    : null
  const currentBidder = state.currentBidderId
    ? await queryOne('SELECT c.id, COALESCE(p.display_name, c.name) as name, c.team FROM captains c LEFT JOIN players p ON c.player_id = p.id WHERE c.id = $1', [state.currentBidderId])
    : null
  const history = state.currentRound ? await getBidHistory(compId, Number(state.currentRound)) : []

  // Blind bidding: build per-captain view of blind bids
  const blindPhase = !!state.blindPhase
  const blindBids = state.blindBids || {}
  // How many captains have submitted a blind bid (public info)
  const blindBidCount = Object.keys(blindBids).length
  // Top bidder IDs after blind phase reveal
  const topBidderIds = state.topBidderIds || []
  // Revealed bids (only after blind phase ends)
  const revealedBids = state.revealedBids || null

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
    // Blind bidding fields
    blindPhase,
    blindBidCount,
    topBidderIds,
    revealedBids,
  }
}
