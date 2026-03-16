import { EventEmitter } from 'events'

// Try to load bot libraries - optional (won't crash if not installed)
let SteamUser = null
let Dota2 = null
try {
  SteamUser = (await import('steam-user')).default || (await import('steam-user'))
  Dota2 = (await import('dota2')).default || (await import('dota2'))
} catch {
  console.warn('steam-user/dota2 packages not installed - lobby bot features disabled')
}

export class LobbyBot extends EventEmitter {
  constructor(botId, username, password, refreshToken = null) {
    super()
    this.botId = botId
    this.username = username
    this.password = password
    this.refreshToken = refreshToken
    this.steamClient = null
    this.dota2Client = null
    this.connected = false
    this.gcReady = false
    this.currentLobbyId = null
    this._steamGuardResolver = null
    this._reconnectTimer = null
  }

  async login() {
    if (!SteamUser || !Dota2) throw new Error('steam-user/dota2 packages not installed. Run: npm install steam-user dota2')

    return new Promise((resolve, reject) => {
      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          reject(new Error('Steam login timed out after 60s'))
        }
      }, 60000)

      this.steamClient = new SteamUser()

      this.steamClient.on('loggedOn', () => {
        this.connected = true
        this.emit('steamLoggedOn')

        // Resolve promise on Steam login — GC connects async after
        if (!resolved) { resolved = true; clearTimeout(timeout); resolve() }

        this.steamClient.setPersona(SteamUser.EPersonaState.Online)
        this.steamClient.gamesPlayed([570]) // Dota 2 app ID

        // Create compatibility shim for node-dota2 which expects old node-steam client
        const steamUser = this.steamClient
        const EventEmitterProto = EventEmitter.prototype
        const shimClient = Object.create(EventEmitterProto)
        shimClient._client = steamUser
        shimClient.send = function(header, body) {
          const msgType = header.msg
          const proto = header.proto || null
          steamUser.sendToGC(570, msgType, proto, body)
        }
        EventEmitterProto.constructor.call(shimClient)

        // Forward GC messages from steam-user to the shim as 'message' events
        steamUser.on('receivedFromGC', (appId, msgType, payload) => {
          if (appId === 570) {
            shimClient.emit('message', { msg: msgType, proto: {} }, payload)
          }
        })

        this.dota2Client = new Dota2.Dota2Client(shimClient, true, true)
        this.dota2Client.launch()

        this.dota2Client.on('ready', () => {
          this.gcReady = true
          this.emit('ready')
        })

        this.dota2Client.on('unready', () => {
          this.gcReady = false
          this.emit('gcDisconnected')
        })
      })

      this.steamClient.on('steamGuard', (domain, callback) => {
        this.emit('steamGuard', domain)
        this._steamGuardResolver = callback
      })

      this.steamClient.on('refreshToken', (token) => {
        this.refreshToken = token
        this.emit('refreshToken', token)
      })

      this.steamClient.on('error', (err) => {
        this.connected = false
        this.gcReady = false
        this.emit('error', err)
        if (!resolved) { resolved = true; clearTimeout(timeout); reject(err) }
      })

      this.steamClient.on('disconnected', () => {
        this.connected = false
        this.gcReady = false
        this.emit('disconnected')
      })

      // Login
      const loginOptions = { renewRefreshTokens: true }
      if (this.refreshToken) {
        loginOptions.refreshToken = this.refreshToken
      } else {
        loginOptions.accountName = this.username
        loginOptions.password = this.password
      }
      this.steamClient.logOn(loginOptions)
    })
  }

  submitSteamGuardCode(code) {
    if (this._steamGuardResolver) {
      this._steamGuardResolver(code)
      this._steamGuardResolver = null
    }
  }

  async createLobby(options = {}) {
    if (!this.gcReady) throw new Error('Dota 2 GC not ready')

    return new Promise((resolve, reject) => {
      const lobbyOptions = {
        game_name: options.game_name || 'Draft League Match',
        pass_key: options.password || '',
        server_region: options.server_region ?? 3,
        game_mode: 2, // Captain's Mode
        allow_cheats: false,
        allow_spectating: true,
        fill_with_bots: false,
      }

      this.dota2Client.createPracticeLobby(lobbyOptions, (err, body) => {
        if (err) return reject(new Error('Failed to create lobby: ' + err))

        // Listen for lobby update to confirm creation
        const onUpdate = (lobby) => {
          this.currentLobbyId = lobby.lobby_id?.toString() || null
          this.dota2Client.removeListener('practiceLobbyUpdate', onUpdate)
          resolve(lobby)
        }
        this.dota2Client.on('practiceLobbyUpdate', onUpdate)
      })
    })
  }

  invitePlayers(steamIds) {
    if (!this.gcReady) return
    for (const steamId of steamIds) {
      if (steamId) {
        try {
          this.dota2Client.inviteToLobby(steamId)
        } catch (e) {
          console.error(`Failed to invite ${steamId}:`, e.message)
        }
      }
    }
  }

  onLobbyUpdate(callback) {
    if (!this.dota2Client) return
    this.dota2Client.on('practiceLobbyUpdate', callback)
  }

  offLobbyUpdate(callback) {
    if (!this.dota2Client) return
    this.dota2Client.removeListener('practiceLobbyUpdate', callback)
  }

  async launchLobby() {
    if (!this.gcReady) throw new Error('Dota 2 GC not ready')
    return new Promise((resolve, reject) => {
      this.dota2Client.launchPracticeLobby((err) => {
        if (err) return reject(new Error('Failed to launch: ' + err))
        resolve()
      })
    })
  }

  async leaveLobby() {
    if (!this.gcReady) return
    return new Promise((resolve) => {
      this.dota2Client.leavePracticeLobby((err) => {
        this.currentLobbyId = null
        resolve()
      })
    })
  }

  async destroyLobby() {
    if (!this.gcReady) return
    return new Promise((resolve) => {
      this.dota2Client.destroyLobby((err) => {
        this.currentLobbyId = null
        resolve()
      })
    })
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    if (this.dota2Client) {
      try { this.dota2Client.exit() } catch {}
      this.dota2Client = null
    }
    if (this.steamClient) {
      try { this.steamClient.logOff() } catch {}
      this.steamClient = null
    }
    this.connected = false
    this.gcReady = false
    this.currentLobbyId = null
  }
}
