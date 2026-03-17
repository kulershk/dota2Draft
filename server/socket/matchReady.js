import { queryOne, query } from '../db.js'
import {
  socketPlayers, socketCompetitions,
  getMatchReadyCaptainIds, setMatchCaptainReady, setMatchCaptainUnready, clearMatchReady,
  getLaunchReadyCaptainIds, setLaunchCaptainReady, setLaunchCaptainUnready, clearLaunchReady,
} from './state.js'
import { botPool } from '../services/botPool.js'

async function getMatchCaptain(socketId, compId, matchId) {
  const playerId = socketPlayers.get(socketId)
  if (!playerId) return null

  const captain = await queryOne(
    'SELECT id FROM captains WHERE player_id = $1 AND competition_id = $2', [playerId, compId]
  )
  if (!captain) return null

  const match = await queryOne(
    'SELECT * FROM matches WHERE id = $1 AND competition_id = $2', [matchId, compId]
  )
  if (!match) return null
  if (match.team1_captain_id !== captain.id && match.team2_captain_id !== captain.id) return null

  return { captain, match }
}

export function registerMatchReadyHandlers(socket, io) {
  // Phase 1: Ready up to create lobby
  socket.on('match:ready', async ({ matchId, gameNumber }) => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId || !matchId || !gameNumber) return

    const result = await getMatchCaptain(socket.id, compId, matchId)
    if (!result) return
    const { captain, match } = result

    setMatchCaptainReady(matchId, gameNumber, captain.id)

    const readyIds = getMatchReadyCaptainIds(matchId, gameNumber)
    io.to(`comp:${compId}`).emit('match:readyState', { matchId, gameNumber, readyCaptainIds: readyIds })

    // Check if both captains are ready
    const bothReady = match.team1_captain_id && match.team2_captain_id
      && readyIds.includes(match.team1_captain_id) && readyIds.includes(match.team2_captain_id)

    if (bothReady) {
      // Check if lobby already exists for this game
      const existingLobby = await queryOne(
        "SELECT id FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND status NOT IN ('completed', 'cancelled', 'error')",
        [matchId, gameNumber]
      )
      if (existingLobby) return

      // Check if a bot is available
      const availableBot = await queryOne(
        "SELECT id FROM lobby_bots WHERE status = 'available' ORDER BY last_used_at NULLS FIRST LIMIT 1"
      )
      if (!availableBot) {
        io.to(`comp:${compId}`).emit('match:readyState', {
          matchId, gameNumber, readyCaptainIds: readyIds, noBotAvailable: true,
        })
        return
      }

      // Auto-create lobby
      try {
        await botPool.createLobby(compId, matchId, gameNumber, {})
        clearMatchReady(matchId, gameNumber)
        io.to(`comp:${compId}`).emit('match:readyState', {
          matchId, gameNumber, readyCaptainIds: [], lobbyCreated: true,
        })
      } catch (e) {
        console.error('Auto-create lobby failed:', e.message)
      }
    }
  })

  socket.on('match:unready', async ({ matchId, gameNumber }) => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId || !matchId || !gameNumber) return

    const result = await getMatchCaptain(socket.id, compId, matchId)
    if (!result) return

    setMatchCaptainUnready(matchId, gameNumber, result.captain.id)

    const readyIds = getMatchReadyCaptainIds(matchId, gameNumber)
    io.to(`comp:${compId}`).emit('match:readyState', { matchId, gameNumber, readyCaptainIds: readyIds })
  })

  // Phase 2: Ready up to launch game (lobby is in "waiting" state)
  socket.on('match:launchReady', async ({ matchId, gameNumber }) => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId || !matchId || !gameNumber) return

    const result = await getMatchCaptain(socket.id, compId, matchId)
    if (!result) return
    const { captain, match } = result

    // Verify lobby exists and is waiting
    const lobby = await queryOne(
      "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND status = 'waiting'",
      [matchId, gameNumber]
    )
    if (!lobby) return

    // Check all expected players have joined
    const expected = lobby.players_expected ? (typeof lobby.players_expected === 'string' ? JSON.parse(lobby.players_expected) : lobby.players_expected) : []
    const joined = lobby.players_joined ? (typeof lobby.players_joined === 'string' ? JSON.parse(lobby.players_joined) : lobby.players_joined) : []
    if (expected.length > 0 && joined.length < expected.length) {
      socket.emit('match:launchError', { matchId, gameNumber, error: 'Not all players have joined the lobby' })
      return
    }

    setLaunchCaptainReady(matchId, gameNumber, captain.id)

    const readyIds = getLaunchReadyCaptainIds(matchId, gameNumber)
    io.to(`comp:${compId}`).emit('match:launchReadyState', { matchId, gameNumber, readyCaptainIds: readyIds })

    // Check if both captains are launch-ready
    const bothReady = match.team1_captain_id && match.team2_captain_id
      && readyIds.includes(match.team1_captain_id) && readyIds.includes(match.team2_captain_id)

    if (bothReady) {
      try {
        await botPool.forceLaunch(lobby.id)
        clearLaunchReady(matchId, gameNumber)
        io.to(`comp:${compId}`).emit('match:launchReadyState', {
          matchId, gameNumber, readyCaptainIds: [], launched: true,
        })
      } catch (e) {
        console.error('Auto-launch failed:', e.message)
      }
    }
  })

  socket.on('match:launchUnready', async ({ matchId, gameNumber }) => {
    const compId = socketCompetitions.get(socket.id)
    if (!compId || !matchId || !gameNumber) return

    const result = await getMatchCaptain(socket.id, compId, matchId)
    if (!result) return

    setLaunchCaptainUnready(matchId, gameNumber, result.captain.id)

    const readyIds = getLaunchReadyCaptainIds(matchId, gameNumber)
    io.to(`comp:${compId}`).emit('match:launchReadyState', { matchId, gameNumber, readyCaptainIds: readyIds })
  })

  // Get current ready state for a match
  socket.on('match:getReadyState', ({ matchId, gameNumber }) => {
    const readyIds = getMatchReadyCaptainIds(matchId, gameNumber)
    const launchReadyIds = getLaunchReadyCaptainIds(matchId, gameNumber)
    socket.emit('match:readyState', { matchId, gameNumber, readyCaptainIds: readyIds })
    socket.emit('match:launchReadyState', { matchId, gameNumber, readyCaptainIds: launchReadyIds })
  })
}
