import { query, queryOne, execute } from '../db.js'
import { socketPlayers } from './state.js'
import {
  poolQueues, activeQueueMatches, queuePickTimers,
  playerInQueue, playerInMatch,
  getPoolQueue, getPoolQueueCount, getPoolQueuePlayers, clearPickTimer,
} from './queueState.js'
import { botPool } from '../services/botPool.js'

// Generate pick order for a given team size
// For 5v5: [1,2,2,1,1,2,2,1] (8 picks for 8 non-captain players)
// For 1v1: no picks needed (both are captains)
function generatePickOrder(teamSize) {
  if (teamSize <= 1) return [] // 1v1: no picks, both players are captains
  const picks = []
  const totalPicks = (teamSize - 1) * 2 // each team needs teamSize-1 more players
  // Standard alternating: 1, 2, 2, 1, 1, 2, 2, 1, ...
  for (let i = 0; i < totalPicks; i++) {
    const phase = Math.floor(i / 2) // 0,0,1,1,2,2,...
    if (i === 0) picks.push(1) // first pick always captain 1
    else if (i % 2 === 1) picks.push(picks[i - 1]) // same as previous (back-to-back)
    else picks.push(picks[i - 1] === 1 ? 2 : 1) // switch
  }
  return picks
}

// Cache pool sizes to avoid DB lookups on every join check
const poolSizeCache = new Map() // poolId -> { teamSize, totalPlayers }

// Per-pool chat history (last 50 messages)
const poolChatHistory = new Map() // poolId -> [{ id, playerId, name, avatarUrl, text, ts }]
// Per-player rate limit timestamps for chat
const lastChatAt = new Map() // playerId -> ms timestamp
// Track which pool a socket is currently watching (for chat room membership)
const socketWatchingPool = new Map() // socketId -> poolId
let chatMsgSeq = 0
const CHAT_RATE_LIMIT_MS = 1000
const CHAT_HISTORY_MAX = 50
const CHAT_TEXT_MAX = 300

