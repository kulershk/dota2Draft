import { query, queryOne, execute } from '../db.js'
import { LobbyBot } from './lobbyBot.js'
import { fetchAndSaveGameStats } from '../helpers/opendota.js'

class BotPool {
  constructor() {
    this.bots = new Map() // botId -> LobbyBot instance
    this.activeLobbies = new Map() // lobbyDbId -> { bot, matchId, gameNumber, compId, lobbyUpdateHandler }
    this.io = null
    this.botLogs = new Map() // botId -> [{ time, message }]
  }

  _log(botId, message) {
    const entry = { time: new Date().toISOString(), message }
    if (!this.botLogs.has(botId)) this.botLogs.set(botId, [])
    const logs = this.botLogs.get(botId)
    logs.push(entry)
    if (logs.length > 50) logs.shift() // keep last 50
    console.log(`[Bot ${botId}] ${message}`)
    if (this.io) this.io.emit('bot:log', { botId, ...entry })
  }

  getBotLogs(botId) {
    return this.botLogs.get(botId) || []
  }

  async init(io) {
    this.io = io
    // Load bots from DB but don't auto-connect (admin connects manually)
    const bots = await query('SELECT * FROM lobby_bots')
    for (const bot of bots) {
      // Reset status to offline on restart
      await execute('UPDATE lobby_bots SET status = $1 WHERE id = $2', ['offline', bot.id])
    }
    console.log(`Bot pool initialized with ${bots.length} bot account(s)`)
  }

  async addBot(username, password) {
    const existing = await queryOne('SELECT id FROM lobby_bots WHERE username = $1', [username])
    if (existing) throw new Error('Bot account already exists')

    const bot = await queryOne(
      'INSERT INTO lobby_bots (username, password) VALUES ($1, $2) RETURNING *',
      [username, password]
    )
    return bot
  }

  async removeBot(botId) {
    const instance = this.bots.get(botId)
    if (instance) {
      instance.disconnect()
      this.bots.delete(botId)
    }
    await execute('DELETE FROM lobby_bots WHERE id = $1', [botId])
  }

  async connectBot(botId) {
    const botRow = await queryOne('SELECT * FROM lobby_bots WHERE id = $1', [botId])
    if (!botRow) throw new Error('Bot not found')

    // Disconnect existing instance if any
    const existing = this.bots.get(botId)
    if (existing) {
      existing.disconnect()
      this.bots.delete(botId)
    }

    await execute('UPDATE lobby_bots SET status = $1, error_message = NULL WHERE id = $2', ['connecting', botId])
    this._broadcastBotStatus(botId, 'connecting')
    this._log(botId, `Connecting as ${botRow.username}...`)

    const instance = new LobbyBot(botId, botRow.username, botRow.password, botRow.refresh_token)

    instance.on('steamGuard', (domain) => {
      this._log(botId, `Steam Guard code required${domain ? ` (email: ${domain})` : ' (authenticator)'}`)
      execute('UPDATE lobby_bots SET status = $1 WHERE id = $2', ['awaiting_guard', botId])
      this._broadcastBotStatus(botId, 'awaiting_guard')
      if (this.io) this.io.emit('bot:steamGuardRequired', { botId, username: botRow.username })
    })

    instance.on('steamLoggedOn', async () => {
      const steamId = instance.steamClient?.steamID?.toString() || null
      this._log(botId, `Logged into Steam (${steamId}). Connecting to Dota 2 GC...`)
      await execute(
        'UPDATE lobby_bots SET status = $1, steam_id = $2, error_message = NULL WHERE id = $3',
        ['connecting_gc', steamId, botId]
      )
      this._broadcastBotStatus(botId, 'connecting_gc')
    })

    instance.on('refreshToken', async (token) => {
      this._log(botId, 'Refresh token saved')
      await execute('UPDATE lobby_bots SET refresh_token = $1 WHERE id = $2', [token, botId])
    })

    instance.on('ready', async () => {
      const steamId = instance.steamClient?.steamID?.toString() || null
      const displayName = instance.steamClient?.accountInfo?.name || botRow.username
      this._log(botId, `Dota 2 GC ready! Bot is available.`)
      await execute(
        'UPDATE lobby_bots SET status = $1, steam_id = $2, display_name = $3, error_message = NULL WHERE id = $4',
        ['available', steamId, displayName, botId]
      )
      this._broadcastBotStatus(botId, 'available')
    })

    instance.on('error', async (err) => {
      this._log(botId, `Error: ${err.message}`)
      await execute('UPDATE lobby_bots SET status = $1, error_message = $2 WHERE id = $3', ['error', err.message, botId])
      this._broadcastBotStatus(botId, 'error', err.message)
    })

    instance.on('disconnected', async () => {
      this._log(botId, 'Disconnected from Steam')
      await execute('UPDATE lobby_bots SET status = $1 WHERE id = $2', ['offline', botId])
      this._broadcastBotStatus(botId, 'offline')
    })

    instance.on('gcDisconnected', () => {
      this._log(botId, 'Dota 2 GC disconnected')
    })

    this.bots.set(botId, instance)

    try {
      await instance.login()
    } catch (err) {
      // Steam Guard will be handled via event, other errors are real failures
      if (!instance._steamGuardResolver) {
        await execute('UPDATE lobby_bots SET status = $1, error_message = $2 WHERE id = $3', ['error', err.message, botId])
        this._broadcastBotStatus(botId, 'error', err.message)
        throw err
      }
    }
  }

