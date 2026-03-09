import { queryOne } from '../db.js'
import { hasPermission } from '../middleware/permissions.js'

// Per-competition state maps
export const socketPlayers = new Map()       // socketId -> playerId
export const socketCompetitions = new Map()  // socketId -> compId
export const compOnlineCaptains = new Map()  // compId -> Map<socketId, captainId>
export const compReadyCaptains = new Map()   // compId -> Set<captainId>
export const compBidTimers = new Map()       // compId -> timeout
export const compLastBidTime = new Map()     // compId -> timestamp
export const BID_COOLDOWN_MS = 300

export function getOnlineCaptainIds(compId) {
  const map = compOnlineCaptains.get(compId)
  if (!map) return []
  return [...new Set(map.values())]
}

export function getReadyCaptainIds(compId) {
  const set = compReadyCaptains.get(compId)
  if (!set) return []
  return [...set]
}

export async function isAdminSocket(socketId) {
  const playerId = socketPlayers.get(socketId)
  if (!playerId) return false
  const player = await queryOne('SELECT * FROM players WHERE id = $1', [playerId])
  return await hasPermission(player, 'manage_auction')
}

export async function getSocketCaptainId(socketId, compId) {
  const playerId = socketPlayers.get(socketId)
  if (!playerId) return null
  const captain = await queryOne(
    'SELECT id FROM captains WHERE player_id = $1 AND competition_id = $2', [playerId, compId]
  )
  return captain?.id || null
}

export function clearCompBidTimer(compId) {
  const timer = compBidTimers.get(compId)
  if (timer) {
    clearTimeout(timer)
    compBidTimers.delete(compId)
  }
}
