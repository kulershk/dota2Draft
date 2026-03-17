import { queryOne } from '../db.js'
import { getSessionPlayerId } from '../middleware/auth.js'
import { getFullAuctionState, getAuctionLog, getCaptains } from '../helpers/competition.js'
import {
  socketPlayers, socketCompetitions, compOnlineCaptains, compReadyCaptains,
  getOnlineCaptainIds, getReadyCaptainIds,
} from './state.js'
import { registerAuctionHandlers } from './auction.js'
import { registerMatchReadyHandlers } from './matchReady.js'

export function initSocket(io) {
  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`)

    // Auth from handshake
    const handshakeToken = socket.handshake.auth?.token
    if (handshakeToken) {
      const playerId = getSessionPlayerId(handshakeToken)
      if (playerId) {
        socketPlayers.set(socket.id, playerId)
      }
    }

    // Auth from explicit event (fallback)
    socket.on('auth', ({ token }) => {
      const playerId = getSessionPlayerId(token)
      if (playerId) {
        socketPlayers.set(socket.id, playerId)
        socket.emit('auth:success')
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

    // Disconnect
    socket.on('disconnect', () => {
      const compId = socketCompetitions.get(socket.id)
      socketPlayers.delete(socket.id)
      socketCompetitions.delete(socket.id)

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
