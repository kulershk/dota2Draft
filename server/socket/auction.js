import { query, queryOne, execute } from '../db.js'
import {
  getCompetition, parseCompSettings, parseAuctionState, setAuctionState,
  getCaptains, getCompPlayers, getCaptainPlayerCount, getNextNominator,
  saveAuctionLog, getFullAuctionState, getBidHistory,
} from '../helpers/competition.js'
import {
  socketPlayers, socketCompetitions, compOnlineCaptains, compReadyCaptains,
  compBidTimers, compLastBidTime, BID_COOLDOWN_MS,
  getOnlineCaptainIds, getReadyCaptainIds, isAdminSocket, getSocketCaptainId,
  clearCompBidTimer,
} from './state.js'

export async function startCompBidTimer(compId, io) {
  clearCompBidTimer(compId)
  const comp = await getCompetition(compId)
  const settings = parseCompSettings(comp)
  const state = parseAuctionState(comp)
  const timerSeconds = state.blindPhase ? settings.blindBidTimer : settings.bidTimer
  const endTime = Date.now() + timerSeconds * 1000
  await setAuctionState(compId, { bidTimerEnd: endTime })
  io.to(`comp:${compId}`).emit('auction:timerUpdate', { bidTimerEnd: endTime })

  const callback = state.blindPhase
    ? () => finalizeBlindPhase(compId, io)
    : () => finalizeCompBid(compId, io)

  const timer = setTimeout(callback, timerSeconds * 1000)
  compBidTimers.set(compId, timer)
}

async function finalizeBlindPhase(compId, io) {
  clearCompBidTimer(compId)
  const comp = await getCompetition(compId)
  if (!comp) return
  const state = parseAuctionState(comp)
  const settings = parseCompSettings(comp)
  const blindBids = state.blindBids || {}
  const entries = Object.entries(blindBids).map(([cid, amount]) => ({ captainId: Number(cid), amount: Number(amount) }))

  if (entries.length === 0) {
    // No one bid — nominator wins at minimum bid
    const nominator = await queryOne('SELECT * FROM captains WHERE id = $1', [state.nominatorId])
    const bid = nominator && nominator.budget === 0 ? 0 : settings.minimumBid
    await setAuctionState(compId, {
      blindPhase: false, blindBids: {}, topBidderIds: [], revealedBids: [],
      currentBid: bid, currentBidderId: state.nominatorId, status: 'bidding',
    })
    await startCompBidTimer(compId, io)
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
    return
  }

  // Sort descending by amount
  entries.sort((a, b) => b.amount - a.amount)

  // Resolve top N (include ties at the cutoff)
  const topN = settings.blindTopBidders
  let cutoffAmount = entries.length > topN ? entries[topN - 1].amount : entries[entries.length - 1].amount
  const topBidders = entries.filter(e => e.amount >= cutoffAmount)
  const topBidderIds = topBidders.map(e => e.captainId)

  // Build revealed bids with captain names
  const captains = await getCaptains(compId)
  const captainMap = Object.fromEntries(captains.map(c => [c.id, c]))
  const revealedBids = entries.map(e => ({
    captainId: e.captainId,
    captainName: captainMap[e.captainId]?.name || 'Unknown',
    amount: e.amount,
    qualified: topBidderIds.includes(e.captainId),
  }))

  // Log revealed bids
  const revealMsg = revealedBids.map(b => `${b.captainName}: ${b.amount}g${b.qualified ? ' (qualified)' : ''}`).join(', ')
  await saveAuctionLog(compId, 'info', `Blind bids revealed: ${revealMsg}`)
  io.to(`comp:${compId}`).emit('auction:log', { type: 'info', message: `Blind bids revealed: ${revealMsg}` })

  if (topBidders.length === 1) {
    // Only 1 bidder — they win at their blind bid price, skip open phase
    const winner = topBidders[0]
    // Record the blind bid in bid_history so undo works
    await execute(
      'INSERT INTO bid_history (competition_id, round, player_id, captain_id, captain_name, amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [compId, Number(state.currentRound), Number(state.nominatedPlayerId), winner.captainId, captainMap[winner.captainId]?.name || '', winner.amount]
    )
    await setAuctionState(compId, {
      blindPhase: false, blindBids: {}, topBidderIds: [], revealedBids,
      currentBid: winner.amount, currentBidderId: winner.captainId,
    })
    // Let finalizeCompBid handle the sale
    finalizeCompBid(compId, io)
    return
  }

  // Multiple top bidders — start open bidding from highest blind bid
  const highestBid = entries[0].amount
  const highestBidder = entries[0].captainId

  // Insert blind bids into bid_history (ascending so highest gets highest id = shown first)
  for (const e of [...entries].reverse()) {
    await execute(
      'INSERT INTO bid_history (competition_id, round, player_id, captain_id, captain_name, amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [compId, Number(state.currentRound), Number(state.nominatedPlayerId), e.captainId, captainMap[e.captainId]?.name || '', e.amount]
    )
  }

  await setAuctionState(compId, {
    blindPhase: false, blindBids: {}, topBidderIds, revealedBids,
    currentBid: highestBid, currentBidderId: highestBidder, status: 'bidding',
  })

  const topNames = topBidderIds.map(id => captainMap[id]?.name || 'Unknown').join(', ')
  await saveAuctionLog(compId, 'info', `Open bidding begins at ${highestBid}g — qualified: ${topNames}`)
  io.to(`comp:${compId}`).emit('auction:log', { type: 'info', message: `Open bidding begins at ${highestBid}g — qualified: ${topNames}` })

  // Start open bid timer (this one resets on each bid like normal)
  await startCompBidTimer(compId, io)
  io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
}