  async disconnectBot(botId) {
    const instance = this.bots.get(botId)
    if (instance) {
      instance.disconnect()
      this.bots.delete(botId)
    }
    await execute('UPDATE lobby_bots SET status = $1 WHERE id = $2', ['offline', botId])
    this._broadcastBotStatus(botId, 'offline')
  }

  async submitSteamGuard(botId, code) {
    const instance = this.bots.get(botId)
    if (!instance) throw new Error('Bot not connected')
    instance.submitSteamGuardCode(code)
  }

  getAvailableBot() {
    for (const [botId, instance] of this.bots) {
      if (instance.gcReady && !instance.currentLobbyId) {
        return { botId, instance }
      }
    }
    return null
  }

  async getBotStatuses() {
    return await query('SELECT id, username, display_name, steam_id, status, error_message, last_used_at, created_at FROM lobby_bots ORDER BY id')
  }

  async createLobby(compId, matchId, gameNumber, options = {}) {
    // Check for existing lobby
    const existingLobby = await queryOne(
      "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND status NOT IN ('completed', 'cancelled', 'error')",
      [matchId, gameNumber]
    )
    if (existingLobby) throw new Error('A lobby already exists for this game')

    // Find available bot
    const available = this.getAvailableBot()
    if (!available) throw new Error('No available bots. Add more bot accounts or wait for a bot to finish.')

    const { botId, instance } = available

    // Resolve players for both teams
    const match = await queryOne(`
      SELECT m.*, t1.player_id AS t1_player_id, t2.player_id AS t2_player_id,
             t1.team AS team1_name, t2.team AS team2_name
      FROM matches m
      LEFT JOIN captains t1 ON t1.id = m.team1_captain_id
      LEFT JOIN captains t2 ON t2.id = m.team2_captain_id
      WHERE m.id = $1
    `, [matchId])
    if (!match) throw new Error('Match not found')

    const playersExpected = []

    // Get team 1 players (captain + drafted)
    if (match.team1_captain_id) {
      const t1Players = await query(`
        SELECT p.steam_id, COALESCE(p.display_name, p.name) AS name
        FROM competition_players cp
        JOIN players p ON cp.player_id = p.id
        WHERE cp.competition_id = $1 AND cp.drafted_by = $2 AND cp.drafted = 1
      `, [compId, match.team1_captain_id])
      // Add captain
      if (match.t1_player_id) {
        const cap = await queryOne('SELECT steam_id, COALESCE(display_name, name) AS name FROM players WHERE id = $1', [match.t1_player_id])
        if (cap?.steam_id) playersExpected.push({ steam_id: cap.steam_id, name: cap.name, team: 'radiant' })
      }
      for (const p of t1Players) {
        if (p.steam_id && !playersExpected.some(e => e.steam_id === p.steam_id)) {
          playersExpected.push({ steam_id: p.steam_id, name: p.name, team: 'radiant' })
        }
      }
    }

    // Get team 2 players (captain + drafted)
    if (match.team2_captain_id) {
      const t2Players = await query(`
        SELECT p.steam_id, COALESCE(p.display_name, p.name) AS name
        FROM competition_players cp
        JOIN players p ON cp.player_id = p.id
        WHERE cp.competition_id = $1 AND cp.drafted_by = $2 AND cp.drafted = 1
      `, [compId, match.team2_captain_id])
      if (match.t2_player_id) {
        const cap = await queryOne('SELECT steam_id, COALESCE(display_name, name) AS name FROM players WHERE id = $1', [match.t2_player_id])
        if (cap?.steam_id) playersExpected.push({ steam_id: cap.steam_id, name: cap.name, team: 'dire' })
      }
      for (const p of t2Players) {
        if (p.steam_id && !playersExpected.some(e => e.steam_id === p.steam_id)) {
          playersExpected.push({ steam_id: p.steam_id, name: p.name, team: 'dire' })
        }
      }
    }

    const gameName = options.game_name || `${match.team1_name || 'Team 1'} vs ${match.team2_name || 'Team 2'} - Game ${gameNumber}`
    const password = options.password || Math.random().toString(36).slice(2, 8)

    // Create DB record
    const lobby = await queryOne(`
      INSERT INTO match_lobbies (match_id, game_number, competition_id, bot_id, status, server_region, game_name, password, players_expected)
      VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7, $8) RETURNING *
    `, [matchId, gameNumber, compId, botId, options.server_region ?? 3, gameName, password, JSON.stringify(playersExpected)])

    await execute('UPDATE lobby_bots SET status = $1, last_used_at = NOW() WHERE id = $2', ['busy', botId])
    this._broadcastBotStatus(botId, 'busy')

    // Create lobby asynchronously
    this._runLobby(lobby.id, instance, playersExpected, gameName, password, options.server_region ?? 3, compId, matchId, gameNumber)

    return { ...lobby, players_expected: playersExpected }
  }