export function registerQueueHandlers(socket, io) {

  // ── Join queue ──
  socket.on('queue:join', async ({ poolId }) => {
    const playerId = socketPlayers.get(socket.id)
    if (!playerId) return socket.emit('queue:error', { message: 'Not authenticated' })

    try {
      // Validate pool exists and is enabled
      const pool = await queryOne('SELECT * FROM queue_pools WHERE id = $1 AND enabled = true', [poolId])
      if (!pool) return socket.emit('queue:error', { message: 'Queue pool not found or disabled' })

      // Check player has steam_id and mmr set
      const player = await queryOne('SELECT id, name, display_name, steam_id, avatar_url, mmr FROM players WHERE id = $1', [playerId])
      if (!player?.steam_id) return socket.emit('queue:error', { message: 'Steam account required to queue' })
      if (!player.mmr || player.mmr <= 0) return socket.emit('queue:error', { message: 'You must set your MMR before queuing' })

      // Check MMR range
      if (pool.min_mmr > 0 && player.mmr < pool.min_mmr) return socket.emit('queue:error', { message: `Minimum MMR for this pool is ${pool.min_mmr}` })
      if (pool.max_mmr > 0 && player.mmr > pool.max_mmr) return socket.emit('queue:error', { message: `Maximum MMR for this pool is ${pool.max_mmr}` })

      // Check not already in queue or active match
      if (playerInQueue.has(playerId)) return socket.emit('queue:error', { message: 'Already in a queue' })
      if (playerInMatch.has(playerId)) return socket.emit('queue:error', { message: 'Already in an active match' })

      // Add to queue
      const q = getPoolQueue(poolId)
      q.set(playerId, {
        playerId,
        name: player.display_name || player.name,
        steamId: player.steam_id,
        avatarUrl: player.avatar_url,
        mmr: player.mmr,
      })
      playerInQueue.set(playerId, poolId)
      socket.join(`queue:${poolId}`)

      // Cache pool size
      const teamSize = pool.team_size || 5
      const totalPlayers = teamSize * 2
      poolSizeCache.set(poolId, { teamSize, totalPlayers })

      // Broadcast updated queue
      broadcastQueueUpdate(io, poolId)

      // Check if enough players
      if (q.size >= totalPlayers) {
        await startQueueMatch(poolId, io)
      }
    } catch (e) {
      console.error('[Queue] Join error:', e.message)
      socket.emit('queue:error', { message: 'Failed to join queue' })
    }
  })

  // ── Leave queue ──
  socket.on('queue:leave', () => {
    const playerId = socketPlayers.get(socket.id)
    if (!playerId) return

    const poolId = playerInQueue.get(playerId)
    if (!poolId) return

    removeFromQueue(playerId, poolId, socket)
    broadcastQueueUpdate(io, poolId)
  })

  // ── Captain pick ──
  socket.on('queue:pick', async ({ queueMatchId, playerId: pickedPlayerId }) => {
    const playerId = socketPlayers.get(socket.id)
    if (!playerId) return socket.emit('queue:error', { message: 'Not authenticated' })

    const match = activeQueueMatches.get(queueMatchId)
    if (!match) return socket.emit('queue:error', { message: 'Match not found' })

    // Validate it's this player's turn
    const currentCaptainNum = match.pickOrder[match.pickIndex]
    const currentCaptain = currentCaptainNum === 1 ? match.captain1 : match.captain2
    if (currentCaptain.playerId !== playerId) return socket.emit('queue:error', { message: 'Not your turn to pick' })

    // Validate picked player is available
    const pickedIdx = match.availablePlayers.findIndex(p => p.playerId === pickedPlayerId)
    if (pickedIdx === -1) return socket.emit('queue:error', { message: 'Player not available' })

    makePick(queueMatchId, match, pickedIdx, io)
  })

  // ── Chat send ──
  socket.on('queue:chatSend', ({ poolId, text }) => {
    const playerId = socketPlayers.get(socket.id)
    if (!playerId) return socket.emit('queue:error', { message: 'Not authenticated' })
    if (!poolId || typeof text !== 'string') return
    const trimmed = text.trim()
    if (!trimmed) return

    const now = Date.now()
    const last = lastChatAt.get(playerId) || 0
    if (now - last < CHAT_RATE_LIMIT_MS) {
      return socket.emit('queue:chatRateLimited', { retryAfterMs: CHAT_RATE_LIMIT_MS - (now - last) })
    }
    lastChatAt.set(playerId, now)

    queryOne('SELECT id, name, display_name, avatar_url FROM players WHERE id = $1', [playerId])
      .then(p => {
        if (!p) return
        const msg = {
          id: ++chatMsgSeq,
          poolId,
          playerId,
          name: p.display_name || p.name,
          avatarUrl: p.avatar_url,
          text: trimmed.slice(0, CHAT_TEXT_MAX),
          ts: now,
        }
        const hist = poolChatHistory.get(poolId) || []
        hist.push(msg)
        if (hist.length > CHAT_HISTORY_MAX) hist.splice(0, hist.length - CHAT_HISTORY_MAX)
        poolChatHistory.set(poolId, hist)
        io.to(`queue:${poolId}`).emit('queue:chatMessage', msg)
      })
      .catch(() => {})
  })

  // ── Get state (on page load) ──
  socket.on('queue:getState', async ({ poolId }) => {
    const playerId = socketPlayers.get(socket.id)

    // Join the pool's chat room (leaving any previous one)
    const prevPool = socketWatchingPool.get(socket.id)
    if (prevPool && prevPool !== poolId) {
      // Only leave if not actively queued in that pool
      if (!playerId || playerInQueue.get(playerId) !== prevPool) {
        socket.leave(`queue:${prevPool}`)
      }
    }
    socket.join(`queue:${poolId}`)
    socketWatchingPool.set(socket.id, poolId)

    // Send chat history
    socket.emit('queue:chatHistory', { poolId, messages: poolChatHistory.get(poolId) || [] })

    // Send queue count
    socket.emit('queue:updated', {
      poolId,
      count: getPoolQueueCount(poolId),
      players: getPoolQueuePlayers(poolId),
    })

    // If player is in an active match, re-send appropriate state
    if (playerId && playerInMatch.has(playerId)) {
      const qmId = playerInMatch.get(playerId)
      const match = activeQueueMatches.get(qmId)
      if (match) {
        socket.join(`queue-match:${qmId}`)
        socket.emit('queue:matchFound', buildMatchFoundPayload(match))

        if (match.status === 'picking') {
          socket.emit('queue:pickState', buildPickStatePayload(match))
        } else {
          // Teams are already formed (lobby_creating or live)
          const team1 = [match.captain1, ...match.captain1Picks]
          const team2 = [match.captain2, ...match.captain2Picks]
          socket.emit('queue:teamsFormed', { queueMatchId: qmId, team1, team2 })

          if (match.status === 'live') {
            const qm = await queryOne('SELECT match_id FROM queue_matches WHERE id = $1', [qmId])
            if (qm?.match_id) {
              const lobby = await queryOne(
                "SELECT game_name, password, created_at FROM match_lobbies WHERE match_id = $1 ORDER BY id DESC LIMIT 1",
                [qm.match_id]
              )
              if (lobby) {
                const timeoutMs = (match.pool?.lobby_timeout_minutes || 10) * 60 * 1000
                const expiresAt = match.lobbyExpiresAt || (new Date(lobby.created_at).getTime() + timeoutMs)
                socket.emit('queue:lobbyCreated', {
                  queueMatchId: qmId,
                  matchId: qm.match_id,
                  lobbyInfo: { gameName: lobby.game_name, password: lobby.password },
                  lobbyExpiresAt: expiresAt,
                })
              }
            }
          }
        }
      }
    }
  })

  // ── Disconnect handling ──
  socket.on('disconnect', () => {
    socketWatchingPool.delete(socket.id)
    const playerId = socketPlayers.get(socket.id)
    if (!playerId) return

    // Check if player has other connected sockets
    const hasOther = [...socketPlayers.entries()].some(([sid, p]) => p === playerId && sid !== socket.id)
    if (hasOther) return

    // Remove from queue if queued
    const poolId = playerInQueue.get(playerId)
    if (poolId) {
      removeFromQueue(playerId, poolId, socket)
      broadcastQueueUpdate(io, poolId)
    }

    // Cancel active match if in pick phase
    const qmId = playerInMatch.get(playerId)
    if (qmId) {
      const match = activeQueueMatches.get(qmId)
      if (match && match.status === 'picking') {
        cancelQueueMatch(qmId, 'A player disconnected', io)
      }
    }
  })
}