async function finalizeCompBid(compId, io) {
  clearCompBidTimer(compId)
  const comp = await getCompetition(compId)
  if (!comp) return
  const state = parseAuctionState(comp)
  const settings = parseCompSettings(comp)

  const playerId = Number(state.nominatedPlayerId)
  const bidderId = Number(state.currentBidderId)
  const bidAmount = Number(state.currentBid)

  if (playerId && bidderId && bidAmount >= 0) {
    const draftRound = Number(state.currentRound)
    await execute(
      'UPDATE competition_players SET drafted = 1, drafted_by = $1, draft_price = $2, draft_round = $3 WHERE competition_id = $4 AND player_id = $5',
      [bidderId, bidAmount, draftRound, compId, playerId]
    )
    await execute('UPDATE captains SET budget = budget - $1 WHERE id = $2', [bidAmount, bidderId])

    const winner = await queryOne('SELECT name FROM captains WHERE id = $1', [bidderId])
    const player = await queryOne('SELECT name FROM players WHERE id = $1', [playerId])

    io.to(`comp:${compId}`).emit('auction:sold', {
      playerName: player.name,
      captainName: winner.name,
      amount: bidAmount,
    })
    await saveAuctionLog(compId, 'sold', `${player.name} sold to ${winner.name} for ${bidAmount}g`)
    io.to(`comp:${compId}`).emit('auction:log', { type: 'sold', message: `${player.name} sold to ${winner.name} for ${bidAmount}g` })
  }

  const currentRound = Number(state.currentRound)
  const totalRounds = Number(state.totalRounds)
  const captains = await getCaptains(compId)
  const totalPlayers = settings.playersPerTeam * captains.length

  const draftedRow = await queryOne(
    'SELECT COUNT(*) as count FROM competition_players WHERE competition_id = $1 AND drafted = 1', [compId]
  )
  const draftedCount = parseInt(draftedRow.count)

  const allTeamsFull = draftedCount >= totalPlayers || currentRound >= totalRounds
  if (allTeamsFull && settings.autoFinish) {
    await setAuctionState(compId, {
      status: 'finished', nominatedPlayerId: '', currentBid: 0, currentBidderId: '',
    })
    await saveAuctionLog(compId, 'end', 'Draft complete! All players drafted.')
    io.to(`comp:${compId}`).emit('auction:log', { type: 'end', message: 'Draft complete! All players drafted.' })
    io.to(`comp:${compId}`).emit('auction:finished', { results: 'Draft complete!' })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  } else {
    const nextRound = currentRound + 1
    const nextNominator = await getNextNominator(compId, nextRound, captains, settings)

    await setAuctionState(compId, {
      status: 'nominating',
      currentRound: nextRound,
      nominatorId: nextNominator.id,
      nominatedPlayerId: '',
      currentBid: 0,
      currentBidderId: '',
      bidTimerEnd: 0,
      blindPhase: false, blindBids: {}, topBidderIds: [], revealedBids: null,
    })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  }
}

