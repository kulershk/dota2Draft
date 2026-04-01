import { query, queryOne, execute } from '../db.js'
import { fetchAndSaveGameStats, fetchOpenDotaMatch, saveMatchGameStats, requestOpenDotaParse } from '../helpers/opendota.js'
import { awardXp, getTeamPlayerIds } from '../helpers/xp.js'
import { getCompetition, parseCompSettings } from '../helpers/competition.js'

class BotPool {
  constructor() {
    this.io = null
    this.goWs = null
    this.botLogs = new Map() // botId -> [{ time, message }]
    this.lobbyTeamIds = new Map() // lobbyId -> { radiant, dire }
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

    // Auto-connect bots that have auto_connect enabled
    for (const bot of bots) {
      if (bot.auto_connect && (bot.status === 'offline' || bot.status === 'error')) {
        console.log(`[Bot] Auto-connecting bot ${bot.id} (${bot.username})`)
        try {
          await this.connectBot(bot.id)
        } catch (e) {
          console.error(`[Bot] Auto-connect failed for ${bot.id}:`, e.message)
        }
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
            this._sendToGo('rejoin_lobby', {
              lobbyId: String(lobby.id),
              botId: String(botId),
              gameName: lobby.game_name,
              password: lobby.password,
              players: lobby.players_expected || [],
            })
          }
        }
      } catch (e) {
        console.error(`[Bot ${botId}] Failed to re-sync lobbies:`, e.message)
      }
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
      this.io.to(`comp:${lobby.competition_id}`).to(`match:${lobby.match_id}`).emit('lobby:statusUpdate', {
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
      this.io.to(`comp:${lobby.competition_id}`).to(`match:${lobby.match_id}`).emit('lobby:statusUpdate', {
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
      this.io.to(`comp:${lobby.competition_id}`).to(`match:${lobby.match_id}`).emit('lobby:statusUpdate', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        status: 'completed',
      })
      this.io.to(`comp:${lobby.competition_id}`).to(`match:${lobby.match_id}`).emit('lobby:matchIdCaptured', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        dotaMatchId,
      })
      this.io.to(`comp:${lobby.competition_id}`).emit('tournament:updated')
    }

    // Schedule OpenDota stats fetch
    this._scheduleStatsFetch(lobby.match_id, lobby.game_number, dotaMatchId)
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
      this.io.to(`comp:${lobby.competition_id}`).to(`match:${lobby.match_id}`).emit('lobby:teamIds', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        radiantTeamId,
        direTeamId,
        radiantTeamName,
        direTeamName,
      })
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
        this.io.to(`comp:${lobby.competition_id}`).to(`match:${lobby.match_id}`).emit('lobby:statusUpdate', {
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
      this.io.to(`comp:${lobby.competition_id}`).to(`match:${lobby.match_id}`).emit('lobby:statusUpdate', {
        matchId: lobby.match_id,
        gameNumber: lobby.game_number,
        status: 'error',
        errorMessage: data.error,
      })
    }
  }

  _scheduleStatsFetch(matchId, gameNumber, dotaMatchId) {
    // Request OpenDota to parse this match early
    requestOpenDotaParse(dotaMatchId).catch(() => {})

    // The actual fetching is handled by the polling job (_pollUnresolvedGames)
    // which runs every 2 minutes and picks up any game with dotabuff_id but no winner
    console.log(`[Stats] Match ${dotaMatchId} queued for auto-resolve (game ${gameNumber} of match ${matchId})`)
  }

  // Polling job: checks for games with dotabuff_id but no winner, fetches from OpenDota
  _startResultsPolling() {
    // Run every 10 minutes
    this._pollTimer = setInterval(() => this._pollUnresolvedGames(), 10 * 60 * 1000)
    // Also run once on startup after a short delay (catch games missed during downtime)
    setTimeout(() => this._pollUnresolvedGames(), 15 * 1000)
  }

