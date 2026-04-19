import { query, queryOne, execute } from '../db.js'
import { playerInMatch, activeQueueMatches } from '../socket/queueState.js'
import { socketPlayers } from '../socket/state.js'
import { fetchAndSaveGameStats, fetchOpenDotaMatch, saveMatchGameStats, requestOpenDotaParse } from '../helpers/opendota.js'
import { fetchSteamMatchDetails } from '../helpers/steam.js'
import { awardXp, getTeamPlayerIds, awardStagePlacements } from '../helpers/xp.js'
import { getCompetition, parseCompSettings } from '../helpers/competition.js'
import SteamCommunity from 'steamcommunity'
import { LoginSession, EAuthTokenPlatformType } from 'steam-session'

class BotPool {
  constructor() {
    this.io = null
    this.goWs = null
    this.botLogs = new Map() // botId -> [{ time, message }]
    this.lobbyTeamIds = new Map() // lobbyId -> { radiant, dire }
    this._matchDetailsPending = new Map() // matchId -> { resolve, reject, timer }
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

    // Start polling for unresolved game results
    this._startResultsPolling()
  }

  _sendToGo(type_, data) {
    if (!this.goWs || this.goWs.readyState !== 1) {
      throw new Error('Lobby bot service not connected')
    }
    this.goWs.send(JSON.stringify({ type: type_, data }))
  }