// ── Helpers ──

function removeFromQueue(playerId, poolId, socket) {
  const q = poolQueues.get(poolId)
  if (q) q.delete(playerId)
  playerInQueue.delete(playerId)
  if (socket) socket.leave(`queue:${poolId}`)
}

function broadcastQueueUpdate(io, poolId) {
  io.to(`queue:${poolId}`).emit('queue:updated', {
    poolId,
    count: getPoolQueueCount(poolId),
    players: getPoolQueuePlayers(poolId),
  })
}

async function startQueueMatch(poolId, io) {
  const q = getPoolQueue(poolId)
  const pool = await queryOne('SELECT * FROM queue_pools WHERE id = $1', [poolId])
  const teamSize = pool?.team_size || 5
  const totalPlayers = teamSize * 2

  if (q.size < totalPlayers) return

  // Take players from queue
  const players = []
  for (const [pid, info] of q) {
    players.push(info)
    if (players.length >= totalPlayers) break
  }

  // Remove them from queue
  for (const p of players) {
    q.delete(p.playerId)
    playerInQueue.delete(p.playerId)
  }

  // Sort by MMR descending — top 2 are captains
  players.sort((a, b) => b.mmr - a.mmr)
  const captain1 = players[0]
  const captain2 = players[1]
  const available = players.slice(2)

  const pickOrder = generatePickOrder(teamSize)
  const pickTimer = pool?.pick_timer || 30

  // Insert queue_matches row
  const qm = await queryOne(`
    INSERT INTO queue_matches (pool_id, captain1_player_id, captain2_player_id, all_player_ids, status)
    VALUES ($1, $2, $3, $4, 'picking') RETURNING *
  `, [poolId, captain1.playerId, captain2.playerId, JSON.stringify(players.map(p => p.playerId))])

  const queueMatchId = qm.id
  const match = {
    id: queueMatchId,
    poolId,
    pool,
    teamSize,
    pickOrder,
    captain1,
    captain2,
    captain1Picks: [],
    captain2Picks: [],
    availablePlayers: available,
    allPlayers: players,
    pickIndex: 0,
    pickTimer,
    pickTimerEnd: null,
    status: 'picking',
  }
  activeQueueMatches.set(queueMatchId, match)

  // Mark all players as in-match
  for (const p of players) {
    playerInMatch.set(p.playerId, queueMatchId)
  }

  // Join all 10 players' sockets to the match room
  joinPlayersToRoom(io, players, `queue-match:${queueMatchId}`)

  // Emit match found
  io.to(`queue-match:${queueMatchId}`).emit('queue:matchFound', buildMatchFoundPayload(match))

  // Broadcast updated queue count
  broadcastQueueUpdate(io, poolId)

  // For 1v1 (no picks needed), go straight to finalize
  if (pickOrder.length === 0) {
    finalizeQueueMatch(queueMatchId, io)
  } else {
    startPickTimer(queueMatchId, io)
  }
}

