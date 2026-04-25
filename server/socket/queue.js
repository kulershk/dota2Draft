import { query, queryOne, execute } from '../db.js'
import { socketPlayers } from './state.js'
import {
  poolQueues, activeQueueMatches, queuePickTimers,
  playerInQueue, playerInMatch,
  pendingReadyChecks, playerInReadyCheck, nextReadyCheckId,
  getPoolQueue, getPoolQueueCount, getPoolQueuePlayers, clearPickTimer,
} from './queueState.js'
import { botPool } from '../services/botPool.js'

// Generate pick order for a given team size (snake draft).
// For 5v5: [1,2,2,1,1,2,2,1] — captain 1 picks first, then captain 2 picks
// back-to-back, then captain 1 back-to-back, etc., so each captain ends up
// with the same number of picks and neither gets two in a row at the start.
// For 1v1: no picks needed (both are captains).
function generatePickOrder(teamSize) {
  if (teamSize <= 1) return []
  const picks = []
  const totalPicks = (teamSize - 1) * 2
  for (let i = 0; i < totalPicks; i++) {
    if (i === 0) picks.push(1)
    else if (i % 2 === 1) picks.push(picks[i - 1] === 1 ? 2 : 1) // odd index: switch
    else picks.push(picks[i - 1]) // even index (>0): same as previous (back-to-back)
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

      // Check queue ban
      const ban = await queryOne(
        `SELECT qb.banned_until, qb.reason, ab.name AS banned_by_name
           FROM queue_bans qb
           LEFT JOIN players ab ON ab.id = qb.banned_by
          WHERE qb.player_id = $1 AND (qb.banned_until IS NULL OR qb.banned_until > NOW())`,
        [playerId]
      )
      if (ban) {
        // Also re-broadcast myState so the client's banner shows up even if
        // it hadn't received it yet (e.g. ban applied during this session).
        socket.emit('queue:myState', {
          inQueue: false, poolId: null, poolName: null,
          inMatch: !!playerInMatch.get(playerId), queueMatchId: playerInMatch.get(playerId) || null,
          count: 0, players: [],
          ban: {
            bannedUntil: ban.banned_until ? new Date(ban.banned_until).toISOString() : null,
            reason: ban.reason || null,
            bannedBy: ban.banned_by_name || null,
          },
        })
        return socket.emit('queue:error', { message: 'You are banned from queue' })
      }

      // Check not already in queue or active match
      if (playerInQueue.has(playerId)) return socket.emit('queue:error', { message: 'Already in a queue' })
      if (playerInMatch.has(playerId)) return socket.emit('queue:error', { message: 'Already in an active match' })
      if (playerInReadyCheck.has(playerId)) return socket.emit('queue:error', { message: 'Ready check in progress — accept or decline first' })

      // Also check the DB — in-memory state is wiped on server restart, so a
      // player whose queue match is still picking/lobby/live in the DB must
      // remain blocked from re-queuing until that match is completed/cancelled.
      const dbActive = await queryOne(`
        SELECT id FROM queue_matches
        WHERE status IN ('picking', 'lobby_creating', 'live')
          AND all_player_ids @> $1::jsonb
        LIMIT 1
      `, [JSON.stringify([playerId])])
      if (dbActive) {
        // Re-hydrate the in-memory flag so subsequent checks short-circuit
        playerInMatch.set(playerId, dbActive.id)
        return socket.emit('queue:error', { message: 'Already in an active match' })
      }

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

      // Check if enough players — start ready check instead of going straight
      // into picking. Players must Accept within pool.accept_timer seconds.
      if (q.size >= totalPlayers) {
        await startReadyCheck(poolId, io)
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

  // ── Ready check: accept ──
  socket.on('queue:accept', ({ readyCheckId }) => {
    const playerId = socketPlayers.get(socket.id)
    if (!playerId) return
    const rc = pendingReadyChecks.get(Number(readyCheckId))
    if (!rc) return
    if (!rc.players.some(p => p.playerId === playerId)) return
    if (rc.declined.has(playerId)) return // already declined, can't flip
    rc.accepted.add(playerId)

    io.to(`ready-check:${rc.id}`).emit('queue:readyCheckUpdate', {
      readyCheckId: rc.id,
      acceptedIds: [...rc.accepted],
      declinedIds: [...rc.declined],
      expectedCount: rc.players.length,
    })

    if (rc.accepted.size >= rc.players.length) {
      resolveReadyCheck(rc.id, io, { reason: 'all_accepted' })
    }
  })

  // ── Ready check: decline ──
  socket.on('queue:decline', ({ readyCheckId }) => {
    const playerId = socketPlayers.get(socket.id)
    if (!playerId) return
    const rc = pendingReadyChecks.get(Number(readyCheckId))
    if (!rc) return
    if (!rc.players.some(p => p.playerId === playerId)) return
    rc.declined.add(playerId)
    rc.accepted.delete(playerId)

    io.to(`ready-check:${rc.id}`).emit('queue:readyCheckUpdate', {
      readyCheckId: rc.id,
      acceptedIds: [...rc.accepted],
      declinedIds: [...rc.declined],
      expectedCount: rc.players.length,
    })

    // Any decline → end immediately, don't waste other players' time
    resolveReadyCheck(rc.id, io, { reason: 'declined' })
  })

  // ── Player: set their role preferences for this queue match ──
  // Any participant (captain or not) can signal roles they want to play,
  // in ranked order. Captains see these to inform their picks.
  socket.on('queue:setRolePreferences', async ({ queueMatchId, roles }) => {
    const playerId = socketPlayers.get(socket.id)
    if (!playerId) return
    const match = activeQueueMatches.get(queueMatchId)
    if (!match) return
    if (!match.allPlayers.some(p => p.playerId === playerId)) return

    const cleaned = sanitizeRoles(roles)
    match.rolePreferences[playerId] = cleaned

    try {
      await execute(
        'UPDATE queue_matches SET role_preferences = $1 WHERE id = $2',
        [JSON.stringify(match.rolePreferences), queueMatchId]
      )
    } catch (e) {
      console.error('[Queue] Failed to persist role preferences:', e.message)
    }

    io.to(`queue-match:${queueMatchId}`).emit('queue:rolePreferencesUpdate', {
      queueMatchId,
      playerId,
      roles: cleaned,
    })
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

  // ── Get *my* current state (used on app boot / page reload / route change) ──
  // Unlike queue:getState (which needs a poolId), this figures out from the
  // server-side maps whether the authenticated player is already in a queue
  // or an active match, rejoins the appropriate socket rooms, and re-sends
  // the state events so the client can restore its UI.
  socket.on('queue:getMyState', async () => {
    const playerId = socketPlayers.get(socket.id)
    if (!playerId) return socket.emit('queue:myState', { inQueue: false, inMatch: false })

    // Check DB-backed match gating (survives server restart)
    if (!playerInMatch.has(playerId)) {
      try {
        const dbActive = await queryOne(`
          SELECT id FROM queue_matches
          WHERE status IN ('picking', 'lobby_creating', 'live')
            AND all_player_ids @> $1::jsonb
          LIMIT 1
        `, [JSON.stringify([playerId])])
        if (dbActive) playerInMatch.set(playerId, dbActive.id)
      } catch {}
    }

    const inQueuePoolId = playerInQueue.get(playerId) || null
    const inMatchId = playerInMatch.get(playerId) || null

    let poolName = null
    if (inQueuePoolId) {
      const pool = await queryOne('SELECT name FROM queue_pools WHERE id = $1', [inQueuePoolId])
      poolName = pool?.name || null
      socket.join(`queue:${inQueuePoolId}`)
      socketWatchingPool.set(socket.id, inQueuePoolId)
    }

    // Active queue ban (if any) so the client can show a blocking banner
    // with a live countdown before the user even tries to join.
    let ban = null
    try {
      const row = await queryOne(
        `SELECT qb.banned_until, qb.reason, ab.name AS banned_by_name
           FROM queue_bans qb
           LEFT JOIN players ab ON ab.id = qb.banned_by
          WHERE qb.player_id = $1 AND (qb.banned_until IS NULL OR qb.banned_until > NOW())`,
        [playerId]
      )
      if (row) {
        ban = {
          bannedUntil: row.banned_until ? new Date(row.banned_until).toISOString() : null,
          reason: row.reason || null,
          bannedBy: row.banned_by_name || null,
        }
      }
    } catch {}

    socket.emit('queue:myState', {
      inQueue: !!inQueuePoolId,
      poolId: inQueuePoolId,
      poolName,
      inMatch: !!inMatchId,
      queueMatchId: inMatchId,
      count: inQueuePoolId ? getPoolQueueCount(inQueuePoolId) : 0,
      players: inQueuePoolId ? getPoolQueuePlayers(inQueuePoolId) : [],
      ban,
    })

    // If they're in an active match in memory, also re-send match state so
    // navigating to /queue while in pick phase lands back on the right screen.
    if (inMatchId) {
      const match = activeQueueMatches.get(inMatchId)
      if (match) {
        socket.join(`queue-match:${inMatchId}`)
        socket.emit('queue:matchFound', buildMatchFoundPayload(match))
        if (match.status === 'picking') {
          socket.emit('queue:pickState', buildPickStatePayload(match))
        } else {
          const team1 = [match.captain1, ...match.captain1Picks]
          const team2 = [match.captain2, ...match.captain2Picks]
          socket.emit('queue:teamsFormed', { queueMatchId: inMatchId, team1, team2 })

          // If the lobby has already been created (status=live) or even just
          // exists in the DB while we're still flipping match.status from
          // lobby_creating to live, send queue:lobbyCreated too. Without this,
          // a refresh during/after lobby creation lands the user on a stuck
          // "Creating lobby…" spinner until they navigate away and back.
          try {
            const qm = await queryOne('SELECT match_id FROM queue_matches WHERE id = $1', [inMatchId])
            if (qm?.match_id) {
              const lobby = await queryOne(
                "SELECT game_name, password, created_at, players_joined FROM match_lobbies WHERE match_id = $1 ORDER BY id DESC LIMIT 1",
                [qm.match_id]
              )
              if (lobby) {
                const timeoutMs = (match.pool?.lobby_timeout_minutes || 10) * 60 * 1000
                const expiresAt = match.lobbyExpiresAt || (new Date(lobby.created_at).getTime() + timeoutMs)
                const playersJoined = Array.isArray(lobby.players_joined)
                  ? lobby.players_joined
                  : (typeof lobby.players_joined === 'string' ? JSON.parse(lobby.players_joined) : [])
                socket.emit('queue:lobbyCreated', {
                  queueMatchId: inMatchId,
                  matchId: qm.match_id,
                  lobbyInfo: { gameName: lobby.game_name, password: lobby.password },
                  lobbyExpiresAt: expiresAt,
                  playersJoined,
                })
              }
            }
          } catch {}
        }
      }
    }

    // Rehydrate ready-check state on reload so the Accept modal comes back up
    const rcId = playerInReadyCheck.get(playerId)
    if (rcId) {
      const rc = pendingReadyChecks.get(rcId)
      if (rc) {
        socket.join(`ready-check:${rcId}`)
        socket.emit('queue:readyCheck', {
          readyCheckId: rc.id,
          poolId: rc.poolId,
          players: rc.players,
          acceptTimerEnd: rc.acceptTimerEnd,
          acceptTimerSeconds: rc.acceptTimerSeconds,
          expectedCount: rc.players.length,
        })
        socket.emit('queue:readyCheckUpdate', {
          readyCheckId: rc.id,
          acceptedIds: [...rc.accepted],
          declinedIds: [...rc.declined],
          expectedCount: rc.players.length,
        })
      }
    }
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

    queryOne('SELECT id, name, display_name, avatar_url, mmr_verified_at FROM players WHERE id = $1', [playerId])
      .then(p => {
        if (!p) return
        const msg = {
          id: ++chatMsgSeq,
          poolId,
          playerId,
          name: p.display_name || p.name,
          avatarUrl: p.avatar_url,
          mmrVerifiedAt: p.mmr_verified_at || null,
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

    // Rehydrate ready-check state too
    if (playerId) {
      const rcId = playerInReadyCheck.get(playerId)
      if (rcId) {
        const rc = pendingReadyChecks.get(rcId)
        if (rc) {
          socket.join(`ready-check:${rcId}`)
          socket.emit('queue:readyCheck', {
            readyCheckId: rc.id,
            poolId: rc.poolId,
            players: rc.players,
            acceptTimerEnd: rc.acceptTimerEnd,
            acceptTimerSeconds: rc.acceptTimerSeconds,
            expectedCount: rc.players.length,
          })
          socket.emit('queue:readyCheckUpdate', {
            readyCheckId: rc.id,
            acceptedIds: [...rc.accepted],
            declinedIds: [...rc.declined],
            expectedCount: rc.players.length,
          })
        }
      }
    }

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

          // Send queue:lobbyCreated whenever a lobby row exists, not only when
          // match.status flipped to 'live'. The server briefly reports
          // 'lobby_creating' between the lobby being inserted and status being
          // updated; a refresh in that window must still rehydrate the lobby UI.
          const qm = await queryOne('SELECT match_id FROM queue_matches WHERE id = $1', [qmId])
          if (qm?.match_id) {
            const lobby = await queryOne(
              "SELECT game_name, password, created_at, players_joined FROM match_lobbies WHERE match_id = $1 ORDER BY id DESC LIMIT 1",
              [qm.match_id]
            )
            if (lobby) {
              const timeoutMs = (match.pool?.lobby_timeout_minutes || 10) * 60 * 1000
              const expiresAt = match.lobbyExpiresAt || (new Date(lobby.created_at).getTime() + timeoutMs)
              const playersJoined = Array.isArray(lobby.players_joined)
                ? lobby.players_joined
                : (typeof lobby.players_joined === 'string' ? JSON.parse(lobby.players_joined) : [])
              socket.emit('queue:lobbyCreated', {
                queueMatchId: qmId,
                matchId: qm.match_id,
                lobbyInfo: { gameName: lobby.game_name, password: lobby.password },
                lobbyExpiresAt: expiresAt,
                playersJoined,
              })
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

    // Do NOT cancel the match when a player disconnects during the pick
    // phase. The existing pick timer + autoPickHighestMmr will auto-pick
    // for an absent captain, so the match progresses even if someone
    // closed their tab. Cancelling on disconnect just punishes everyone
    // else for one player's page refresh.
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
  // Broadcast aggregate counts so every client (even those not subscribed to
  // this specific pool's room) can update their pool-selector badges.
  const counts = {}
  for (const [pid, q] of poolQueues) counts[pid] = q.size
  io.emit('queue:poolCounts', counts)
}

// Public: kick a player from whatever queue they're in. Used by admin routes.
// Removes them from the in-memory queue state, drops their sockets out of the
// queue room, and notifies them individually so their client can reset UI.
export function kickPlayerFromQueue(io, playerId, reason = null) {
  const poolId = playerInQueue.get(playerId)
  if (!poolId) return false

  const q = poolQueues.get(poolId)
  if (q) q.delete(playerId)
  playerInQueue.delete(playerId)

  // Leave queue room on every socket this player is connected on
  for (const [socketId, pid] of socketPlayers) {
    if (pid === playerId) {
      const s = io.sockets.sockets.get(socketId)
      if (s) {
        s.leave(`queue:${poolId}`)
        s.emit('queue:kicked', { poolId, reason: reason || 'Removed from queue by admin' })
      }
    }
  }

  // Broadcast updated count/list to everyone still watching the pool
  broadcastQueueUpdate(io, poolId)
  return true
}

// Start a ready check for a full pool: pull the top N players out of the pool
// queue, emit queue:readyCheck to each, and start the accept timer. Only once
// all N players click Accept does startQueueMatch run (picking phase).
async function startReadyCheck(poolId, io) {
  const q = getPoolQueue(poolId)
  const pool = await queryOne('SELECT * FROM queue_pools WHERE id = $1', [poolId])
  const teamSize = pool?.team_size || 5
  const totalPlayers = teamSize * 2
  if (q.size < totalPlayers) return

  // Pull top N players out of the queue (oldest first — Map insertion order)
  const players = []
  for (const [, info] of q) {
    players.push(info)
    if (players.length >= totalPlayers) break
  }

  // Move from in-queue → in-ready-check
  for (const p of players) {
    q.delete(p.playerId)
    playerInQueue.delete(p.playerId)
  }

  const id = nextReadyCheckId()
  const acceptTimerSeconds = pool?.accept_timer || 20
  const declineBanMinutes = Math.max(0, pool?.decline_ban_minutes || 0)
  const acceptTimerEnd = Date.now() + acceptTimerSeconds * 1000

  const rc = {
    id,
    poolId,
    pool,
    players,
    accepted: new Set(),
    declined: new Set(),
    acceptTimerEnd,
    acceptTimerSeconds,
    declineBanMinutes,
    timeoutHandle: null,
  }
  pendingReadyChecks.set(id, rc)
  for (const p of players) {
    playerInReadyCheck.set(p.playerId, id)
  }

  // Join all players' sockets to the ready-check room
  joinPlayersToRoom(io, players, `ready-check:${id}`)

  io.to(`ready-check:${id}`).emit('queue:readyCheck', {
    readyCheckId: id,
    poolId,
    players,
    acceptTimerEnd,
    acceptTimerSeconds,
    expectedCount: players.length,
  })

  broadcastQueueUpdate(io, poolId)

  rc.timeoutHandle = setTimeout(() => {
    resolveReadyCheck(id, io, { reason: 'timeout' })
  }, acceptTimerSeconds * 1000)
}

// Resolve a ready check in one of three ways:
//   all_accepted → promote to picking via startQueueMatch(pool, players)
//   declined / timeout → non-accepters are kicked (+ optional ban),
//                        accepters are re-queued to preserve their wait time
async function resolveReadyCheck(id, io, { reason }) {
  const rc = pendingReadyChecks.get(id)
  if (!rc) return
  pendingReadyChecks.delete(id)
  if (rc.timeoutHandle) { clearTimeout(rc.timeoutHandle); rc.timeoutHandle = null }

  for (const p of rc.players) {
    if (playerInReadyCheck.get(p.playerId) === id) playerInReadyCheck.delete(p.playerId)
  }

  if (reason === 'all_accepted') {
    io.to(`ready-check:${id}`).emit('queue:readyCheckPassed', { readyCheckId: id })
    // Leave ready-check room on every player socket (will join match room next)
    for (const [socketId, pid] of socketPlayers) {
      if (rc.players.some(p => p.playerId === pid)) {
        const s = io.sockets.sockets.get(socketId)
        if (s) s.leave(`ready-check:${id}`)
      }
    }
    await startQueueMatch(rc.poolId, io, rc.players, rc.pool)
    return
  }

  // Failure path: only punish players whose own action (or inaction) caused it.
  //   declined: end fired immediately when someone clicked Decline — only the
  //             decliners are at fault. Everyone else (including still-pending
  //             players who hadn't had time to click yet) gets requeued.
  //   timeout:  accept window expired — anyone who didn't accept is at fault.
  const bannedPlayers = reason === 'declined'
    ? rc.players.filter(p => rc.declined.has(p.playerId))
    : rc.players.filter(p => !rc.accepted.has(p.playerId))
  const bannedIds = new Set(bannedPlayers.map(p => p.playerId))
  const requeuedPlayers = rc.players.filter(p => !bannedIds.has(p.playerId))

  // Ban the at-fault players if the pool has a ban configured
  if (rc.declineBanMinutes > 0 && bannedPlayers.length > 0) {
    const reasonText = reason === 'declined' ? 'Declined ready check' : 'Did not accept ready check in time'
    try {
      await execute(
        `INSERT INTO queue_bans (player_id, banned_until, reason, banned_by)
         SELECT unnest($1::int[]), NOW() + ($2 || ' minutes')::interval, $3, NULL
         ON CONFLICT (player_id) DO UPDATE
           SET banned_until = GREATEST(COALESCE(queue_bans.banned_until, NOW()), EXCLUDED.banned_until),
               reason = EXCLUDED.reason`,
        [bannedPlayers.map(p => p.playerId), rc.declineBanMinutes, reasonText]
      )
    } catch (e) {
      console.error('[Queue] Failed to record decline bans:', e.message)
    }
  }

  // Notify banned players (kicked out of queue — they need to re-queue manually
  // once the ban expires). Leave the ready-check room.
  for (const p of bannedPlayers) {
    for (const [socketId, pid] of socketPlayers) {
      if (pid !== p.playerId) continue
      const s = io.sockets.sockets.get(socketId)
      if (!s) continue
      s.leave(`ready-check:${id}`)
      s.emit('queue:readyCheckFailed', {
        readyCheckId: id,
        reason,
        requeued: false,
        banMinutes: rc.declineBanMinutes || 0,
      })
    }
  }

  // Non-banned players go back to the front of the queue so they don't lose
  // wait time. Rebuild the pool queue with them prepended, then existing entries.
  if (requeuedPlayers.length > 0) {
    const pool = await queryOne('SELECT * FROM queue_pools WHERE id = $1', [rc.poolId])
    if (pool?.enabled) {
      const q = getPoolQueue(rc.poolId)
      const existing = [...q.values()]
      q.clear()
      for (const p of requeuedPlayers) {
        // Skip if they've since joined a different queue/match somehow
        if (playerInQueue.has(p.playerId) || playerInMatch.has(p.playerId) || playerInReadyCheck.has(p.playerId)) continue
        q.set(p.playerId, p)
        playerInQueue.set(p.playerId, rc.poolId)
      }
      for (const info of existing) {
        if (!q.has(info.playerId)) q.set(info.playerId, info)
      }
    }
    for (const p of requeuedPlayers) {
      for (const [socketId, pid] of socketPlayers) {
        if (pid !== p.playerId) continue
        const s = io.sockets.sockets.get(socketId)
        if (!s) continue
        s.leave(`ready-check:${id}`)
        s.emit('queue:readyCheckFailed', {
          readyCheckId: id,
          reason,
          requeued: true,
          banMinutes: 0,
        })
      }
    }
  }

  broadcastQueueUpdate(io, rc.poolId)

  // If the pool is still full (enough in queue to start another check), kick one off
  const q = getPoolQueue(rc.poolId)
  const pool = rc.pool || await queryOne('SELECT * FROM queue_pools WHERE id = $1', [rc.poolId])
  const totalPlayers = (pool?.team_size || 5) * 2
  if (q.size >= totalPlayers) {
    await startReadyCheck(rc.poolId, io)
  }
}

async function startQueueMatch(poolId, io, preselectedPlayers = null, preselectedPool = null) {
  const pool = preselectedPool || await queryOne('SELECT * FROM queue_pools WHERE id = $1', [poolId])
  const teamSize = pool?.team_size || 5
  const totalPlayers = teamSize * 2

  let players
  if (preselectedPlayers) {
    // Came from a passed ready check — players are already removed from queue
    players = preselectedPlayers.slice(0, totalPlayers)
  } else {
    const q = getPoolQueue(poolId)
    if (q.size < totalPlayers) return
    players = []
    for (const [, info] of q) {
      players.push(info)
      if (players.length >= totalPlayers) break
    }
    for (const p of players) {
      q.delete(p.playerId)
      playerInQueue.delete(p.playerId)
    }
  }

  // Sort by MMR descending — top 2 are captains.
  // Captain 1 picks first; assign captain 1 = LOWER MMR of the two so the
  // weaker captain gets first pick. If MMRs are equal, pick randomly.
  players.sort((a, b) => b.mmr - a.mmr)
  const top1 = players[0]
  const top2 = players[1]
  let captain1, captain2
  if (top1.mmr === top2.mmr) {
    if (Math.random() < 0.5) { captain1 = top1; captain2 = top2 }
    else { captain1 = top2; captain2 = top1 }
  } else {
    // top1 has higher mmr → captain2; top2 has lower mmr → captain1 (picks first)
    captain1 = top2
    captain2 = top1
  }
  const available = players.slice(2)

  const pickOrder = generatePickOrder(teamSize)
  const pickTimer = pool?.pick_timer || 30

  // Insert queue_matches row. Snapshot the pool's season_id so later changes
  // to the pool don't retroactively rewrite this match's rating attribution.
  const qm = await queryOne(`
    INSERT INTO queue_matches (pool_id, captain1_player_id, captain2_player_id, all_player_ids, status, season_id)
    VALUES ($1, $2, $3, $4, 'picking', $5) RETURNING *
  `, [poolId, captain1.playerId, captain2.playerId, JSON.stringify(players.map(p => p.playerId)), pool?.season_id || null])

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
    // playerId -> ordered array of role keys (carry, mid, offlane, support, hard_support)
    rolePreferences: {},
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
  // Guard: don't finalize twice (e.g. race between manual pick + auto-pick)
  if (match.status !== 'picking') return

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

async function cancelQueueMatch(queueMatchId, reason, io) {
  const match = activeQueueMatches.get(queueMatchId)

  clearPickTimer(queueMatchId)

  // Update DB regardless of in-memory state
  execute(`UPDATE queue_matches SET status = 'cancelled' WHERE id = $1`, [queueMatchId]).catch(() => {})

  // Notify players in the room (broadcast even if memory is empty — anyone
  // still subscribed should know it died)
  io.to(`queue-match:${queueMatchId}`).emit('queue:cancelled', { queueMatchId, reason })

  // Collect player IDs from in-memory state if present, otherwise fall back
  // to the persisted roster — this is the safety net for the case where
  // memory drifted out of sync but playerInMatch still has stale entries.
  let allPlayerIds = match ? match.allPlayers.map(p => p.playerId) : []
  if (!allPlayerIds.length) {
    try {
      const roster = await queryOne(
        'SELECT team1_players, team2_players FROM queue_matches WHERE id = $1',
        [queueMatchId]
      )
      allPlayerIds = [
        ...((roster?.team1_players || []).map(p => p.playerId)),
        ...((roster?.team2_players || []).map(p => p.playerId)),
      ]
    } catch (e) {
      console.error('[cancelQueueMatch] roster fallback failed:', e.message)
    }
  }

  // Free playerInMatch only for those still pinned to THIS match (so we don't
  // accidentally release a player who's already moved into a new match)
  for (const pid of allPlayerIds) {
    if (playerInMatch.get(pid) === queueMatchId) playerInMatch.delete(pid)
  }

  // Leave room
  const room = `queue-match:${queueMatchId}`
  for (const [socketId, playerId] of socketPlayers) {
    if (allPlayerIds.includes(playerId)) {
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
    rolePreferences: match.rolePreferences || {},
  }
}

const VALID_ROLES = ['carry', 'mid', 'offlane', 'support', 'hard_support']
function sanitizeRoles(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const r of input) {
    if (typeof r !== 'string') continue
    if (!VALID_ROLES.includes(r)) continue
    if (seen.has(r)) continue
    seen.add(r)
    out.push(r)
    if (out.length >= VALID_ROLES.length) break
  }
  return out
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