  async _pollUnresolvedGames() {
    try {
      // Poll games that either have no winner yet, or have stats but are not fully parsed
      const unresolvedGames = await query(`
        SELECT mg.id, mg.match_id, mg.game_number, mg.dotabuff_id, mg.created_at, mg.winner_captain_id
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

      console.log(`[Stats] Polling ${unresolvedGames.length} unresolved/unparsed game(s)...`)

      for (const game of unresolvedGames) {
        try {
          const matchData = await fetchOpenDotaMatch(game.dotabuff_id)
          if (!matchData) {
            // Request parse if match not found yet
            await requestOpenDotaParse(game.dotabuff_id).catch(() => {})
            continue
          }

          // Save stats (will overwrite with parsed data if now available)
          const result = await saveMatchGameStats(game.id, matchData)

          // Auto-fill winner if OpenDota has the result and winner not yet set
          if (!game.winner_captain_id && matchData.radiant_win != null) {
            await this._autoFillGameWinner(game.match_id, game.game_number, matchData.radiant_win, matchData)
            console.log(`[Stats] Resolved game ${game.game_number} of match ${game.match_id} (dota: ${game.dotabuff_id})`)
          } else if (!result.parsed) {
            // Still not fully parsed, request parse again
            await requestOpenDotaParse(game.dotabuff_id).catch(() => {})
          } else if (game.winner_captain_id) {
            console.log(`[Stats] Updated parsed stats for game ${game.game_number} of match ${game.match_id}`)
          }
        } catch (e) {
          console.log(`[Stats] Poll failed for ${game.dotabuff_id}: ${e.message}`)
        }
      }
    } catch (e) {
      console.error('[Stats] Poll error:', e.message)
    }
  }

  async _autoFillGameWinner(matchId, gameNumber, radiantWin, matchData) {
    try {
      const match = await queryOne('SELECT * FROM matches WHERE id = $1', [matchId])
      if (!match) return

      // Determine which captain's team was radiant by matching player account_ids
      let winnerCaptainId = null

      if (matchData?.players?.length) {
        // Get players for each team
        const team1Players = await query(
          `SELECT p.steam_id FROM competition_players cp
           JOIN players p ON p.id = cp.player_id
           WHERE cp.drafted_by = $1 AND cp.competition_id = $2
           UNION
           SELECT p.steam_id FROM captains c JOIN players p ON p.id = c.player_id WHERE c.id = $1`,
          [match.team1_captain_id, match.competition_id]
        )
        const team1Steam32 = new Set(team1Players.map(p => p.steam_id ? String(BigInt(p.steam_id) - 76561197960265728n) : null).filter(Boolean))

        // Check which side team1 is on by matching account_ids from OpenDota
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
          // We have matches — determine winner based on actual sides
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
        winnerCaptainId = radiantWin ? match.team1_captain_id : match.team2_captain_id
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

      // Recalculate match score from all games
      const games = await query(
        'SELECT winner_captain_id FROM match_games WHERE match_id = $1 AND winner_captain_id IS NOT NULL',
        [matchId]
      )
      const score1 = games.filter(g => g.winner_captain_id === match.team1_captain_id).length
      const score2 = games.filter(g => g.winner_captain_id === match.team2_captain_id).length
      const bestOf = match.best_of || 3
      const winsNeeded = Math.ceil(bestOf / 2)

      let matchWinner = null
      let newStatus = 'live'
      if (bestOf === 2) {
        // Bo2: always play both games, then mark completed
        if (games.length >= 2) {
          newStatus = 'completed'
          if (score1 > score2) matchWinner = match.team1_captain_id
          else if (score2 > score1) matchWinner = match.team2_captain_id
          // 1-1 draw: matchWinner stays null
        }
      } else if (score1 >= winsNeeded) {
        matchWinner = match.team1_captain_id
        newStatus = 'completed'
      } else if (score2 >= winsNeeded) {
        matchWinner = match.team2_captain_id
        newStatus = 'completed'
      }

      await execute(
        'UPDATE matches SET score1 = $1, score2 = $2, winner_captain_id = $3, status = $4 WHERE id = $5',
        [score1, score2, matchWinner, newStatus, matchId]
      )

      // ── XP: match win (series) ──
      if (matchWinner && newStatus === 'completed') {
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

            if (stage.format !== 'group_stage') {
              const allStageMatches = await query(
                'SELECT * FROM matches WHERE competition_id = $1 AND stage = $2 ORDER BY round DESC, match_order',
                [match.competition_id, match.stage]
              )
              const finalMatch = allStageMatches.find(m => !m.next_match_id && m.winner_captain_id && m.bracket !== 'lower')
              if (finalMatch) {
                const placementMap = new Map()
                placementMap.set(finalMatch.winner_captain_id, 1)
                const finalistLoser = finalMatch.team1_captain_id === finalMatch.winner_captain_id
                  ? finalMatch.team2_captain_id : finalMatch.team1_captain_id
                if (finalistLoser) placementMap.set(finalistLoser, 2)
                if (stage.format === 'single_elimination' && stage.totalRounds) {
                  const semiRound = stage.totalRounds - 1
                  const semis = allStageMatches.filter(m => m.round === semiRound && m.bracket !== 'lower')
                  for (const semi of semis) {
                    if (semi.winner_captain_id) {
                      const loser = semi.team1_captain_id === semi.winner_captain_id
                        ? semi.team2_captain_id : semi.team1_captain_id
                      if (loser && !placementMap.has(loser)) placementMap.set(loser, 3)
                    }
                  }
                }
                const xpAmounts = { 1: settings.xpPlacement1st, 2: settings.xpPlacement2nd, 3: settings.xpPlacement3rd }
                const placementLabels = { 1: '1st place', 2: '2nd place', 3: '3rd place' }
                for (const [captainId, place] of placementMap) {
                  const xp = xpAmounts[place]
                  if (!xp) continue
                  const players = await getTeamPlayerIds(captainId, match.competition_id)
                  const cap = await queryOne('SELECT team FROM captains WHERE id = $1', [captainId])
                  for (const pid of players) {
                    awardXp(pid, xp, `placement_${place}`, 'stage', `${match.competition_id}:${match.stage}:${pid}`, {
                      competitionId: match.competition_id, competitionName: comp.name,
                      detail: `${placementLabels[place]} — ${cap?.team || 'Team'} in ${stage.name || 'Stage'}`,
                    })
                  }
                }
              }
            }
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
        ml.match_id AS active_match_id, ml.competition_id AS active_competition_id
      FROM lobby_bots b
      LEFT JOIN match_lobbies ml ON ml.bot_id = b.id AND ml.status IN ('creating', 'waiting', 'launching', 'active')
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
    const penaltyRadiant = compSettings.lobbyPenaltyRadiant || 0
    const penaltyDire = compSettings.lobbyPenaltyDire || 0
    const seriesType = compSettings.lobbySeriesType || 0

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
    })

    return { ...lobby, players_expected: playersExpected }
  }

  async forceLaunch(lobbyDbId, { skipValidation = false } = {}) {
    await execute("UPDATE match_lobbies SET status = 'launching', updated_at = NOW() WHERE id = $1", [lobbyDbId])
    const lobby = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [lobbyDbId])
    if (lobby && this.io) {
      this.io.to(`comp:${lobby.competition_id}`).to(`match:${lobby.match_id}`).emit('lobby:statusUpdate', {
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
}

export const botPool = new BotPool()