function joinPlayersToRoom(io, players, room) {
  const playerIds = new Set(players.map(p => p.playerId))
  for (const [socketId, playerId] of socketPlayers) {
    if (playerIds.has(playerId)) {
      const s = io.sockets.sockets.get(socketId)
      if (s) s.join(room)
    }
  }
}

function startPickTimer(queueMatchId, io) {
  clearPickTimer(queueMatchId)
  const match = activeQueueMatches.get(queueMatchId)
  if (!match || match.status !== 'picking') return

  const endTime = Date.now() + match.pickTimer * 1000
  match.pickTimerEnd = endTime

  io.to(`queue-match:${queueMatchId}`).emit('queue:pickState', buildPickStatePayload(match))

  const timer = setTimeout(() => {
    autoPickHighestMmr(queueMatchId, io)
  }, match.pickTimer * 1000)
  queuePickTimers.set(queueMatchId, timer)
}

function autoPickHighestMmr(queueMatchId, io) {
  const match = activeQueueMatches.get(queueMatchId)
  if (!match || match.status !== 'picking' || match.availablePlayers.length === 0) return

  // Auto-pick highest MMR available
  const sorted = [...match.availablePlayers].sort((a, b) => b.mmr - a.mmr)
  const pickedIdx = match.availablePlayers.indexOf(sorted[0])
  makePick(queueMatchId, match, pickedIdx, io)
}

function makePick(queueMatchId, match, pickedIdx, io) {
  clearPickTimer(queueMatchId)

  const picked = match.availablePlayers.splice(pickedIdx, 1)[0]
  const captainNum = match.pickOrder[match.pickIndex]

  if (captainNum === 1) {
    match.captain1Picks.push(picked)
  } else {
    match.captain2Picks.push(picked)
  }
  match.pickIndex++

  io.to(`queue-match:${queueMatchId}`).emit('queue:pickMade', {
    queueMatchId,
    captainNum,
    pickedPlayer: picked,
  })

  // Check if all picks done
  if (match.pickIndex >= match.pickOrder.length) {
    finalizeQueueMatch(queueMatchId, io)
  } else {
    startPickTimer(queueMatchId, io)
  }
}

