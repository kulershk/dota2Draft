import { queryOne, execute } from '../db.js'
import { getSessionPlayerId } from '../middleware/auth.js'
import { getPlayerPermissions } from '../middleware/permissions.js'
import { getFullAuctionState, getAuctionLog, getCaptains, getCompetition } from '../helpers/competition.js'
import {
  socketPlayers, socketCompetitions, compOnlineCaptains, compReadyCaptains,
  getOnlineCaptainIds, getReadyCaptainIds, playerActivity, bannedSockets,
} from './state.js'
import { registerAuctionHandlers } from './auction.js'
import { registerMatchReadyHandlers } from './matchReady.js'
import { registerQueueHandlers } from './queue.js'
import { logSocketEvent } from '../middleware/requestLogger.js'

// Permissions that gate access to private socket events. Sockets join
// `perm:<name>` rooms for each one the player holds (or all of them if
// is_admin), and admin-scoped emits target those rooms — keeps bot logs,
// MMR verification activity, etc. off non-admin sockets.
const PRIVATE_PERMS = ['manage_bots', 'manage_mmr_verifications']

// Global kill switch. When false, the connection-gate middleware below
// rejects new socket handshakes; routes/settings.js also calls
// io.disconnectSockets(true) on toggle to drop existing connections.
// Hydrated from `site_sockets_enabled` at server boot.
let socketsEnabled = true
export function setSocketsEnabled(value) { socketsEnabled = !!value }
export function getSocketsEnabled() { return socketsEnabled }