  async _runLobby(lobbyDbId, bot, playersExpected, gameName, password, serverRegion, compId, matchId, gameNumber) {
    try {
      this._log(bot.botId, `Creating lobby "${gameName}" (region: ${serverRegion})`)
      await bot.createLobby({ game_name: gameName, password, server_region: serverRegion })
      this._log(bot.botId, `Lobby created. Password: ${password}`)

      await execute("UPDATE match_lobbies SET status = 'waiting', updated_at = NOW() WHERE id = $1", [lobbyDbId])
      this._broadcastLobbyStatus(compId, matchId, gameNumber, 'waiting')

      // Invite all players
      const steamIds = playersExpected.map(p => p.steam_id).filter(Boolean)
      this._log(bot.botId, `Inviting ${steamIds.length} players...`)
      bot.invitePlayers(steamIds)

      // Monitor lobby updates
      const lobbyHandler = async (lobbyData) => {
        try {
          await this._handleLobbyUpdate(lobbyDbId, lobbyData, bot, compId, matchId, gameNumber, playersExpected, lobbyHandler)
        } catch (e) {
          console.error('Lobby update handler error:', e.message)
        }
      }
      bot.onLobbyUpdate(lobbyHandler)

      // Store reference for cleanup
      this.activeLobbies.set(lobbyDbId, { bot, matchId, gameNumber, compId, lobbyHandler })

    } catch (err) {
      console.error('Failed to create lobby:', err.message)
      await execute("UPDATE match_lobbies SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2", [err.message, lobbyDbId])
      await execute("UPDATE lobby_bots SET status = 'available' WHERE id = $1", [bot.botId])
      this._broadcastLobbyStatus(compId, matchId, gameNumber, 'error', err.message)
      this._broadcastBotStatus(bot.botId, 'available')
    }
  }

  async _handleLobbyUpdate(lobbyDbId, lobbyData, bot, compId, matchId, gameNumber, playersExpected, lobbyHandler) {
    // Parse who has joined
    const members = lobbyData.all_members || lobbyData.members || []
    const playersJoined = []
    for (const member of members) {
      const steamId = member.id?.toString() || member.steam_id?.toString()
      if (!steamId) continue
      const team = member.team === 0 ? 'radiant' : member.team === 1 ? 'dire' : 'spectator'
      const expected = playersExpected.find(p => p.steam_id === steamId)
      playersJoined.push({
        steam_id: steamId,
        name: expected?.name || 'Unknown',
        team,
        slot: member.slot,
      })
    }

    await execute(
      "UPDATE match_lobbies SET players_joined = $1, updated_at = NOW() WHERE id = $2",
      [JSON.stringify(playersJoined), lobbyDbId]
    )

    // Broadcast update
    if (this.io) {
      this.io.to(`comp:${compId}`).emit('lobby:statusUpdate', {
        matchId, gameNumber, status: 'waiting', playersJoined, playersExpected,
      })
    }

    this._log(bot.botId, `Lobby update: ${playersJoined.filter(p => p.team === 'radiant' || p.team === 'dire').length}/${playersExpected.length} players in slots`)

    // Check if match_id is available (game started)
    const dotaMatchId = lobbyData.match_id?.toString()
    if (dotaMatchId && dotaMatchId !== '0') {
      this._log(bot.botId, `Game started! Match ID: ${dotaMatchId}`)
      await execute(
        "UPDATE match_lobbies SET status = 'active', dota_match_id = $1, updated_at = NOW() WHERE id = $2",
        [dotaMatchId, lobbyDbId]
      )

      // Save to match_games
      const mg = await queryOne(
        'SELECT id FROM match_games WHERE match_id = $1 AND game_number = $2',
        [matchId, gameNumber]
      )
      if (mg) {
        await execute('UPDATE match_games SET dotabuff_id = $1 WHERE id = $2', [dotaMatchId, mg.id])
      } else {
        await execute(
          'INSERT INTO match_games (match_id, game_number, dotabuff_id) VALUES ($1, $2, $3) ON CONFLICT (match_id, game_number) DO UPDATE SET dotabuff_id = $3',
          [matchId, gameNumber, dotaMatchId]
        )
      }

      this._broadcastLobbyStatus(compId, matchId, gameNumber, 'active')
      if (this.io) {
        this.io.to(`comp:${compId}`).emit('lobby:matchIdCaptured', { matchId, gameNumber, dotaMatchId })
        this.io.to(`comp:${compId}`).emit('tournament:updated')
      }

      // Leave lobby and free bot
      this._log(bot.botId, `Match ID ${dotaMatchId} saved. Leaving lobby...`)
      bot.offLobbyUpdate(lobbyHandler)
      this.activeLobbies.delete(lobbyDbId)
      await bot.leaveLobby()
      this._log(bot.botId, 'Left lobby. Bot available for next match.')
      await execute("UPDATE lobby_bots SET status = 'available' WHERE id = $1", [bot.botId])
      await execute("UPDATE match_lobbies SET status = 'completed', updated_at = NOW() WHERE id = $1", [lobbyDbId])
      this._broadcastBotStatus(bot.botId, 'available')
      this._broadcastLobbyStatus(compId, matchId, gameNumber, 'completed')

      // Schedule OpenDota fetch (delay for parsing)
      this._scheduleStatsFetch(matchId, gameNumber, dotaMatchId)
      return
    }

    // Auto-launch when all expected players joined
    const expectedSteamIds = new Set(playersExpected.map(p => p.steam_id))
    const joinedSteamIds = new Set(playersJoined.filter(p => p.team === 'radiant' || p.team === 'dire').map(p => p.steam_id))
    const allJoined = [...expectedSteamIds].every(id => joinedSteamIds.has(id))

    if (allJoined && expectedSteamIds.size >= 2) {
      this._log(bot.botId, 'All players joined! Auto-launching game...')
      await this._launchLobby(lobbyDbId)
    }
  }