async function finalizeQueueMatch(queueMatchId, io) {
  const match = activeQueueMatches.get(queueMatchId)
  if (!match) return

  match.status = 'lobby_creating'

  const team1 = [match.captain1, ...match.captain1Picks]
  const team2 = [match.captain2, ...match.captain2Picks]

  // Update queue_matches with team picks
  await execute(`
    UPDATE queue_matches SET team1_players = $1, team2_players = $2, status = 'lobby_creating'
    WHERE id = $3
  `, [JSON.stringify(team1), JSON.stringify(team2), queueMatchId])

  io.to(`queue-match:${queueMatchId}`).emit('queue:teamsFormed', {
    queueMatchId,
    team1,
    team2,
  })

  // Create a match row (no competition_id)
  try {
    const gameName = `${match.captain1.name} vs ${match.captain2.name}`
    const matchRow = await queryOne(`
      INSERT INTO matches (competition_id, stage, round, match_order, best_of, status)
      VALUES (NULL, 0, 0, 0, $1, 'live') RETURNING *
    `, [match.pool?.best_of || 1])

    // Link queue_matches to matches
    await execute('UPDATE queue_matches SET match_id = $1 WHERE id = $2', [matchRow.id, queueMatchId])

    // Create match_games row
    await execute(`
      INSERT INTO match_games (match_id, game_number) VALUES ($1, 1)
      ON CONFLICT (match_id, game_number) DO NOTHING
    `, [matchRow.id])

    // Create lobby via botPool
    const team1Players = team1.map(p => ({ steam_id: p.steamId, name: p.name, team: 'radiant' }))
    const team2Players = team2.map(p => ({ steam_id: p.steamId, name: p.name, team: 'dire' }))

    const lobby = await botPool.createQueueLobby(match.poolId, matchRow.id, 1, team1Players, team2Players)

    await execute(`UPDATE queue_matches SET status = 'live' WHERE id = $1`, [queueMatchId])
    match.status = 'live'

    const timeoutMs = (match.pool?.lobby_timeout_minutes || 10) * 60 * 1000
    match.lobbyExpiresAt = Date.now() + timeoutMs

    io.to(`queue-match:${queueMatchId}`).emit('queue:lobbyCreated', {
      queueMatchId,
      matchId: matchRow.id,
      lobbyInfo: {
        gameName: lobby.game_name,
        password: lobby.password,
      },
      lobbyExpiresAt: match.lobbyExpiresAt,
    })
  } catch (e) {
    console.error('[Queue] Failed to create lobby:', e.message)
    io.to(`queue-match:${queueMatchId}`).emit('queue:error', { message: `Lobby creation failed: ${e.message}` })
    // Don't cancel — keep teams formed, admin/system can retry
  }
}

function cancelQueueMatch(queueMatchId, reason, io) {
  const match = activeQueueMatches.get(queueMatchId)
  if (!match) return

  clearPickTimer(queueMatchId)

  // Update DB
  execute(`UPDATE queue_matches SET status = 'cancelled' WHERE id = $1`, [queueMatchId]).catch(() => {})

  // Notify players
  io.to(`queue-match:${queueMatchId}`).emit('queue:cancelled', { queueMatchId, reason })

  // Clean up player-in-match tracking
  for (const p of match.allPlayers) {
    playerInMatch.delete(p.playerId)
  }

  // Leave room
  const room = `queue-match:${queueMatchId}`
  for (const [socketId, playerId] of socketPlayers) {
    if (match.allPlayers.some(p => p.playerId === playerId)) {
      const s = io.sockets.sockets.get(socketId)
      if (s) s.leave(room)
    }
  }

  activeQueueMatches.delete(queueMatchId)
}

function buildMatchFoundPayload(match) {
  return {
    queueMatchId: match.id,
    players: match.allPlayers,
    captain1: match.captain1,
    captain2: match.captain2,
    availablePlayers: match.availablePlayers,
    pickOrder: match.pickOrder,
    teamSize: match.teamSize,
    pickTimer: match.pickTimer,
  }
}

function buildPickStatePayload(match) {
  const currentCaptainNum = match.pickIndex < match.pickOrder.length ? match.pickOrder[match.pickIndex] : null
  return {
    queueMatchId: match.id,
    currentPicker: currentCaptainNum,
    captain1Picks: match.captain1Picks,
    captain2Picks: match.captain2Picks,
    availablePlayers: match.availablePlayers,
    pickTimerEnd: match.pickTimerEnd,
    pickIndex: match.pickIndex,
    status: match.status,
  }
}