export function initSocket(io) {
  io.use((socket, next) => {
    if (!socketsEnabled) return next(new Error('sockets_disabled'))
    next()
  })

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`)

    socket.use(([event, payload], next) => {
      let path = null
      if (event === 'activity' && payload && typeof payload === 'object') {
        const p = typeof payload.path === 'string' ? payload.path : null
        if (p) path = p.length > 200 ? p.slice(0, 200) : p
      }
      logSocketEvent({
        event,
        userId: socketPlayers.get(socket.id) || null,
        competitionId: socketCompetitions.get(socket.id) || null,
        path,
      })
      // Block all events from banned sockets except auth itself.
      if (event !== 'auth' && bannedSockets.has(socket.id)) {
        socket.emit('error', { code: 'banned' })
        return // drop the packet
      }
      next()
    })

    // Resolve a token to (playerId, is_banned) and update socket state.
    async function applyAuthToken(token) {
      const playerId = getSessionPlayerId(token)
      if (!playerId) return null
      const player = await queryOne('SELECT id, is_banned, is_admin FROM players WHERE id = $1', [playerId])
      if (!player) return null
      socketPlayers.set(socket.id, player.id)
      if (player.is_banned) bannedSockets.add(socket.id)
      else bannedSockets.delete(socket.id)

      // Leave any previously-joined permission rooms before re-keying — the
      // new token might belong to a different player with different perms.
      for (const p of PRIVATE_PERMS) socket.leave(`perm:${p}`)

      // Banned users get no admin events even if they hold the permission.
      if (!player.is_banned) {
        if (player.is_admin) {
          for (const p of PRIVATE_PERMS) socket.join(`perm:${p}`)
        } else {
          const perms = await getPlayerPermissions(player.id).catch(() => new Set())
          for (const p of PRIVATE_PERMS) if (perms.has(p)) socket.join(`perm:${p}`)
        }
      }

      execute('UPDATE players SET last_online = NOW() WHERE id = $1', [player.id]).catch(() => {})
      return player
    }

    // Auth from handshake
    const handshakeToken = socket.handshake.auth?.token
    if (handshakeToken) applyAuthToken(handshakeToken).catch(() => {})

    // Auth from explicit event (fallback)
    socket.on('auth', async ({ token }) => {
      const player = await applyAuthToken(token).catch(() => null)
      if (player) socket.emit('auth:success')
    })

    // Periodic heartbeat to keep last_online fresh
    const heartbeat = setInterval(() => {
      const pid = socketPlayers.get(socket.id)
      if (pid) execute('UPDATE players SET last_online = NOW() WHERE id = $1', [pid]).catch(() => {})
    }, 60 * 1000) // every 1 minute

    // Track user activity (page navigation)
    socket.on('activity', ({ page, path }) => {
      const pid = socketPlayers.get(socket.id)
      if (pid) playerActivity.set(pid, { page: page || '', path: path || '', timestamp: Date.now() })
    })

    socket.on('disconnect', () => {
      clearInterval(heartbeat)
      const pid = socketPlayers.get(socket.id)
      // Only clear activity if no other sockets for this player
      if (pid) {
        const hasOther = [...socketPlayers.entries()].some(([sid, p]) => p === pid && sid !== socket.id)
        if (!hasOther) playerActivity.delete(pid)
      }
    })

    // Time sync
    socket.on('time:sync', () => {
      socket.emit('time:sync', { serverTime: Date.now() })
    })

    // Join competition room
    socket.on('competition:join', async ({ competitionId }) => {
      const compId = competitionId
      if (!compId) return

      // Private competitions require an authenticated socket. Public comps
      // are joinable anonymously (matches the public REST endpoint behavior).
      const comp = await getCompetition(compId)
      if (!comp) return
      if (!comp.is_public && !socketPlayers.has(socket.id)) {
        socket.emit('competition:join:denied', { reason: 'auth_required' })
        return
      }

      const prevCompId = socketCompetitions.get(socket.id)
      if (prevCompId && prevCompId !== compId) {
        socket.leave(`comp:${prevCompId}`)
        const prevOnlineMap = compOnlineCaptains.get(prevCompId)
        if (prevOnlineMap) {
          const captainId = prevOnlineMap.get(socket.id)
          prevOnlineMap.delete(socket.id)
          if (captainId) {
            compReadyCaptains.get(prevCompId)?.delete(captainId)
            io.to(`comp:${prevCompId}`).emit('captains:ready', getReadyCaptainIds(prevCompId))
          }
          io.to(`comp:${prevCompId}`).emit('captains:online', getOnlineCaptainIds(prevCompId))
        }
      }

      socket.join(`comp:${compId}`)
      socketCompetitions.set(socket.id, compId)

      const playerId = socketPlayers.get(socket.id)
      if (playerId) {
        const captain = await queryOne(
          'SELECT id FROM captains WHERE player_id = $1 AND competition_id = $2', [playerId, compId]
        )
        if (captain) {
          if (!compOnlineCaptains.has(compId)) compOnlineCaptains.set(compId, new Map())
          compOnlineCaptains.get(compId).set(socket.id, captain.id)
          io.to(`comp:${compId}`).emit('captains:online', getOnlineCaptainIds(compId))
        }
      }

      socket.emit('auction:stateChanged', await getFullAuctionState(compId))
      socket.emit('captains:online', getOnlineCaptainIds(compId))
      socket.emit('captains:ready', getReadyCaptainIds(compId))
      socket.emit('auction:logHistory', await getAuctionLog(compId))
    })

    // Register auction handlers
    registerAuctionHandlers(socket, io)
    registerMatchReadyHandlers(socket, io)
    registerQueueHandlers(socket, io)

    // Disconnect
    socket.on('disconnect', () => {
      const compId = socketCompetitions.get(socket.id)
      socketPlayers.delete(socket.id)
      socketCompetitions.delete(socket.id)
      bannedSockets.delete(socket.id)

      if (compId) {
        const onlineMap = compOnlineCaptains.get(compId)
        if (onlineMap) {
          const captainId = onlineMap.get(socket.id)
          onlineMap.delete(socket.id)
          if (captainId) {
            compReadyCaptains.get(compId)?.delete(captainId)
            io.to(`comp:${compId}`).emit('captains:ready', getReadyCaptainIds(compId))
          }
          io.to(`comp:${compId}`).emit('captains:online', getOnlineCaptainIds(compId))
        }
      }

      console.log(`Client disconnected: ${socket.id}`)
    })
  })
}
