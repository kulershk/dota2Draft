import { query, queryOne, execute } from '../db.js'
import { fetchAndSaveGameStats } from '../helpers/opendota.js'

class BotPool {
  constructor() {
    this.io = null
    this.goWs = null
    this.botLogs = new Map() // botId -> [{ time, message }]
  }

  async init(io, wss) {
    this.io = io

    // Reset all bot statuses on restart
    await execute("UPDATE lobby_bots SET status = 'offline'")
    const bots = await query('SELECT * FROM lobby_bots')
    console.log(`Bot pool initialized with ${bots.length} bot account(s)`)

    // Handle Go service WS connections
    if (wss) {
      wss.on('connection', (ws) => {
        console.log('Go lobby bot service connected')
        this.goWs = ws

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString())
            this._handleGoMessage(msg)
          } catch (e) {
            console.error('Invalid message from Go service:', e.message)
          }
        })

        ws.on('close', () => {
          console.log('Go lobby bot service disconnected')
          this.goWs = null
        })

        ws.on('error', (err) => {
          console.error('Go WS error:', err.message)
        })
      })
    }
  }

  _sendToGo(type_, data) {
    if (!this.goWs || this.goWs.readyState !== 1) {
      throw new Error('Lobby bot service not connected')
    }
    this.goWs.send(JSON.stringify({ type: type_, data }))
  }

  async _handleGoMessage(msg) {
    const { type, data } = msg
    try {
      switch (type) {
        case 'hello':
          console.log('Go service hello:', data?.version)
          await this._sendSync()
          break

        case 'bot_status':
          await this._onBotStatus(data)
          break

        case 'bot_log':
          this._onBotLog(data)
          break

        case 'lobby_status':
          await this._onLobbyStatus(data)
          break

        case 'player_joined':
        case 'player_left':
          await this._onPlayerUpdate(data, type)
          break

        case 'game_started':
          await this._onGameStarted(data)
          break

        case 'lobby_error':
          await this._onLobbyError(data)
          break

        default:
          console.log('Unknown message from Go:', type)
      }
    } catch (e) {
      console.error(`Error handling Go message ${type}:`, e.message)
    }
  }

  async _sendSync() {
    const bots = await query('SELECT * FROM lobby_bots')
    const activeLobbies = await query(
      "SELECT * FROM match_lobbies WHERE status IN ('creating', 'waiting', 'launching')"
    )
    this._sendToGo('sync', {
      bots: bots.map(b => ({
        botId: String(b.id),
        username: b.username,
        password: b.password,
        refreshToken: b.refresh_token || '',
        sentryHash: b.sentry_hash || '',
        loginKey: b.login_key || '',
      })),
      lobbies: activeLobbies.map(l => ({
        lobbyId: String(l.id),
        gameName: l.game_name,
        password: l.password,
        serverRegion: l.server_region,
        players: l.players_expected || [],
      })),
    })
  }

  async _onBotStatus(data) {
    const botId = Number(data.botId)
    const updates = { status: data.status }
    if (data.steamId) updates.steam_id = data.steamId
    if (data.displayName) updates.display_name = data.displayName
    if (data.error) updates.error_message = data.error
    else updates.error_message = null
    if (data.refreshToken) updates.refresh_token = data.refreshToken
    if (data.sentryHash) updates.sentry_hash = data.sentryHash
    if (data.loginKey) updates.login_key = data.loginKey

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(', ')
    const values = [...Object.values(updates), botId]
    await execute(`UPDATE lobby_bots SET ${setClauses} WHERE id = $${values.length}`, values)

    if (this.io) {
      this.io.emit('bot:statusChanged', { botId, status: data.status, errorMessage: data.error || null })
    }
  }

  _onBotLog(data) {
    const botId = Number(data.botId)
    const entry = { time: new Date().toISOString(), message: data.message }
    if (!this.botLogs.has(botId)) this.botLogs.set(botId, [])
    const logs = this.botLogs.get(botId)
    logs.push(entry)
    if (logs.length > 50) logs.shift()
    console.log(`[Bot ${botId}] ${data.message}`)
    if (this.io) {
      this.io.emit('bot:log', { botId, ...entry })
    }
  }

  async _onLobbyStatus(data) {
    const lobbyId = Number(data.lobbyId)
    await execute(
      "UPDATE match_lobbies SET status = $1, players_joined = $2, updated_at = NOW() WHERE id = $3",
      [data.status, JSON.stringify(data.playersJoined || []), lobbyId]
    )
    const lobby = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [lobbyId])
    if (lobby && this.io) {
      this.io.to(`comp:${lobby.competition_id}`).emit('lobby:statusUpdate', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        status: data.status,
        playersJoined: data.playersJoined,
      })
    }
  }

  async _onPlayerUpdate(data, type) {
    const lobbyId = Number(data.lobbyId)
    const lobby = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [lobbyId])
    if (lobby && this.io) {
      this.io.to(`comp:${lobby.competition_id}`).emit('lobby:statusUpdate', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        status: lobby.status,
        event: type,
        steamId: data.steamId,
      })
    }
  }

  async _onGameStarted(data) {
    const lobbyId = Number(data.lobbyId)
    const dotaMatchId = data.matchId

    // Update lobby
    await execute(
      "UPDATE match_lobbies SET status = 'completed', dota_match_id = $1, updated_at = NOW() WHERE id = $2",
      [dotaMatchId, lobbyId]
    )

    const lobby = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [lobbyId])
    if (!lobby) return

    // Save to match_games
    await execute(
      `INSERT INTO match_games (match_id, game_number, dotabuff_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (match_id, game_number) DO UPDATE SET dotabuff_id = $3`,
      [lobby.match_id, lobby.game_number, dotaMatchId]
    )

    // Free the bot
    if (lobby.bot_id) {
      await execute("UPDATE lobby_bots SET status = 'available', last_used_at = NOW() WHERE id = $1", [lobby.bot_id])
      this._onBotLog({ botId: String(lobby.bot_id), message: `Match ID ${dotaMatchId} captured. Bot available.` })
    }

    // Broadcast
    if (this.io) {
      this.io.to(`comp:${lobby.competition_id}`).emit('lobby:matchIdCaptured', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        dotaMatchId,
      })
      this.io.to(`comp:${lobby.competition_id}`).emit('tournament:updated')
    }

    // Schedule OpenDota stats fetch
    this._scheduleStatsFetch(lobby.match_id, lobby.game_number, dotaMatchId)
  }

  async _onLobbyError(data) {
    const lobbyId = Number(data.lobbyId)
    await execute(
      "UPDATE match_lobbies SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2",
      [data.error, lobbyId]
    )
    const lobby = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [lobbyId])
    if (!lobby) return

    // Free the bot
    if (lobby.bot_id) {
      await execute("UPDATE lobby_bots SET status = 'available' WHERE id = $1", [lobby.bot_id])
    }

    if (this.io) {
      this.io.to(`comp:${lobby.competition_id}`).emit('lobby:statusUpdate', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        status: 'error',
        errorMessage: data.error,
      })
    }
  }

  _scheduleStatsFetch(matchId, gameNumber, dotaMatchId) {
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
          console.log(`Stats fetch attempt for ${dotaMatchId}: ${e.message}`)
        }
      }, delay)
    }
  }

  // ── Public API (called by lobby.js routes) ──

  getBotLogs(botId) {
    return this.botLogs.get(botId) || []
  }

  async getBotStatuses() {
    return await query('SELECT id, username, display_name, steam_id, status, error_message, last_used_at, created_at FROM lobby_bots ORDER BY id')
  }

  async addBot(username, password) {
    const existing = await queryOne('SELECT id FROM lobby_bots WHERE username = $1', [username])
    if (existing) throw new Error('Bot account already exists')
    const bot = await queryOne(
      'INSERT INTO lobby_bots (username, password) VALUES ($1, $2) RETURNING *',
      [username, password]
    )
    try {
      this._sendToGo('add_bot', { botId: String(bot.id), username, password })
    } catch {}
    return bot
  }

  async removeBot(botId) {
    try {
      this._sendToGo('disconnect_bot', { botId: String(botId) })
    } catch {}
    await execute('DELETE FROM lobby_bots WHERE id = $1', [botId])
  }

  async connectBot(botId) {
    const bot = await queryOne('SELECT * FROM lobby_bots WHERE id = $1', [botId])
    if (!bot) throw new Error('Bot not found')
    await execute("UPDATE lobby_bots SET status = 'connecting', error_message = NULL WHERE id = $1", [botId])
    if (this.io) this.io.emit('bot:statusChanged', { botId, status: 'connecting' })
    this._sendToGo('connect_bot', {
      botId: String(botId),
      username: bot.username,
      password: bot.password,
      refreshToken: bot.refresh_token || '',
      sentryHash: bot.sentry_hash || '',
      loginKey: bot.login_key || '',
    })
  }

  async disconnectBot(botId) {
    this._sendToGo('disconnect_bot', { botId: String(botId) })
    await execute("UPDATE lobby_bots SET status = 'offline' WHERE id = $1", [botId])
    if (this.io) this.io.emit('bot:statusChanged', { botId, status: 'offline' })
  }

  async submitSteamGuard(botId, code) {
    this._sendToGo('steam_guard', { botId: String(botId), code })
  }

  async createLobby(compId, matchId, gameNumber, options = {}) {
    // Check for active lobby
    const activeLobby = await queryOne(
      "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND status NOT IN ('completed', 'cancelled', 'error')",
      [matchId, gameNumber]
    )
    if (activeLobby) throw new Error('A lobby already exists for this game')

    // Clean up old finished lobbies so we can reuse the unique constraint
    await execute(
      "DELETE FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND status IN ('completed', 'cancelled', 'error')",
      [matchId, gameNumber]
    )

    // Find available bot
    const availableBot = await queryOne("SELECT id FROM lobby_bots WHERE status = 'available' ORDER BY last_used_at NULLS FIRST LIMIT 1")
    if (!availableBot) throw new Error('No available bots')

    // Resolve players
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
    for (const [captainId, playerIdField, team] of [
      [match.team1_captain_id, 't1_player_id', 'radiant'],
      [match.team2_captain_id, 't2_player_id', 'dire'],
    ]) {
      if (!captainId) continue
      // Captain
      if (match[playerIdField]) {
        const cap = await queryOne('SELECT steam_id, COALESCE(display_name, name) AS name FROM players WHERE id = $1', [match[playerIdField]])
        if (cap?.steam_id) playersExpected.push({ steam_id: cap.steam_id, name: cap.name, team })
      }
      // Drafted players
      const drafted = await query(`
        SELECT p.steam_id, COALESCE(p.display_name, p.name) AS name
        FROM competition_players cp JOIN players p ON cp.player_id = p.id
        WHERE cp.competition_id = $1 AND cp.drafted_by = $2 AND cp.drafted = 1
      `, [compId, captainId])
      for (const p of drafted) {
        if (p.steam_id && !playersExpected.some(e => e.steam_id === p.steam_id)) {
          playersExpected.push({ steam_id: p.steam_id, name: p.name, team })
        }
      }
    }

    // Get competition settings for lobby config
    const comp = await queryOne('SELECT settings FROM competitions WHERE id = $1', [compId])
    const compSettings = comp?.settings || {}
    const serverRegion = options.server_region ?? compSettings.lobbyServerRegion ?? 3
    const gameMode = options.game_mode ?? compSettings.lobbyGameMode ?? 2
    const autoAssignTeams = compSettings.lobbyAutoAssignTeams !== false
    const leagueId = compSettings.lobbyLeagueId || 0
    const dotaTvDelay = compSettings.lobbyDotaTvDelay ?? 1

    const gameName = options.game_name || `${match.team1_name || 'Team 1'} vs ${match.team2_name || 'Team 2'} - Game ${gameNumber}`
    const password = options.password || Math.random().toString(36).slice(2, 8)

    const lobby = await queryOne(`
      INSERT INTO match_lobbies (match_id, game_number, competition_id, bot_id, status, server_region, game_name, password, players_expected)
      VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7, $8) RETURNING *
    `, [matchId, gameNumber, compId, availableBot.id, serverRegion, gameName, password, JSON.stringify(playersExpected)])

    await execute("UPDATE lobby_bots SET status = 'busy', last_used_at = NOW() WHERE id = $1", [availableBot.id])

    // Send to Go service
    this._sendToGo('create_lobby', {
      lobbyId: String(lobby.id),
      gameName,
      password,
      serverRegion,
      gameMode,
      autoAssignTeams,
      leagueId,
      dotaTvDelay,
      players: playersExpected.map(p => ({ steamId: p.steam_id, name: p.name, team: p.team })),
    })

    return { ...lobby, players_expected: playersExpected }
  }

  async forceLaunch(lobbyDbId) {
    this._sendToGo('force_launch', { lobbyId: String(lobbyDbId) })
  }

  async cancelLobby(lobbyDbId) {
    const lobby = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [lobbyDbId])
    if (!lobby) throw new Error('Lobby not found')

    this._sendToGo('cancel_lobby', { lobbyId: String(lobbyDbId) })

    if (lobby.bot_id) {
      await execute("UPDATE lobby_bots SET status = 'available' WHERE id = $1", [lobby.bot_id])
    }
    await execute("UPDATE match_lobbies SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [lobbyDbId])
  }
}

export const botPool = new BotPool()