  // Resolve the correct socket rooms for a lobby (competition or queue match)
  async _lobbyRooms(lobby) {
    if (lobby.competition_id) {
      return this.io.to(`comp:${lobby.competition_id}`).to(`match:${lobby.match_id}`)
    }
    // Queue match — find queue match room
    const qm = await queryOne('SELECT id FROM queue_matches WHERE match_id = $1', [lobby.match_id])
    if (qm) return this.io.to(`queue-match:${qm.id}`)
    return this.io.to(`match:${lobby.match_id}`)
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

        case 'lobby_team_ids':
          await this._onLobbyTeamIds(data)
          break

        case 'lobby_error':
          await this._onLobbyError(data)
          break

        case 'match_details':
          this._onMatchDetails(data)
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
      `SELECT ml.*, c.settings AS comp_settings
       FROM match_lobbies ml
       LEFT JOIN competitions c ON c.id = ml.competition_id
       WHERE ml.status IN ('creating', 'waiting', 'launching')`
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
        timeoutMinutes: Number(l.comp_settings?.lobbyTimeoutMinutes) || 10,
      })),
    })

    // Auto-connect bots that have auto_connect enabled.
    // Stagger connections by 5s each to avoid Steam rate-limiting / IP throttle
    // when multiple bots share the same IP.
    const toConnect = bots.filter(b => b.auto_connect && (b.status === 'offline' || b.status === 'error'))
    if (toConnect.length > 0) {
      console.log(`[Bot] Auto-connecting ${toConnect.length} bot(s) (staggered 5s apart)`)
      let delay = 0
      for (const bot of toConnect) {
        setTimeout(async () => {
          console.log(`[Bot] Auto-connecting bot ${bot.id} (${bot.username})`)
          try {
            await this.connectBot(bot.id)
          } catch (e) {
            console.error(`[Bot] Auto-connect failed for ${bot.id}:`, e.message)
          }
        }, delay)
        delay += 5000
      }
    }
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

    // Don't let a GC-reconnect flicker reset a busy bot to available if it
    // still has an active lobby. This prevents createQueueLobby from picking
    // the same bot for a second match (double-bot bug).
    if (data.status === 'available') {
      const activeLobby = await queryOne(
        "SELECT 1 FROM match_lobbies WHERE bot_id = $1 AND status IN ('creating', 'waiting', 'launching')",
        [botId]
      )
      if (activeLobby) {
        console.log(`[Bot ${botId}] Reported available but has active lobby — keeping busy`)
        updates.status = 'busy'
      }
    }

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(', ')
    const values = [...Object.values(updates), botId]
    await execute(`UPDATE lobby_bots SET ${setClauses} WHERE id = $${values.length}`, values)

    if (this.io) {
      this.io.emit('bot:statusChanged', { botId, status: data.status, errorMessage: data.error || null })
    }

    // When a bot comes back online, re-sync its active lobbies so Go can rejoin them
    if (data.status === 'available') {
      try {
        const activeLobbies = await query(
          "SELECT * FROM match_lobbies WHERE bot_id = $1 AND status IN ('creating', 'waiting', 'launching')",
          [botId]
        )
        if (activeLobbies.length > 0) {
          console.log(`[Bot ${botId}] Back online with ${activeLobbies.length} active lobby(s), re-syncing`)
          for (const lobby of activeLobbies) {
            const comp = await queryOne('SELECT settings FROM competitions WHERE id = $1', [lobby.competition_id])
            const timeoutMinutes = Number(comp?.settings?.lobbyTimeoutMinutes) || 10
            this._sendToGo('rejoin_lobby', {
              lobbyId: String(lobby.id),
              botId: String(botId),
              gameName: lobby.game_name,
              password: lobby.password,
              players: lobby.players_expected || [],
              timeoutMinutes,
            })
          }
        }
      } catch (e) {
        console.error(`[Bot ${botId}] Failed to re-sync lobbies:`, e.message)
      }
    }
  }

  _onMatchDetails(data) {
    const matchId = data.matchId || data.matchID
    const pending = this._matchDetailsPending.get(matchId)
    if (!pending) return
    this._matchDetailsPending.delete(matchId)
    clearTimeout(pending.timer)
    if (data.error) {
      pending.reject(new Error(data.error))
    } else {
      pending.resolve(data)
    }
  }

  /**
   * Request match details from the Dota 2 GC via an available bot.
   * Returns a promise that resolves with the match data or rejects on error/timeout.
   */
  async requestMatchDetailsFromGC(dotaMatchId) {
    const matchIdStr = String(dotaMatchId).replace(/\D/g, '')
    if (!matchIdStr) throw new Error('Invalid match ID')

    // Pick an available bot to make the request
    const bot = await queryOne("SELECT id FROM lobby_bots WHERE status = 'available' ORDER BY last_used_at NULLS FIRST LIMIT 1")
    if (!bot) throw new Error('No bot available for GC request')

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._matchDetailsPending.delete(matchIdStr)
        reject(new Error('GC match details request timed out (15s)'))
      }, 15_000)

      this._matchDetailsPending.set(matchIdStr, { resolve, reject, timer })
      this._sendToGo('request_match_details', { matchId: matchIdStr, botId: String(bot.id) })
    })
  }

  _onBotLog(data) {
    const botId = Number(data.botId)
    const entry = { time: new Date().toISOString(), message: data.message }
    if (!this.botLogs.has(botId)) this.botLogs.set(botId, [])
    const logs = this.botLogs.get(botId)
    logs.push(entry)
    if (logs.length > 500) logs.shift()
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
      (await this._lobbyRooms(lobby)).emit('lobby:statusUpdate', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        status: data.status,
        playersJoined: data.playersJoined,
      })
    }

    // Auto force-launch for queue matches when all players joined + both teams set
    if (lobby && !lobby.competition_id && data.status === 'waiting') {
      const expectedList = lobby.players_expected || []
      const teamIds = this.lobbyTeamIds.get(lobbyId) || (lobby.team_ids ? JSON.parse(lobby.team_ids) : null)
      const slotted = this._countExpectedInSlots(expectedList, data.playersJoined || [])
      if (expectedList.length > 0 && slotted === expectedList.length && teamIds?.radiant && teamIds?.dire) {
        console.log(`[Queue] All ${slotted}/${expectedList.length} expected players in team slots + both teams set — auto force-launching lobby ${lobbyId}`)
        try {
          await this.forceLaunch(lobbyId, { skipValidation: false })
        } catch (e) {
          console.error(`[Queue] Auto force-launch failed for lobby ${lobbyId}:`, e.message)
          // Retry with skip validation if team validation fails
          try {
            await this.forceLaunch(lobbyId, { skipValidation: true })
          } catch (e2) {
            console.error(`[Queue] Auto force-launch retry failed:`, e2.message)
          }
        }
      }
    }
  }

  async _onPlayerUpdate(data, type) {
    const lobbyId = Number(data.lobbyId)
    const lobby = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [lobbyId])
    if (lobby && this.io) {
      (await this._lobbyRooms(lobby)).emit('lobby:statusUpdate', {
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
    console.log(`[Lobby] Game started: lobbyId=${lobbyId}, matchId=${dotaMatchId}`)

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

    // Save dota_team_id to captains on first game played
    const teamIds = this.lobbyTeamIds.get(lobbyId)
    if (teamIds) {
      const match = await queryOne(
        'SELECT team1_captain_id, team2_captain_id FROM matches WHERE id = $1', [lobby.match_id]
      )
      if (match) {
        if (teamIds.radiant && match.team1_captain_id) {
          const cap = await queryOne('SELECT dota_team_id FROM captains WHERE id = $1', [match.team1_captain_id])
          if (cap && !cap.dota_team_id) {
            await execute('UPDATE captains SET dota_team_id = $1 WHERE id = $2', [teamIds.radiant, match.team1_captain_id])
            console.log(`[Lobby] Saved Radiant dota_team_id=${teamIds.radiant} for captain ${match.team1_captain_id}`)
          }
        }
        if (teamIds.dire && match.team2_captain_id) {
          const cap = await queryOne('SELECT dota_team_id FROM captains WHERE id = $1', [match.team2_captain_id])
          if (cap && !cap.dota_team_id) {
            await execute('UPDATE captains SET dota_team_id = $1 WHERE id = $2', [teamIds.dire, match.team2_captain_id])
            console.log(`[Lobby] Saved Dire dota_team_id=${teamIds.dire} for captain ${match.team2_captain_id}`)
          }
        }
      }
      this.lobbyTeamIds.delete(lobbyId)
    }

    // Free the bot
    if (lobby.bot_id) {
      await execute("UPDATE lobby_bots SET status = 'available', last_used_at = NOW() WHERE id = $1", [lobby.bot_id])
      this._onBotLog({ botId: String(lobby.bot_id), message: `Match ID ${dotaMatchId} captured. Bot available.` })
    }

    // Broadcast
    if (this.io) {
      const rooms = await this._lobbyRooms(lobby)
      rooms.emit('lobby:statusUpdate', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        status: 'completed',
      })
      rooms.emit('lobby:matchIdCaptured', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        dotaMatchId,
      })
      if (lobby.competition_id) {
        this.io.to(`comp:${lobby.competition_id}`).emit('tournament:updated')
      } else {
        // Queue match: notify queue-match room so the queue page clears the lobby banner
        const qm = await queryOne('SELECT id FROM queue_matches WHERE match_id = $1', [lobby.match_id])
        if (qm) {
          this.io.to(`queue-match:${qm.id}`).emit('queue:gameStarted', {
            queueMatchId: qm.id,
            dotaMatchId,
          })
          // Drop in-memory match state so a page reload after the game launched
          // does not restore the stale "lobby created" banner via queue:getState.
          // playerInMatch stays set until _autoFillGameWinner runs (re-queue gating).
          activeQueueMatches.delete(qm.id)
        }
      }
    }

    // Schedule OpenDota stats fetch
    this._scheduleStatsFetch(lobby.match_id, lobby.game_number, dotaMatchId)
  }

  // Counts how many expected players are sitting in their correct team slot.
  // Each expected player must be present in `joined` AND on the same side
  // (radiant/dire) as expected — not unassigned, spectator, or wrong team.
  _countExpectedInSlots(expected, joined) {
    if (!Array.isArray(expected) || !Array.isArray(joined)) return 0
    const joinedTeamBySteamId = new Map()
    for (const p of joined) {
      if (!p) continue
      const sid = String(p.steamId || p.steam_id || '')
      if (sid) joinedTeamBySteamId.set(sid, p.team)
    }
    let count = 0
    for (const e of expected) {
      const sid = String(e?.steam_id || e?.steamId || '')
      const expectedTeam = e?.team
      if (!sid || (expectedTeam !== 'radiant' && expectedTeam !== 'dire')) continue
      if (joinedTeamBySteamId.get(sid) === expectedTeam) count++
    }
    return count
  }

  async _onLobbyTeamIds(data) {
    const lobbyId = Number(data.lobbyId)
    const radiantTeamId = data.radiantTeamId || 0
    const direTeamId = data.direTeamId || 0

    const radiantTeamName = data.radiantTeamName || ''
    const direTeamName = data.direTeamName || ''

    // Store in memory for use when game starts
    this.lobbyTeamIds.set(lobbyId, { radiant: radiantTeamId, dire: direTeamId })

    const lobby = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [lobbyId])
    if (!lobby) return

    // Persist team IDs to database so they survive page refresh
    const teamIdsJson = JSON.stringify({ radiant: radiantTeamId, dire: direTeamId, radiantName: radiantTeamName, direName: direTeamName })
    await execute('UPDATE match_lobbies SET team_ids = $1 WHERE id = $2', [teamIdsJson, lobbyId])

    // Broadcast to frontend
    if (this.io) {
      (await this._lobbyRooms(lobby)).emit('lobby:teamIds', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        radiantTeamId,
        direTeamId,
        radiantTeamName,
        direTeamName,
      })
    }

    // Auto force-launch for queue matches: team IDs just arrived, check if all players are already in
    if (!lobby.competition_id && lobby.status === 'waiting' && radiantTeamId && direTeamId) {
      const expectedList = lobby.players_expected || []
      const slotted = this._countExpectedInSlots(expectedList, lobby.players_joined || [])
      if (expectedList.length > 0 && slotted === expectedList.length) {
        console.log(`[Queue] Both teams set + all ${slotted}/${expectedList.length} expected players in team slots — auto force-launching lobby ${lobbyId}`)
        try {
          await this.forceLaunch(lobbyId, { skipValidation: false })
        } catch (e) {
          console.error(`[Queue] Auto force-launch failed:`, e.message)
          try { await this.forceLaunch(lobbyId, { skipValidation: true }) } catch {}
        }
      }
    }
  }

  async _onLobbyError(data) {
    const lobbyId = Number(data.lobbyId)
    const lobby = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [lobbyId])
    if (!lobby) return

    // If lobby was launching and got a validation error, revert to waiting (don't kill the lobby)
    if (lobby.status === 'launching') {
      await execute(
        "UPDATE match_lobbies SET status = 'waiting', updated_at = NOW() WHERE id = $1",
        [lobbyId]
      )
      if (this.io) {
        (await this._lobbyRooms(lobby)).emit('lobby:statusUpdate', {
          matchId: lobby.match_id,
          gameNumber: lobby.game_number,
          status: 'waiting',
          errorMessage: data.error,
        })
      }
      console.log(`[Lobby] Launch rejected: ${data.error} — reverted to waiting`)
      return
    }

    await execute(
      "UPDATE match_lobbies SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2",
      [data.error, lobbyId]
    )

    // Free the bot
    if (lobby.bot_id) {
      await execute("UPDATE lobby_bots SET status = 'available' WHERE id = $1", [lobby.bot_id])
    }

    if (this.io) {
      (await this._lobbyRooms(lobby)).emit('lobby:statusUpdate', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        status: 'error',
        errorMessage: data.error,
      })
    }

    // Queue match no-show penalty: if this lobby belongs to a queue match
    // and the error is a timeout, ban every expected player who never sat
    // in a radiant/dire slot for 10 minutes, then cancel the queue match so
    // the players who *did* show up are freed to re-queue.
    const isTimeout = typeof data.error === 'string' && /timed out/i.test(data.error)
    if (!lobby.competition_id) {
      if (isTimeout) {
        try {
          await this._handleQueueLobbyNoShows(lobby)
        } catch (e) {
          console.error('[Queue] No-show penalty failed:', e.message)
        }
      } else {
        // Non-timeout error during lobby creation — retry with a different bot.
        try {
          await this._retryQueueLobby(lobby)
        } catch (e) {
          console.error('[Queue] Lobby retry failed:', e.message)
        }
      }
    }
  }

  async _handleQueueLobbyNoShows(lobby) {
    const expected = lobby.players_expected || []
    const joined = lobby.players_joined || []
    if (!Array.isArray(expected) || expected.length === 0) return

    const slottedSteamIds = new Set(
      joined
        .filter(p => p && (p.team === 'radiant' || p.team === 'dire'))
        .map(p => String(p.steamId || p.steam_id))
    )

    // Each expected entry is { steam_id, name, team }. Look up the player_id
    // by steam_id so we can apply the ban row.
    const noShowSteamIds = expected
      .map(e => String(e?.steam_id || ''))
      .filter(sid => sid && !slottedSteamIds.has(sid))

    let bannedCount = 0
    if (noShowSteamIds.length > 0) {
      const bannedUntil = new Date(Date.now() + 10 * 60 * 1000) // 10 min
      const reason = 'Failed to join lobby in time'
      const rows = await query(
        'SELECT id, steam_id FROM players WHERE steam_id = ANY($1::text[])',
        [noShowSteamIds]
      )
      for (const r of rows) {
        try {
          await execute(`
            INSERT INTO queue_bans (player_id, banned_until, reason, banned_by)
            VALUES ($1, $2, $3, NULL)
            ON CONFLICT (player_id) DO UPDATE SET
              banned_until = EXCLUDED.banned_until,
              reason = EXCLUDED.reason,
              banned_by = NULL,
              created_at = NOW()
          `, [r.id, bannedUntil, reason])
          bannedCount++

          // Push the new ban state to the player's sockets so the banner
          // appears with a live countdown without a reload.
          if (this.io) {
            const banPayload = { bannedUntil: bannedUntil.toISOString(), reason }
            for (const [sid, pid] of socketPlayers) {
              if (pid === r.id) {
                const s = this.io.sockets.sockets.get(sid)
                if (s) s.emit('queue:myState', {
                  inQueue: false, poolId: null, poolName: null,
                  inMatch: false, queueMatchId: null, count: 0, players: [],
                  ban: banPayload,
                })
              }
            }
          }
        } catch (e) {
          console.error('[Queue] Failed to auto-ban no-show player', r.id, e.message)
        }
      }
    }
    console.log(`[Queue] Lobby ${lobby.id} timed out — banned ${bannedCount} no-show player(s) for 10 min`)

    // Cancel the queue match (if any) so surviving players can re-queue.
    const qm = await queryOne('SELECT id, all_player_ids FROM queue_matches WHERE match_id = $1', [lobby.match_id])
    if (qm) {
      try {
        await execute("UPDATE queue_matches SET status = 'cancelled' WHERE id = $1", [qm.id])
      } catch {}

      const playerIds = Array.isArray(qm.all_player_ids) ? qm.all_player_ids : []
      for (const pid of playerIds) {
        if (playerInMatch.get(pid) === qm.id) playerInMatch.delete(pid)
      }
      activeQueueMatches.delete(qm.id)

      if (this.io) {
        this.io.to(`queue-match:${qm.id}`).emit('queue:cancelled', {
          queueMatchId: qm.id,
          reason: 'Lobby timed out — no-shows banned 10 minutes',
        })
      }
    }
  }

  async _scheduleStatsFetch(matchId, gameNumber, dotaMatchId) {
    // Request OpenDota to parse this match early
    requestOpenDotaParse(dotaMatchId).catch(() => {})

    // Enqueue a visible background job so admins can see the fetch progress
    try {
      const { enqueueJob } = await import('./jobs.js')
      const mg = await queryOne(
        'SELECT id FROM match_games WHERE match_id = $1 AND game_number = $2',
        [matchId, gameNumber]
      )
      if (mg) {
        await enqueueJob({
          type: 'fetch_match_stats',
          payload: { matchGameId: mg.id, dotabuffId: String(dotaMatchId), matchId, gameNumber },
          maxAttempts: 999,
          runAt: new Date(Date.now() + 30_000), // wait 30s for Valve to process
        })
        console.log(`[Stats] Enqueued fetch_match_stats job for match ${matchId} game ${gameNumber} (dota: ${dotaMatchId})`)
      }
    } catch (e) {
      console.error(`[Stats] Failed to enqueue fetch job:`, e.message)
    }
  }

  // Polling is now driven by the background job system (see
  // server/services/jobs.js). This method is a no-op kept for call-site
  // compatibility; the actual schedules are registered in server/index.js
  // after both botPool and the job worker have started.
  _startResultsPolling() {}

  // Lobbies stuck in 'creating' for >2 min usually mean the Go service lost
  // GC connectivity or crashed without reporting an error. Mark them errored,
  // free the bot, and trigger the automatic retry-with-different-bot flow.
  async _cleanupStuckCreatingLobbies() {
    try {
      const stuck = await query(`
        SELECT ml.* FROM match_lobbies ml
        WHERE ml.status = 'creating'
          AND ml.updated_at < NOW() - INTERVAL '2 minutes'
      `)
      if (stuck.length === 0) return
      console.log(`[Lobby] Found ${stuck.length} lobby(ies) stuck in 'creating' >2min, marking errored`)
      for (const lobby of stuck) {
        try {
          // Tell Go to abandon this lobby BEFORE marking it errored, so Go
          // won't execute a queued create_lobby when the bot reconnects.
          try {
            this._sendToGo('cancel_lobby', { lobbyId: String(lobby.id) })
          } catch {}

          await execute(
            "UPDATE match_lobbies SET status = 'error', error_message = 'Timed out in creating (>2min, likely GC loss)', updated_at = NOW() WHERE id = $1",
            [lobby.id]
          )
          if (lobby.bot_id) {
            await execute("UPDATE lobby_bots SET status = 'available' WHERE id = $1", [lobby.bot_id])
            console.log(`[Lobby] Freed bot ${lobby.bot_id} from stuck lobby ${lobby.id}`)
          }
          if (this.io) {
            (await this._lobbyRooms(lobby)).emit('lobby:statusUpdate', {
              matchId: lobby.match_id,
              gameNumber: lobby.game_number,
              status: 'error',
              errorMessage: 'Lobby creation timed out — retrying with a different bot',
            })
          }
          // Trigger auto-retry for queue matches
          if (!lobby.competition_id) {
            try {
              await this._retryQueueLobby(lobby)
            } catch (e) {
              console.error(`[Lobby] Auto-retry after creating timeout failed:`, e.message)
            }
          }
        } catch (e) {
          console.error(`[Lobby] Failed to cleanup stuck lobby ${lobby.id}:`, e.message)
        }
      }
    } catch (e) {
      console.error('[Lobby] Stuck-creating cleanup error:', e.message)
    }
  }

  // Clean up zombie lobbies: match_lobbies still 'creating'/'waiting'/'launching'/'active'
  // but their queue_match (or match) is already completed/cancelled. Free the bot.
  async _cleanupZombieLobbies() {
    try {
      const zombies = await query(`
        SELECT ml.id, ml.bot_id, ml.match_id, ml.game_name
          FROM match_lobbies ml
         WHERE ml.status IN ('creating', 'waiting', 'launching', 'active')
           AND (
             -- Queue match already finished
             EXISTS (
               SELECT 1 FROM queue_matches qm
               WHERE qm.match_id = ml.match_id
                 AND qm.status IN ('completed', 'cancelled')
             )
             -- Or match itself is completed/cancelled
             OR EXISTS (
               SELECT 1 FROM matches m
               WHERE m.id = ml.match_id
                 AND m.status IN ('completed', 'cancelled')
             )
             -- Or lobby is older than 4 hours with no resolution
             OR ml.updated_at < NOW() - INTERVAL '4 hours'
           )
      `)
      if (zombies.length === 0) return
      console.log(`[Lobby] Cleaning up ${zombies.length} zombie lobby(ies)`)
      for (const z of zombies) {
        await execute(
          "UPDATE match_lobbies SET status = 'cancelled', error_message = 'Auto-cleaned: match already finished', updated_at = NOW() WHERE id = $1",
          [z.id]
        )
        if (z.bot_id) {
          await execute("UPDATE lobby_bots SET status = 'available' WHERE id = $1 AND status = 'busy'", [z.bot_id])
          console.log(`[Lobby] Freed bot ${z.bot_id} from zombie lobby ${z.id} (${z.game_name})`)
        }
      }
    } catch (e) {
      console.error('[Lobby] Zombie cleanup error:', e.message)
    }
  }

  async _cleanupStuckQueueMatches() {
    try {
      const stuck = await query(`
        SELECT id, all_player_ids
          FROM queue_matches
         WHERE status = 'live'
           AND created_at < NOW() - INTERVAL '3 hours'
      `)
      if (stuck.length === 0) return
      console.log(`[Queue] Force-cancelling ${stuck.length} stuck queue match(es) (>3h in live)`)
      for (const qm of stuck) {
        try {
          await execute("UPDATE queue_matches SET status = 'cancelled', completed_at = NOW() WHERE id = $1", [qm.id])
          const playerIds = Array.isArray(qm.all_player_ids) ? qm.all_player_ids : []
          for (const pid of playerIds) {
            if (playerInMatch.get(pid) === qm.id) playerInMatch.delete(pid)
          }
          activeQueueMatches.delete(qm.id)
          if (this.io) {
            this.io.to(`queue-match:${qm.id}`).emit('queue:cancelled', {
              queueMatchId: qm.id,
              reason: 'Auto-cancelled after 3h without a resolved result',
            })
          }
        } catch (e) {
          console.error(`[Queue] Failed to cleanup stuck queue match ${qm.id}:`, e.message)
        }
      }
    } catch (e) {
      console.error('[Queue] Stuck cleanup error:', e.message)
    }
  }

  // Safety net: find unresolved games that don't have a pending fetch_match_stats
  // job and enqueue one. Catches games missed during server restarts, manual
  // dotabuff_id edits, or if _scheduleStatsFetch failed.
  async _pollUnresolvedGames() {
    try {
      const { enqueueJob } = await import('./jobs.js')
      const unresolvedGames = await query(`
        SELECT mg.id, mg.match_id, mg.game_number, mg.dotabuff_id
        FROM match_games mg
        JOIN matches m ON m.id = mg.match_id
        WHERE mg.dotabuff_id IS NOT NULL
          AND mg.dotabuff_id != ''
          AND (
            mg.winner_captain_id IS NULL
            OR (mg.parsed = false AND mg.created_at > NOW() - INTERVAL '24 hours')
          )
        ORDER BY mg.created_at ASC
        LIMIT 10
      `)
      if (unresolvedGames.length === 0) return

      for (const game of unresolvedGames) {
        // Check if there's already a pending/running job for this game
        const existing = await queryOne(
          `SELECT 1 FROM jobs WHERE type = 'fetch_match_stats' AND status IN ('pending', 'running')
             AND payload->>'matchGameId' = $1 LIMIT 1`,
          [String(game.id)]
        )
        if (existing) continue

        // Also check enrich jobs for games that have a winner but aren't parsed
        const hasEnrich = await queryOne(
          `SELECT 1 FROM jobs WHERE type = 'enrich_match_stats' AND status IN ('pending', 'running')
             AND payload->>'matchGameId' = $1 LIMIT 1`,
          [String(game.id)]
        )
        if (hasEnrich) continue

        await enqueueJob({
          type: 'fetch_match_stats',
          payload: { matchGameId: game.id, dotabuffId: game.dotabuff_id, matchId: game.match_id, gameNumber: game.game_number },
          maxAttempts: 999,
        })
        console.log(`[Stats] Safety net: enqueued fetch_match_stats for match_games #${game.id} (dota: ${game.dotabuff_id})`)
      }
    } catch (e) {
      console.error('[Stats] Poll error:', e.message)
    }
  }

  async _autoFillGameWinner(matchId, gameNumber, radiantWin, matchData) {
    try {
      const match = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
      if (!match) return

      // Check if this is a queue match (no competition_id)
      const queueMatch = !match.competition_id ? await queryOne('SELECT * FROM queue_matches WHERE match_id = $1', [matchId]) : null

      let winnerCaptainId = null

      if (queueMatch) {
        // Queue match: determine winner from team player steam IDs
        const team1SteamIds = new Set((queueMatch.team1_players || []).map(p => p.steamId ? String(BigInt(p.steamId) - 76561197960265728n) : null).filter(Boolean))
        let team1IsRadiant = true // default: team1 = radiant
        if (matchData?.players?.length) {
          let t1Rad = 0, t1Dire = 0
          for (const p of matchData.players) {
            if (team1SteamIds.has(String(p.account_id || 0))) {
              if (p.isRadiant) t1Rad++; else t1Dire++
            }
          }
          if (t1Rad > 0 || t1Dire > 0) team1IsRadiant = t1Rad > t1Dire
        }
        const team1Won = team1IsRadiant ? radiantWin : !radiantWin
        // Use captain player IDs as pseudo winner IDs for match_games
        winnerCaptainId = team1Won ? queueMatch.captain1_player_id : queueMatch.captain2_player_id
        console.log(`[Auto] Queue match: team1 is ${team1IsRadiant ? 'Radiant' : 'Dire'}, winner=${winnerCaptainId}`)
      } else if (matchData?.players?.length && match.team1_captain_id) {
        // Competition match: determine winner from captain team players
        const team1Players = await query(
          `SELECT p.steam_id FROM competition_players cp
           JOIN players p ON p.id = cp.player_id
           WHERE cp.drafted_by = $1 AND cp.competition_id = $2
           UNION
           SELECT p.steam_id FROM captains c JOIN players p ON p.id = c.player_id WHERE c.id = $1`,
          [match.team1_captain_id, match.competition_id]
        )
        const team1Steam32 = new Set(team1Players.map(p => p.steam_id ? String(BigInt(p.steam_id) - 76561197960265728n) : null).filter(Boolean))

        let team1Radiant = 0
        let team1Dire = 0
        for (const p of matchData.players) {
          const accountStr = String(p.account_id || 0)
          if (team1Steam32.has(accountStr)) {
            if (p.isRadiant) team1Radiant++
            else team1Dire++
          }
        }

        const team1IsRadiant = team1Radiant > team1Dire
        if (team1Radiant > 0 || team1Dire > 0) {
          if (radiantWin) {
            winnerCaptainId = team1IsRadiant ? match.team1_captain_id : match.team2_captain_id
          } else {
            winnerCaptainId = team1IsRadiant ? match.team2_captain_id : match.team1_captain_id
          }
          console.log(`[Auto] Team1 is ${team1IsRadiant ? 'Radiant' : 'Dire'} (matched ${team1Radiant}R/${team1Dire}D players)`)
        }
      }

      // Fallback: assume team1=radiant, team2=dire (lobby default)
      if (!winnerCaptainId) {
        if (queueMatch) {
          winnerCaptainId = radiantWin ? queueMatch.captain1_player_id : queueMatch.captain2_player_id
        } else {
          winnerCaptainId = radiantWin ? match.team1_captain_id : match.team2_captain_id
        }
        console.log(`[Auto] Fallback: assuming team1=radiant`)
      }

      if (!winnerCaptainId) return

      // Set game winner
      await execute(
        'UPDATE match_games SET winner_captain_id = $1 WHERE match_id = $2 AND game_number = $3 AND winner_captain_id IS NULL',
        [winnerCaptainId, matchId, gameNumber]
      )
      console.log(`[Auto] Game ${gameNumber} of match ${matchId} won by captain ${winnerCaptainId} (${radiantWin ? 'radiant' : 'dire'})`)

      // ── XP: game win/loss ──
      // Check if this is a queue match (reuse variable from winner detection, but fetch XP settings)
      const queueMatchXp = await queryOne('SELECT qm.*, qp.xp_win, qp.xp_participate, qp.name AS pool_name FROM queue_matches qm JOIN queue_pools qp ON qp.id = qm.pool_id WHERE qm.match_id = $1', [matchId])
      if (queueMatchXp) {
        // Queue match XP
        const team1Ids = (queueMatchXp.team1_players || []).map(p => p.playerId)
        const team2Ids = (queueMatchXp.team2_players || []).map(p => p.playerId)
        // Determine which team won by matching player steam IDs to radiant/dire
        const team1SteamIds = new Set((queueMatchXp.team1_players || []).map(p => p.steamId ? String(BigInt(p.steamId) - 76561197960265728n) : null).filter(Boolean))
        let team1IsRadiant = true
        if (matchData?.players?.length) {
          let t1Rad = 0, t1Dire = 0
          for (const p of matchData.players) {
            if (team1SteamIds.has(String(p.account_id || 0))) {
              if (p.isRadiant) t1Rad++; else t1Dire++
            }
          }
          if (t1Rad > 0 || t1Dire > 0) team1IsRadiant = t1Rad > t1Dire
        }
        const team1Won = team1IsRadiant ? radiantWin : !radiantWin
        const winIds = team1Won ? team1Ids : team2Ids
        const loseIds = team1Won ? team2Ids : team1Ids
        const xpWin = queueMatchXp.xp_win == null ? 15 : Number(queueMatchXp.xp_win)
        const xpLoss = queueMatchXp.xp_participate == null ? 5 : Number(queueMatchXp.xp_participate)
        if (xpWin > 0) {
          for (const pid of winIds) {
            awardXp(pid, xpWin, 'queue_win', 'match_game', `${matchId}:${gameNumber}:${pid}`, {
              detail: `Queue win (${queueMatchXp.pool_name})`,
            })
          }
        }
        if (xpLoss > 0) {
          for (const pid of loseIds) {
            awardXp(pid, xpLoss, 'queue_loss', 'match_game', `${matchId}:${gameNumber}:${pid}`, {
              detail: `Queue loss (${queueMatchXp.pool_name})`,
            })
          }
        }
        // Update queue match status
        await execute("UPDATE queue_matches SET status = 'completed', completed_at = NOW() WHERE id = $1", [queueMatchXp.id])

        // Free players so they can re-queue now that the game is over
        const allIds = [...team1Ids, ...team2Ids]
        for (const pid of allIds) {
          if (playerInMatch.get(pid) === queueMatchXp.id) playerInMatch.delete(pid)
        }
        activeQueueMatches.delete(queueMatchXp.id)
      } else if (match.competition_id) {
        // Competition match XP
        const comp = await getCompetition(match.competition_id)
        const settings = parseCompSettings(comp)
        const loserCaptainId = winnerCaptainId === match.team1_captain_id ? match.team2_captain_id : match.team1_captain_id
        const winPlayers = await getTeamPlayerIds(winnerCaptainId, match.competition_id)
        const losePlayers = loserCaptainId ? await getTeamPlayerIds(loserCaptainId, match.competition_id) : []
        const winCap = await queryOne('SELECT team FROM captains WHERE id = $1', [winnerCaptainId])
        const loseCap = loserCaptainId ? await queryOne('SELECT team FROM captains WHERE id = $1', [loserCaptainId]) : null
        for (const pid of winPlayers) {
          awardXp(pid, settings.xpGameWin, 'game_win', 'match_game', `${matchId}:${gameNumber}:${pid}`, {
            competitionId: match.competition_id, competitionName: comp.name,
            detail: `Game ${gameNumber} win vs ${loseCap?.team || 'TBD'}`,
          })
        }
        for (const pid of losePlayers) {
          awardXp(pid, settings.xpGameLoss, 'game_loss', 'match_game', `${matchId}:${gameNumber}:${pid}`, {
            competitionId: match.competition_id, competitionName: comp.name,
            detail: `Game ${gameNumber} loss vs ${winCap?.team || 'TBD'}`,
          })
        }
      }

      // Recalculate match score from all games
      // For queue matches, use captain player IDs from queue_matches; for comp matches use captains IDs
      const cap1Id = queueMatch ? queueMatch.captain1_player_id : match.team1_captain_id
      const cap2Id = queueMatch ? queueMatch.captain2_player_id : match.team2_captain_id

      const games = await query(
        'SELECT winner_captain_id FROM match_games WHERE match_id = $1 AND winner_captain_id IS NOT NULL',
        [matchId]
      )
      const score1 = games.filter(g => g.winner_captain_id === cap1Id).length
      const score2 = games.filter(g => g.winner_captain_id === cap2Id).length
      const bestOf = match.best_of || 3
      const winsNeeded = Math.ceil(bestOf / 2)

      let matchWinner = null
      let newStatus = 'live'
      if (bestOf === 2) {
        // Bo2: always play both games, then mark completed
        if (games.length >= 2) {
          newStatus = 'completed'
          if (score1 > score2) matchWinner = cap1Id
          else if (score2 > score1) matchWinner = cap2Id
          // 1-1 draw: matchWinner stays null
        }
      } else if (score1 >= winsNeeded) {
        matchWinner = cap1Id
        newStatus = 'completed'
      } else if (score2 >= winsNeeded) {
        matchWinner = cap2Id
        newStatus = 'completed'
      }

      await execute(
        'UPDATE matches SET score1 = $1, score2 = $2, winner_captain_id = $3, status = $4 WHERE id = $5',
        [score1, score2, matchWinner, newStatus, matchId]
      )

      // ── XP: match win (series) — competition only ──
      if (matchWinner && newStatus === 'completed' && match.competition_id) {
        const matchWinPlayers = await getTeamPlayerIds(matchWinner, match.competition_id)
        const matchLoserId = matchWinner === match.team1_captain_id ? match.team2_captain_id : match.team1_captain_id
        const matchLoseCap = matchLoserId ? await queryOne('SELECT team FROM captains WHERE id = $1', [matchLoserId]) : null
        for (const pid of matchWinPlayers) {
          awardXp(pid, settings.xpMatchWin, 'match_win', 'match', `${matchId}:${pid}`, {
            competitionId: match.competition_id, competitionName: comp.name,
            detail: `Series win vs ${matchLoseCap?.team || 'TBD'}`,
          })
        }
      }

      // Advance winner in bracket if match is completed
      if (matchWinner && (match.next_match_id || match.loser_next_match_id)) {
        const { advanceWinner } = await import('../helpers/tournament.js')
        await advanceWinner(matchId, matchWinner)
      }

      // ── XP: tournament placements (when stage completes) ──
      const ts = comp.tournament_state || {}
      if (ts.stages) {
        const stage = ts.stages.find(s => s.id === match.stage)
        if (stage) {
          const stageMatches = await query(
            "SELECT id FROM matches WHERE competition_id = $1 AND stage = $2 AND status != 'completed'",
            [match.competition_id, match.stage]
          )
          if (stageMatches.length === 0) {
            stage.status = 'completed'
            await execute('UPDATE competitions SET tournament_state = $1 WHERE id = $2', [JSON.stringify(ts), match.competition_id])
            await awardStagePlacements(comp, stage, settings)
          }
        }
      }

      // Notify clients
      if (this.io && match.competition_id) {
        this.io.to(`comp:${match.competition_id}`).emit('tournament:updated')
      }

      console.log(`[Auto] Match ${matchId} score: ${score1}-${score2}${matchWinner ? ' (completed)' : ''}`)
    } catch (e) {
      console.error(`[Auto] Failed to auto-fill winner for match ${matchId} game ${gameNumber}:`, e.message)
    }
  }

  // ── Public API (called by lobby.js routes) ──

  getBotLogs(botId) {
    return this.botLogs.get(botId) || []
  }

  async getBotStatuses() {
    return await query(`
      SELECT b.id, b.username, b.display_name, b.steam_id, b.status, b.error_message, b.auto_connect, b.last_used_at, b.created_at,
        ml.match_id AS active_match_id,
        ml.competition_id AS active_competition_id,
        ml.game_name AS active_game_name,
        ml.status AS active_lobby_status,
        qm.id AS active_queue_match_id,
        qp.name AS active_queue_pool_name,
        c.name AS active_competition_name
      FROM lobby_bots b
      LEFT JOIN LATERAL (
        SELECT match_id, competition_id, game_name, status
          FROM match_lobbies
         WHERE bot_id = b.id
           AND status IN ('creating', 'waiting', 'launching', 'active')
         ORDER BY id DESC LIMIT 1
      ) ml ON TRUE
      LEFT JOIN competitions c ON c.id = ml.competition_id
      LEFT JOIN queue_matches qm ON qm.match_id = ml.match_id AND ml.competition_id IS NULL
      LEFT JOIN queue_pools qp ON qp.id = qm.pool_id
      ORDER BY b.id
    `)
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

  async setAvatarForAllBots(imageBuffer, mimeType = 'image/jpeg', _filename = 'avatar.jpg') {
    const bots = await query("SELECT id, username, password FROM lobby_bots ORDER BY id")
    const results = []
    const format = mimeType === 'image/png' ? 'png' : (mimeType === 'image/gif' ? 'gif' : 'jpg')

    for (const bot of bots) {
      try {
        const url = await this._uploadAvatarForBot(bot.username, bot.password, imageBuffer, format)
        results.push({ botId: bot.id, username: bot.username, ok: true, url })
      } catch (e) {
        results.push({ botId: bot.id, username: bot.username, ok: false, error: e.message })
      }
      // Small delay between bots to avoid Steam rate limits
      await new Promise((r) => setTimeout(r, 1500))
    }

    return results
  }

  async _uploadAvatarForBot(accountName, password, imageBuffer, format) {
    if (!password) throw new Error('no password stored for this bot')

    // Step 1: web-browser login session via steam-session (independent of any
    // running Steam game client; will not kick the bot's Dota session)
    const session = new LoginSession(EAuthTokenPlatformType.WebBrowser)
    const cookies = await new Promise((resolve, reject) => {
      const cleanup = () => {
        try { session.removeAllListeners() } catch {}
        try { session.cancelLoginAttempt() } catch {}
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('login timed out'))
      }, 60000)

      session.on('authenticated', async () => {
        try {
          const c = await session.getWebCookies()
          clearTimeout(timer)
          cleanup()
          resolve(c)
        } catch (err) {
          clearTimeout(timer)
          cleanup()
          reject(err)
        }
      })
      session.on('error', (err) => {
        clearTimeout(timer)
        cleanup()
        reject(err)
      })
      session.on('timeout', () => {
        clearTimeout(timer)
        cleanup()
        reject(new Error('login session timed out'))
      })

      session.startWithCredentials({ accountName, password })
        .then((startResult) => {
          if (startResult && startResult.actionRequired) {
            // Steam Guard required — we don't have a code at upload time
            clearTimeout(timer)
            cleanup()
            const types = (startResult.validActions || []).map(a => a.type).join(',')
            reject(new Error(`steam guard required (${types || 'unknown'})`))
          }
        })
        .catch((err) => {
          clearTimeout(timer)
          cleanup()
          reject(err)
        })
    })

    // Step 2: hand cookies to steamcommunity and upload
    const community = new SteamCommunity()
    community.setCookies(cookies)

    const url = await new Promise((resolve, reject) => {
      community.uploadAvatar(imageBuffer, format, (err, avatarUrl) => {
        if (err) reject(err)
        else resolve(avatarUrl)
      })
    })

    return url
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
             t1.team AS team1_name, t2.team AS team2_name,
             t1.dota_team_id AS team1_dota_id, t2.dota_team_id AS team2_dota_id
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

    // Apply standins: swap original players with standins
    // Game-specific standins override match-level ones
    const matchGameRow = await queryOne('SELECT id FROM match_games WHERE match_id = $1 AND game_number = $2', [matchId, gameNumber])
    const standins = await query(`
      SELECT DISTINCT ON (ms.original_player_id)
        ms.original_player_id, p.steam_id, COALESCE(p.display_name, p.name) AS name
      FROM match_standins ms
      JOIN players p ON p.id = ms.standin_player_id
      WHERE ms.match_id = $1 AND (ms.match_game_id IS NULL OR ms.match_game_id = $2)
      ORDER BY ms.original_player_id, ms.match_game_id NULLS LAST
    `, [matchId, matchGameRow?.id || 0])
    for (const s of standins) {
      if (!s.steam_id) continue
      // Find the original player's steam_id
      const origPlayer = await queryOne('SELECT steam_id FROM players WHERE id = $1', [s.original_player_id])
      if (origPlayer?.steam_id) {
        const idx = playersExpected.findIndex(pe => pe.steam_id === origPlayer.steam_id)
        if (idx >= 0) {
          playersExpected[idx] = { steam_id: s.steam_id, name: s.name, team: playersExpected[idx].team }
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
    const cheats = !!compSettings.lobbyCheats
    const allowSpectating = compSettings.lobbyAllowSpectating !== false
    const pauseSetting = compSettings.lobbyPauseSetting || 0
    const selectionPriority = compSettings.lobbySelectionPriority || 0
    const cmPick = compSettings.lobbyCmPick || 0
    const penaltyRadiant = match.penalty_radiant ?? compSettings.lobbyPenaltyRadiant ?? 0
    const penaltyDire = match.penalty_dire ?? compSettings.lobbyPenaltyDire ?? 0
    const seriesType = compSettings.lobbySeriesType || 0
    const timeoutMinutes = Number(compSettings.lobbyTimeoutMinutes) || 10

    const gameName = options.game_name || `${match.team1_name || 'Team 1'} vs ${match.team2_name || 'Team 2'} - Game ${gameNumber}`
    const password = options.password || Math.random().toString(36).slice(2, 8)

    const lobby = await queryOne(`
      INSERT INTO match_lobbies (match_id, game_number, competition_id, bot_id, status, server_region, game_name, password, players_expected)
      VALUES ($1, $2, $3, $4, 'creating', $5, $6, $7, $8) RETURNING *
    `, [matchId, gameNumber, compId, availableBot.id, serverRegion, gameName, password, JSON.stringify(playersExpected)])

    await execute("UPDATE lobby_bots SET status = 'busy', last_used_at = NOW() WHERE id = $1", [availableBot.id])

    // Auto-set match status to live when first lobby is created
    await execute("UPDATE matches SET status = 'live' WHERE id = $1 AND status = 'pending'", [matchId])

    console.log('[Lobby] Settings from DB:', { cheats, allowSpectating, pauseSetting, selectionPriority, cmPick, penaltyRadiant, penaltyDire, seriesType })

    // Send to Go service — include botId so Go uses the same bot Node selected
    this._sendToGo('create_lobby', {
      lobbyId: String(lobby.id),
      botId: String(availableBot.id),
      gameName,
      password,
      serverRegion,
      gameMode,
      autoAssignTeams,
      leagueId,
      dotaTvDelay,
      cheats,
      allowSpectating,
      pauseSetting,
      selectionPriority,
      cmPick,
      penaltyRadiant,
      penaltyDire,
      seriesType,
      radiantName: match.team1_name || '',
      direName: match.team2_name || '',
      expectedRadiantTeamId: match.team1_dota_id || 0,
      expectedDireTeamId: match.team2_dota_id || 0,
      players: playersExpected.map(p => ({ steamId: p.steam_id, name: p.name, team: p.team })),
      timeoutMinutes,
    })

    return { ...lobby, players_expected: playersExpected }
  }

  async forceLaunch(lobbyDbId, { skipValidation = false } = {}) {
    await execute("UPDATE match_lobbies SET status = 'launching', updated_at = NOW() WHERE id = $1", [lobbyDbId])
    const lobby = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [lobbyDbId])
    if (lobby && this.io) {
      (await this._lobbyRooms(lobby)).emit('lobby:statusUpdate', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        status: 'launching',
      })
    }
    this._sendToGo('force_launch', { lobbyId: String(lobbyDbId), skipValidation })
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
  // Build the create_lobby payload for the Go bot service. Shared by the
  // initial createQueueLobby call and the retry path.
  _buildGoLobbyPayload(lobby, pool, team1Name, team2Name, playersExpected) {
    return {
      lobbyId: String(lobby.id),
      botId: lobby.bot_id ? String(lobby.bot_id) : undefined,
      gameName: lobby.game_name,
      password: lobby.password,
      serverRegion: pool.lobby_server_region || 3,
      gameMode: pool.lobby_game_mode || 2,
      autoAssignTeams: pool.lobby_auto_assign_teams !== false,
      leagueId: pool.lobby_league_id || 0,
      dotaTvDelay: pool.lobby_dotv_delay ?? 1,
      cheats: !!pool.lobby_cheats,
      allowSpectating: pool.lobby_allow_spectating !== false,
      pauseSetting: pool.lobby_pause_setting || 0,
      selectionPriority: pool.lobby_selection_priority || 0,
      cmPick: pool.lobby_cm_pick || 0,
      penaltyRadiant: pool.lobby_penalty_radiant || 0,
      penaltyDire: pool.lobby_penalty_dire || 0,
      seriesType: pool.lobby_series_type || 0,
      radiantName: team1Name,
      direName: team2Name,
      expectedRadiantTeamId: 0,
      expectedDireTeamId: 0,
      players: playersExpected.map(p => ({ steamId: p.steam_id || p.steamId, name: p.name, team: p.team })),
      timeoutMinutes: pool.lobby_timeout_minutes || 10,
    }
  }

  async createQueueLobby(poolId, matchId, gameNumber, team1Players, team2Players) {
    // Check for active lobby
    const activeLobby = await queryOne(
      "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND status NOT IN ('completed', 'cancelled', 'error')",
      [matchId, gameNumber]
    )
    if (activeLobby) throw new Error('A lobby already exists for this game')

    await execute(
      "DELETE FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND status IN ('completed', 'cancelled', 'error')",
      [matchId, gameNumber]
    )

    // Find available bot
    const availableBot = await queryOne("SELECT id FROM lobby_bots WHERE status = 'available' ORDER BY last_used_at NULLS FIRST LIMIT 1")
    if (!availableBot) throw new Error('No available bots')

    // Get pool settings
    const pool = await queryOne('SELECT * FROM queue_pools WHERE id = $1', [poolId])
    if (!pool) throw new Error('Queue pool not found')

    const playersExpected = [...team1Players, ...team2Players]
    const team1Name = team1Players[0]?.name || 'Team 1'
    const team2Name = team2Players[0]?.name || 'Team 2'
    const gameName = `${team1Name} vs ${team2Name} - Game ${gameNumber}`
    const password = Math.random().toString(36).slice(2, 8)

    const lobby = await queryOne(`
      INSERT INTO match_lobbies (match_id, game_number, competition_id, bot_id, status, server_region, game_name, password, players_expected)
      VALUES ($1, $2, NULL, $3, 'creating', $4, $5, $6, $7) RETURNING *
    `, [matchId, gameNumber, availableBot.id, pool.lobby_server_region || 3, gameName, password, JSON.stringify(playersExpected)])

    await execute("UPDATE lobby_bots SET status = 'busy', last_used_at = NOW() WHERE id = $1", [availableBot.id])
    await execute("UPDATE matches SET status = 'live' WHERE id = $1 AND status = 'pending'", [matchId])

    this._sendToGo('create_lobby', this._buildGoLobbyPayload(lobby, pool, team1Name, team2Name, playersExpected))
    return lobby
  }

  // Admin-triggered manual retry. Marks any non-terminal existing lobby for
  // this match as errored (so _retryQueueLobby's prev-error count works),
  // then dispatches a fresh create via a different bot. Does NOT enforce the
  // 3-attempt cap — the admin is deciding.
  async adminRetryQueueLobby(matchId) {
    // Guard: if there's already a non-terminal lobby, don't create another
    const active = await queryOne(
      "SELECT 1 FROM match_lobbies WHERE match_id = $1 AND game_number = 1 AND status NOT IN ('completed', 'cancelled', 'error')",
      [matchId]
    )
    if (active) throw new Error('A lobby is already active for this match — wait for it to finish or cancel it first')

    const latest = await queryOne(
      "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = 1 ORDER BY id DESC LIMIT 1",
      [matchId]
    )
    if (!latest) throw new Error('No lobby found for this match')

    // If there's an in-flight lobby, tell Go to drop it, mark it errored, and
    // free its bot so the retry picks a different one.
    if (latest.status !== 'error' && latest.status !== 'cancelled' && latest.status !== 'completed') {
      try { this._sendToGo('cancel_lobby', { lobbyId: String(latest.id) }) } catch {}
      await execute(
        "UPDATE match_lobbies SET status = 'error', error_message = 'Admin retry requested', updated_at = NOW() WHERE id = $1",
        [latest.id]
      )
      if (latest.bot_id) {
        await execute("UPDATE lobby_bots SET status = 'available' WHERE id = $1", [latest.bot_id])
      }
    }

    // Reload with updated status/error before delegating
    const reloaded = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [latest.id])
    const ok = await this._retryQueueLobby(reloaded, { force: true })
    if (!ok) throw new Error('Retry dispatch failed (no alternate bot available)')
    return true
  }

  // Retry a queue-match lobby with a different bot after a create-time error.
  // Called from _onLobbyError when the failing lobby belongs to a queue match
  // and the error is not a timeout (timeouts are handled as no-shows). Returns
  // true if a retry was dispatched, false if we gave up (max attempts, no
  // alternate bot, etc).
  async _retryQueueLobby(erroredLobby, opts = {}) {
    const MAX_ATTEMPTS = 3
    const force = !!opts.force

    const countRow = await queryOne(
      "SELECT COUNT(*)::int AS n FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND status = 'error'",
      [erroredLobby.match_id, erroredLobby.game_number]
    )
    const prevErrors = countRow?.n || 0
    if (!force && prevErrors >= MAX_ATTEMPTS) {
      console.log(`[Queue] Lobby retry limit (${MAX_ATTEMPTS}) reached for match ${erroredLobby.match_id}, giving up`)
      if (this.io) {
        (await this._lobbyRooms(erroredLobby)).emit('queue:error', {
          message: `Lobby creation failed after ${MAX_ATTEMPTS} attempts with different bots. Please contact an admin.`,
        })
      }
      return false
    }

    // Pick a different available bot. Exclude the bot that just failed so we
    // actually retry on fresh hardware.
    const nextBot = await queryOne(
      "SELECT id FROM lobby_bots WHERE status = 'available' AND id <> $1 ORDER BY last_used_at NULLS FIRST LIMIT 1",
      [erroredLobby.bot_id || 0]
    )
    if (!nextBot) {
      console.log(`[Queue] No alternate bot available for match ${erroredLobby.match_id} retry`)
      if (this.io) {
        (await this._lobbyRooms(erroredLobby)).emit('queue:error', {
          message: 'Lobby creation failed and no alternate bot is available. Please contact an admin.',
        })
      }
      return false
    }

    const qm = await queryOne(
      'SELECT pool_id, team1_players, team2_players FROM queue_matches WHERE match_id = $1',
      [erroredLobby.match_id]
    )
    if (!qm) return false
    const pool = await queryOne('SELECT * FROM queue_pools WHERE id = $1', [qm.pool_id])
    if (!pool) return false

    const playersExpected = Array.isArray(erroredLobby.players_expected) ? erroredLobby.players_expected : []
    const team1Name = (qm.team1_players?.[0]?.name) || 'Team 1'
    const team2Name = (qm.team2_players?.[0]?.name) || 'Team 2'
    const gameName = erroredLobby.game_name
    // Fresh password so any stale clients can't accidentally join the previous
    // (failed) lobby if it somehow came online late.
    const password = Math.random().toString(36).slice(2, 8)

    const newLobby = await queryOne(`
      INSERT INTO match_lobbies (match_id, game_number, competition_id, bot_id, status, server_region, game_name, password, players_expected)
      VALUES ($1, $2, NULL, $3, 'creating', $4, $5, $6, $7) RETURNING *
    `, [
      erroredLobby.match_id, erroredLobby.game_number, nextBot.id,
      pool.lobby_server_region || 3, gameName, password, JSON.stringify(playersExpected),
    ])

    await execute("UPDATE lobby_bots SET status = 'busy', last_used_at = NOW() WHERE id = $1", [nextBot.id])

    this._sendToGo('create_lobby', this._buildGoLobbyPayload(newLobby, pool, team1Name, team2Name, playersExpected))

    console.log(`[Queue] Retrying lobby for match ${erroredLobby.match_id} on bot ${nextBot.id} (attempt ${prevErrors + 1}/${MAX_ATTEMPTS})`)

    if (this.io) {
      (await this._lobbyRooms(newLobby)).emit('queue:lobbyRetrying', {
        matchId: erroredLobby.match_id,
        gameNumber: erroredLobby.game_number,
        attempt: prevErrors + 1,
        maxAttempts: MAX_ATTEMPTS,
        lobbyInfo: { gameName, password },
      })
    }

    return true
  }
}

export const botPool = new BotPool()
