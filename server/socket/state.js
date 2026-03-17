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
export const matchReadyCaptains = new Map()  // `${matchId}:${gameNumber}` -> Set<captainId>
export const matchLaunchReadyCaptains = new Map()  // `${matchId}:${gameNumber}` -> Set<captainId>

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

export function getMatchReadyKey(matchId, gameNumber) {
  return `${matchId}:${gameNumber}`
}

export function getMatchReadyCaptainIds(matchId, gameNumber) {
  const key = getMatchReadyKey(matchId, gameNumber)
  const set = matchReadyCaptains.get(key)
  return set ? [...set] : []
}

export function setMatchCaptainReady(matchId, gameNumber, captainId) {
  const key = getMatchReadyKey(matchId, gameNumber)
  if (!matchReadyCaptains.has(key)) matchReadyCaptains.set(key, new Set())
  matchReadyCaptains.get(key).add(captainId)
}

export function setMatchCaptainUnready(matchId, gameNumber, captainId) {
  const key = getMatchReadyKey(matchId, gameNumber)
  matchReadyCaptains.get(key)?.delete(captainId)
}

export function clearMatchReady(matchId, gameNumber) {
  const key = getMatchReadyKey(matchId, gameNumber)
  matchReadyCaptains.delete(key)
}

export function getLaunchReadyCaptainIds(matchId, gameNumber) {
  const key = getMatchReadyKey(matchId, gameNumber)
  const set = matchLaunchReadyCaptains.get(key)
  return set ? [...set] : []
}

export function setLaunchCaptainReady(matchId, gameNumber, captainId) {
  const key = getMatchReadyKey(matchId, gameNumber)
  if (!matchLaunchReadyCaptains.has(key)) matchLaunchReadyCaptains.set(key, new Set())
  matchLaunchReadyCaptains.get(key).add(captainId)
}

export function setLaunchCaptainUnready(matchId, gameNumber, captainId) {
  const key = getMatchReadyKey(matchId, gameNumber)
  matchLaunchReadyCaptains.get(key)?.delete(captainId)
}

export function clearLaunchReady(matchId, gameNumber) {
  const key = getMatchReadyKey(matchId, gameNumber)
  matchLaunchReadyCaptains.delete(key)
}

export function clearCompBidTimer(compId) {
  const timer = compBidTimers.get(compId)
  if (timer) {
    clearTimeout(timer)
    compBidTimers.delete(compId)
  }
}