  async _launchLobby(lobbyDbId) {
    const active = this.activeLobbies.get(lobbyDbId)
    if (!active) return

    const { bot, compId, matchId, gameNumber } = active

    try {
      await execute("UPDATE match_lobbies SET status = 'launching', updated_at = NOW() WHERE id = $1", [lobbyDbId])
      this._broadcastLobbyStatus(compId, matchId, gameNumber, 'launching')
      await bot.launchLobby()
      // match_id will come via the lobbyUpdate handler
    } catch (err) {
      console.error('Failed to launch lobby:', err.message)
      await execute("UPDATE match_lobbies SET error_message = $1, updated_at = NOW() WHERE id = $2", [err.message, lobbyDbId])
    }
  }

  async forceLaunch(lobbyDbId) {
    await this._launchLobby(lobbyDbId)
  }

  async cancelLobby(lobbyDbId) {
    const active = this.activeLobbies.get(lobbyDbId)
    const lobby = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [lobbyDbId])
    if (!lobby) throw new Error('Lobby not found')

    if (active) {
      const { bot, compId, matchId, gameNumber, lobbyHandler } = active
      bot.offLobbyUpdate(lobbyHandler)
      this.activeLobbies.delete(lobbyDbId)
      try { await bot.destroyLobby() } catch {}
      await execute("UPDATE lobby_bots SET status = 'available' WHERE id = $1", [bot.botId])
      this._broadcastBotStatus(bot.botId, 'available')
      this._broadcastLobbyStatus(compId, matchId, gameNumber, 'cancelled')
    }

    await execute("UPDATE match_lobbies SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [lobbyDbId])
  }

  _scheduleStatsFetch(matchId, gameNumber, dotaMatchId) {
    // Try at 5min, 10min, 15min
    const delays = [5 * 60 * 1000, 10 * 60 * 1000, 15 * 60 * 1000]
    for (const delay of delays) {
      setTimeout(async () => {
        try {
          const mg = await queryOne(
            'SELECT id FROM match_games WHERE match_id = $1 AND game_number = $2',
            [matchId, gameNumber]
          )
          if (mg) {
            await fetchAndSaveGameStats(mg.id, dotaMatchId)
            console.log(`Stats fetched for match ${dotaMatchId} (delay: ${delay / 1000}s)`)
          }
        } catch (e) {
          console.log(`Stats fetch attempt for ${dotaMatchId} at ${delay / 1000}s: ${e.message}`)
        }
      }, delay)
    }
  }

  _broadcastBotStatus(botId, status, errorMessage = null) {
    if (this.io) {
      this.io.emit('bot:statusChanged', { botId, status, errorMessage })
    }
  }

  _broadcastLobbyStatus(compId, matchId, gameNumber, status, errorMessage = null) {
    if (this.io) {
      this.io.to(`comp:${compId}`).emit('lobby:statusUpdate', { matchId, gameNumber, status, errorMessage })
    }
  }
}

export const botPool = new BotPool()