export function registerAuctionHandlers(socket, io) {
  // Captain Ready
  socket.on('captain:ready', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return socket.emit('auction:error', { message: 'Not in a competition room' })
    const captainId = await getSocketCaptainId(socket.id, compId)
    if (!captainId) return socket.emit('auction:error', { message: 'Not a captain' })
    if (!compReadyCaptains.has(compId)) compReadyCaptains.set(compId, new Set())
    compReadyCaptains.get(compId).add(captainId)
    io.to(`comp:${compId}`).emit('captains:ready', getReadyCaptainIds(compId))
  })

  socket.on('captain:unready', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return socket.emit('auction:error', { message: 'Not in a competition room' })
    const captainId = await getSocketCaptainId(socket.id, compId)
    if (!captainId) return socket.emit('auction:error', { message: 'Not a captain' })
    compReadyCaptains.get(compId)?.delete(captainId)
    io.to(`comp:${compId}`).emit('captains:ready', getReadyCaptainIds(compId))
  })

  // Auction: Start
  socket.on('auction:start', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) {
      return socket.emit('auction:error', { message: 'Admin access required' })
    }
    const captains = await getCaptains(compId)
    if (captains.length < 2) {
      return socket.emit('auction:error', { message: 'Need at least 2 captains' })
    }

    const comp = await getCompetition(compId)
    const settings = parseCompSettings(comp)

    if (settings.requireAllOnline) {
      const readySet = compReadyCaptains.get(compId) || new Set()
      const allReady = captains.every(c => readySet.has(c.id))
      if (!allReady) {
        return socket.emit('auction:error', { message: 'All captains must be ready before starting' })
      }
    }

    const totalRounds = settings.playersPerTeam * captains.length

    await execute('UPDATE captains SET status = $1 WHERE competition_id = $2', ['Ready', compId])
    await execute(
      'UPDATE competition_players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL WHERE competition_id = $1',
      [compId]
    )
    await execute('DELETE FROM bid_history WHERE competition_id = $1', [compId])
    await execute('DELETE FROM auction_log WHERE competition_id = $1', [compId])

    const firstNominator = await getNextNominator(compId, 1, await getCaptains(compId), settings)
    await setAuctionState(compId, {
      status: 'nominating',
      currentRound: 1,
      totalRounds,
      nominatorId: firstNominator.id,
      nominatedPlayerId: '',
      currentBid: 0,
      currentBidderId: '',
      bidTimerEnd: 0,
    })

    await execute("UPDATE competitions SET status = 'active' WHERE id = $1 AND status != 'active'", [compId])

    compReadyCaptains.get(compId)?.clear()
    io.to(`comp:${compId}`).emit('captains:ready', getReadyCaptainIds(compId))
    await saveAuctionLog(compId, 'start', `Draft started with ${captains.length} captains`)
    io.to(`comp:${compId}`).emit('auction:log', { type: 'start', message: `Draft started with ${captains.length} captains` })
    io.to(`comp:${compId}`).emit('auction:started')
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
    io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
  })

  // Auction: Nominate
  socket.on('auction:nominate', async ({ playerId, startingBid }) => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    const captainId = await getSocketCaptainId(socket.id, compId)
    const isAdmin = await isAdminSocket(socket.id)
    const comp = await getCompetition(compId)
    const state = parseAuctionState(comp)

    const settings = parseCompSettings(comp)

    if (settings.biddingType === 'blind') {
      if (!isAdmin) {
        return socket.emit('auction:error', { message: 'Only admin can nominate in blind bidding mode' })
      }
    } else if (!isAdmin && captainId !== Number(state.nominatorId)) {
      return socket.emit('auction:error', { message: 'Not your turn to nominate' })
    }
    if (state.status !== 'nominating') {
      return socket.emit('auction:error', { message: 'Not in nomination phase' })
    }
    const onlineIds = getOnlineCaptainIds(compId)
    const allCaptains = await getCaptains(compId)
    const activeCaptains = []
    for (const c of allCaptains) {
      if (await getCaptainPlayerCount(compId, c.id) < settings.playersPerTeam) activeCaptains.push(c)
    }
    if (settings.requireAllOnline) {
      const allOnline = activeCaptains.every(c => onlineIds.includes(c.id))
      if (!allOnline) {
        const offlineNames = activeCaptains.filter(c => !onlineIds.includes(c.id)).map(c => c.name)
        return socket.emit('auction:error', { message: `Waiting for: ${offlineNames.join(', ')}` })
      }
    }

    const cp = await queryOne(
      'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2 AND drafted = 0',
      [compId, playerId]
    )
    if (!cp) return socket.emit('auction:error', { message: 'Player not available' })

    const nominator = await queryOne('SELECT * FROM captains WHERE id = $1', [state.nominatorId])
    const bid = nominator && nominator.budget === 0 ? 0 : Math.max(settings.minimumBid, Number(startingBid) || settings.minimumBid)

    if (nominator && bid > nominator.budget) {
      return socket.emit('auction:error', { message: `Starting bid ${bid}g exceeds your budget of ${nominator.budget}g` })
    }

    if (nominator && await getCaptainPlayerCount(compId, nominator.id) >= settings.playersPerTeam) {
      return socket.emit('auction:error', { message: 'Your team is already full' })
    }

    const nominatorName = nominator?.name
    const player = await queryOne('SELECT name FROM players WHERE id = $1', [playerId])

    if (settings.biddingType === 'blind') {
      // Blind bidding: enter blind phase
      await setAuctionState(compId, {
        status: 'bidding',
        nominatedPlayerId: playerId,
        currentBid: bid,
        currentBidderId: state.nominatorId,
        blindPhase: true,
        blindBids: {},
        topBidderIds: [],
        revealedBids: null,
      })
      await saveAuctionLog(compId, 'nomination', `${nominatorName} nominated ${player.name} — blind bidding starts (min ${bid}g)`)
      io.to(`comp:${compId}`).emit('auction:log', { type: 'nomination', message: `${nominatorName} nominated ${player.name} — blind bidding starts (min ${bid}g)` })
    } else {
      // Default bidding
      await setAuctionState(compId, {
        status: 'bidding',
        nominatedPlayerId: playerId,
        currentBid: bid,
        currentBidderId: state.nominatorId,
      })
      await execute(
        'INSERT INTO bid_history (competition_id, round, player_id, captain_id, captain_name, amount) VALUES ($1, $2, $3, $4, $5, $6)',
        [compId, Number(state.currentRound), playerId, Number(state.nominatorId), nominatorName, bid]
      )
      await saveAuctionLog(compId, 'nomination', `${nominatorName} nominated ${player.name} for ${bid}g`)
      io.to(`comp:${compId}`).emit('auction:log', { type: 'nomination', message: `${nominatorName} nominated ${player.name} for ${bid}g` })
    }

    await startCompBidTimer(compId, io)
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  // Auction: Blind Bid (sealed bid during blind phase)
  socket.on('auction:blind-bid', async ({ amount }) => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    const captainId = await getSocketCaptainId(socket.id, compId)
    if (!captainId) return socket.emit('auction:error', { message: 'Not authorized to bid' })

    const comp = await getCompetition(compId)
    const state = parseAuctionState(comp)
    if (state.status !== 'bidding' || !state.blindPhase) {
      return socket.emit('auction:error', { message: 'Not in blind bidding phase' })
    }

    const captain = await queryOne('SELECT * FROM captains WHERE id = $1', [captainId])
    if (!captain) return socket.emit('auction:error', { message: 'Captain not found' })

    const settings = parseCompSettings(comp)
    if (await getCaptainPlayerCount(compId, captainId) >= settings.playersPerTeam) {
      return socket.emit('auction:error', { message: 'Your team is already full' })
    }

    if (amount < settings.minimumBid) return socket.emit('auction:error', { message: `Minimum bid is ${settings.minimumBid}g` })
    if (amount > captain.budget) return socket.emit('auction:error', { message: 'Insufficient budget' })
    if (settings.maxBid > 0 && amount > settings.maxBid) return socket.emit('auction:error', { message: `Max bid is ${settings.maxBid}g` })

    // Store/update blind bid (captains can update before timer ends)
    const blindBids = state.blindBids || {}
    blindBids[String(captainId)] = amount
    await setAuctionState(compId, { blindBids })

    // Notify the captain their bid was received (private)
    socket.emit('auction:blind-bid-confirmed', { amount })

    // Broadcast updated count (not amounts) — timer does NOT reset
    const fullState = await getFullAuctionState(compId)
    io.to(`comp:${compId}`).emit('auction:stateChanged', fullState)
  })

  // Auction: Bid
  socket.on('auction:bid', async ({ amount }) => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    const captainId = await getSocketCaptainId(socket.id, compId)
    if (!captainId) return socket.emit('auction:error', { message: 'Not authorized to bid' })

    const now = Date.now()
    const lastBid = compLastBidTime.get(compId) || 0
    if (now - lastBid < BID_COOLDOWN_MS) {
      return socket.emit('auction:error', { message: 'Too fast! Wait a moment.' })
    }

    const comp = await getCompetition(compId)
    const state = parseAuctionState(comp)
    if (state.status !== 'bidding') {
      return socket.emit('auction:error', { message: 'Not in bidding phase' })
    }

    // If in blind phase, reject normal bids
    if (state.blindPhase) {
      return socket.emit('auction:error', { message: 'Use blind bid during blind phase' })
    }

    // If topBidderIds is set (post-blind open phase), only top bidders can bid
    const topBidderIds = state.topBidderIds || []
    if (topBidderIds.length > 0 && !topBidderIds.includes(captainId)) {
      return socket.emit('auction:error', { message: 'You did not qualify from the blind round' })
    }

    const captain = await queryOne('SELECT * FROM captains WHERE id = $1', [captainId])
    if (!captain) return socket.emit('auction:error', { message: 'Captain not found' })

    const settings = parseCompSettings(comp)
    if (await getCaptainPlayerCount(compId, captainId) >= settings.playersPerTeam) {
      return socket.emit('auction:error', { message: 'Your team is already full' })
    }

    const currentBid = Number(state.currentBid)
    if (amount <= currentBid) return socket.emit('auction:error', { message: `Bid must be higher than ${currentBid}g` })
    if (amount - currentBid < settings.bidIncrement) return socket.emit('auction:error', { message: `Minimum increment is ${settings.bidIncrement}g` })
    if (amount > captain.budget) return socket.emit('auction:error', { message: 'Insufficient budget' })
    if (settings.maxBid > 0 && amount > settings.maxBid) return socket.emit('auction:error', { message: `Max bid is ${settings.maxBid}g` })

    await setAuctionState(compId, { currentBid: amount, currentBidderId: captainId })
    compLastBidTime.set(compId, Date.now())

    await execute(
      'INSERT INTO bid_history (competition_id, round, player_id, captain_id, captain_name, amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [compId, Number(state.currentRound), Number(state.nominatedPlayerId), captainId, captain.name, amount]
    )

    const bidPlayer = await queryOne('SELECT name FROM players WHERE id = $1', [state.nominatedPlayerId])
    await saveAuctionLog(compId, 'bid', `${captain.name} bid ${amount}g on ${bidPlayer?.name}`)
    io.to(`comp:${compId}`).emit('auction:log', { type: 'bid', message: `${captain.name} bid ${amount}g on ${bidPlayer?.name}` })
    await startCompBidTimer(compId, io)
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  // Auction: Pause
  socket.on('auction:pause', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })
    clearCompBidTimer(compId)
    await setAuctionState(compId, { bidTimerEnd: 0, status: 'paused' })
    await saveAuctionLog(compId, 'pause', 'Auction paused by admin')
    io.to(`comp:${compId}`).emit('auction:log', { type: 'pause', message: 'Auction paused by admin' })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  // Auction: Resume
  socket.on('auction:resume', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })
    const comp = await getCompetition(compId)
    const state = parseAuctionState(comp)
    if (state.nominatedPlayerId) {
      await setAuctionState(compId, { status: 'bidding' })
      await startCompBidTimer(compId, io)
    } else {
      await setAuctionState(compId, { status: 'nominating' })
    }
    await saveAuctionLog(compId, 'resume', 'Auction resumed by admin')
    io.to(`comp:${compId}`).emit('auction:log', { type: 'resume', message: 'Auction resumed by admin' })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  // Auction: Recheck nomination order (admin, while paused)
  socket.on('auction:recheck-order', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })
    const comp = await getCompetition(compId)
    const state = parseAuctionState(comp)
    if (state.status !== 'paused' && state.status !== 'nominating') {
      return socket.emit('auction:error', { message: 'Can only recheck order while paused or nominating' })
    }
    const settings = parseCompSettings(comp)
    if (settings.nominationOrder === 'normal') {
      return socket.emit('auction:error', { message: 'Round-robin order does not need rechecking' })
    }
    const captains = await getCaptains(compId)
    const currentRound = Number(state.currentRound) || 1
    const nextNominator = await getNextNominator(compId, currentRound, captains, settings)
    await setAuctionState(compId, { nominatorId: nextNominator.id })
    await saveAuctionLog(compId, 'info', `Nomination order rechecked — next: ${nextNominator.name}`)
    io.to(`comp:${compId}`).emit('auction:log', { type: 'info', message: `Nomination order rechecked — next: ${nextNominator.name}` })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  // Auction: Set nominator (admin, while paused/nominating)
  socket.on('auction:set-nominator', async ({ captainId }) => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })
    const comp = await getCompetition(compId)
    const state = parseAuctionState(comp)
    if (state.status !== 'paused' && state.status !== 'nominating') {
      return socket.emit('auction:error', { message: 'Can only change nominator while paused or nominating' })
    }
    const captain = await queryOne('SELECT * FROM captains WHERE id = $1 AND competition_id = $2', [captainId, compId])
    if (!captain) return socket.emit('auction:error', { message: 'Captain not found' })
    await setAuctionState(compId, { nominatorId: captainId })
    await saveAuctionLog(compId, 'info', `Nominator changed to ${captain.name} by admin`)
    io.to(`comp:${compId}`).emit('auction:log', { type: 'info', message: `Nominator changed to ${captain.name} by admin` })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  // Auction: End
  socket.on('auction:end', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })
    clearCompBidTimer(compId)
    await setAuctionState(compId, {
      status: 'finished', nominatedPlayerId: '', currentBid: 0, currentBidderId: '',
    })
    await saveAuctionLog(compId, 'end', 'Draft ended by admin')
    io.to(`comp:${compId}`).emit('auction:log', { type: 'end', message: 'Draft ended by admin' })
    io.to(`comp:${compId}`).emit('auction:finished', { results: 'Draft ended by admin' })
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
  })

  // Auction: Undo
  socket.on('auction:undo', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })

    const comp = await getCompetition(compId)
    const state = parseAuctionState(comp)
    const settings = parseCompSettings(comp)

    if (state.status === 'bidding' || (state.status === 'paused' && state.nominatedPlayerId)) {
      clearCompBidTimer(compId)
      const nominatedPlayer = await queryOne('SELECT name FROM players WHERE id = $1', [state.nominatedPlayerId])
      await execute('DELETE FROM bid_history WHERE competition_id = $1 AND round = $2', [compId, Number(state.currentRound)])
      await setAuctionState(compId, {
        status: 'nominating', nominatedPlayerId: '', currentBid: 0, currentBidderId: '', bidTimerEnd: 0,
        blindPhase: false, blindBids: {}, topBidderIds: [], revealedBids: null,
      })
      io.to(`comp:${compId}`).emit('auction:undone', { message: `Nomination of ${nominatedPlayer?.name || 'player'} was cancelled` })
      await saveAuctionLog(compId, 'undo', `Undo: nomination of ${nominatedPlayer?.name || 'player'} cancelled`)
      io.to(`comp:${compId}`).emit('auction:log', { type: 'undo', message: `Undo: nomination of ${nominatedPlayer?.name || 'player'} cancelled` })
      io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
      return
    }

    if (state.status === 'nominating' || state.status === 'finished' || state.status === 'paused') {
      const currentRound = Number(state.currentRound)
      const prevRound = state.status === 'finished' ? currentRound : currentRound - 1
      if (prevRound < 1) return socket.emit('auction:error', { message: 'Nothing to undo' })

      const lastBid = await queryOne(
        'SELECT * FROM bid_history WHERE competition_id = $1 AND round = $2 ORDER BY id DESC LIMIT 1',
        [compId, prevRound]
      )
      if (!lastBid) return socket.emit('auction:error', { message: 'Nothing to undo' })

      const cp = await queryOne(
        'SELECT * FROM competition_players WHERE competition_id = $1 AND player_id = $2',
        [compId, lastBid.player_id]
      )
      if (!cp || !cp.drafted) return socket.emit('auction:error', { message: 'Nothing to undo' })

      const buyer = await queryOne('SELECT name FROM captains WHERE id = $1', [cp.drafted_by])
      const playerName = (await queryOne('SELECT name FROM players WHERE id = $1', [lastBid.player_id]))?.name
      const undoMsg = `${playerName} (${cp.draft_price}g from ${buyer?.name || 'unknown'}) was reversed`

      await execute('UPDATE captains SET budget = budget + $1 WHERE id = $2', [cp.draft_price, cp.drafted_by])
      await execute(
        'UPDATE competition_players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL WHERE id = $1',
        [cp.id]
      )
      await execute('DELETE FROM bid_history WHERE competition_id = $1 AND round = $2', [compId, prevRound])

      const captains = await getCaptains(compId)
      const nextNominator = await getNextNominator(compId, prevRound, captains, settings)
      await setAuctionState(compId, {
        status: 'nominating',
        currentRound: prevRound,
        nominatorId: nextNominator.id,
        nominatedPlayerId: '',
        currentBid: 0,
        currentBidderId: '',
        bidTimerEnd: 0,
      })

      io.to(`comp:${compId}`).emit('auction:undone', { message: undoMsg })
      await saveAuctionLog(compId, 'undo', `Undo: ${undoMsg}`)
      io.to(`comp:${compId}`).emit('auction:log', { type: 'undo', message: `Undo: ${undoMsg}` })
      io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
      io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
      io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
      return
    }

    socket.emit('auction:error', { message: 'Nothing to undo' })
  })

  // Auction: Reset
  socket.on('auction:reset', async () => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId) return
    if (!await isAdminSocket(socket.id)) return socket.emit('auction:error', { message: 'Admin access required' })

    clearCompBidTimer(compId)
    compReadyCaptains.get(compId)?.clear()

    const comp = await getCompetition(compId)
    const settings = parseCompSettings(comp)
    await execute('UPDATE captains SET budget = $1, status = $2 WHERE competition_id = $3', [settings.startingBudget, 'Waiting', compId])
    await execute(
      'UPDATE competition_players SET drafted = 0, drafted_by = NULL, draft_price = NULL, draft_round = NULL WHERE competition_id = $1',
      [compId]
    )
    await execute('DELETE FROM bid_history WHERE competition_id = $1', [compId])
    await execute('DELETE FROM auction_log WHERE competition_id = $1', [compId])
    await setAuctionState(compId, {
      status: 'idle', currentRound: 0, nominatorId: '', nominatedPlayerId: '',
      currentBid: 0, currentBidderId: '', bidTimerEnd: 0, totalRounds: 0,
      blindPhase: false, blindBids: {}, topBidderIds: [], revealedBids: null,
    })

    io.to(`comp:${compId}`).emit('captains:ready', getReadyCaptainIds(compId))
    io.to(`comp:${compId}`).emit('auction:stateChanged', await getFullAuctionState(compId))
    io.to(`comp:${compId}`).emit('captains:updated', await getCaptains(compId))
    io.to(`comp:${compId}`).emit('players:updated', await getCompPlayers(compId))
  })
}
