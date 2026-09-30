import { Router } from 'express'
import multer from 'multer'
import sharp from 'sharp'
import { query, queryOne, execute } from '../db.js'
import { requirePermission, requireCompPermission, playerCanManageComp } from '../middleware/permissions.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { botPool, LIVE_LOBBY_STATUSES_SQL, LobbyActionError, lobbyEventRow } from '../services/botPool.js'

// A match participant = a captain of either side, or a player drafted onto
// either side. Participants (and comp managers) may see the lobby password so
// they can join the in-game lobby; nobody else may.
export async function isMatchParticipant(playerId, matchId) {
  if (!playerId || !matchId) return false
  const row = await queryOne(
    `SELECT 1
       FROM matches m
       LEFT JOIN captains c1 ON c1.id = m.team1_captain_id
       LEFT JOIN captains c2 ON c2.id = m.team2_captain_id
      WHERE m.id = $1
        AND ( c1.player_id = $2 OR c2.player_id = $2
              OR EXISTS ( SELECT 1 FROM competition_players cp
                           WHERE cp.competition_id = m.competition_id
                             AND cp.player_id = $2
                             AND cp.drafted_by IN (m.team1_captain_id, m.team2_captain_id) )
              OR EXISTS ( SELECT 1 FROM match_standins ms
                           WHERE ms.match_id = m.id AND ms.standin_player_id = $2 ) )
      LIMIT 1`,
    [matchId, playerId],
  )
  return !!row
}

// Strip credential-ish fields from a lobby row before returning it to a client
// that isn't allowed to see the password.
function stripLobbyPassword(lobby) {
  if (!lobby) return lobby
  const { password, ...safe } = lobby
  return safe
}

// Only bot fields safe to return to an API caller — never the stored Steam
// password / refresh token / sentry / login key.
function publicBotFields(bot) {
  if (!bot) return bot
  return {
    id: bot.id,
    username: bot.username,
    display_name: bot.display_name,
    steam_id: bot.steam_id,
    status: bot.status,
    error_message: bot.error_message,
    auto_connect: bot.auto_connect,
    last_used_at: bot.last_used_at,
    created_at: bot.created_at,
  }
}

// Decides whether the GET-lobby route should auto-fix a row to 'error'
// because its bot went back to 'available' while the row still thinks it's
// waiting/launching for it. Skips lobbies with a dota_match_id set — that
// means the game already launched and players are loading in; completion
// and rollback for that state are owned by botPool._onDraftStarted /
// _onGameAborted, not this route. Pure so it's unit-testable without a DB.
export function shouldMarkBotDisconnected(lobby, botStatus) {
  if (!lobby || !lobby.bot_id) return false
  if (lobby.status !== 'waiting' && lobby.status !== 'launching') return false
  if (lobby.dota_match_id) return false
  return botStatus === 'available'
}

// ── Admin lobby history helpers ──

// JSONB column that may be NULL / non-array on legacy rows → always an array.
const jarr = (col) => `(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`

const ADMIN_LOBBY_COLUMNS = `
  ml.id, ml.status, ml.bot_id, COALESCE(NULLIF(b.display_name, ''), b.username) AS bot_name,
  ml.match_id, ml.game_number, ml.competition_id, c.name AS competition_name, qm.id AS queue_match_id,
  ml.game_name,
  jsonb_array_length(${jarr('ml.players_joined')})::int AS players_joined_count,
  jsonb_array_length(${jarr('ml.players_expected')})::int AS players_expected_count,
  jsonb_array_length(${jarr('ml.members')})::int AS members_count,
  ml.error_message, ml.dota_match_id, ml.created_at, ml.updated_at`

// Soft-deleted competitions are joined away (their name must not leak), but
// the lobby itself stays visible — it is still a record of what the bot did.
const ADMIN_LOBBY_FROM = `
  FROM match_lobbies ml
  LEFT JOIN lobby_bots b ON b.id = ml.bot_id
  LEFT JOIN competitions c ON c.id = ml.competition_id AND c.deleted_at IS NULL
  LEFT JOIN LATERAL (
    SELECT id FROM queue_matches WHERE match_id = ml.match_id AND ml.competition_id IS NULL ORDER BY id DESC LIMIT 1
  ) qm ON TRUE`

// Human label for a lobby row: "<comp> · Match #<id> G<n>" or "Queue #<id>".
export function lobbyLabel(r) {
  if (!r.competition_id && r.queue_match_id) return `Queue #${r.queue_match_id}`
  const prefix = r.competition_name ? `${r.competition_name} · ` : ''
  return `${prefix}Match #${r.match_id} G${r.game_number}`
}

const withLabel = (r) => ({ ...r, label: lobbyLabel(r) })

// `q` search: lobby / match / queue-match id, dota match id, game name,
// competition name, or a player name / steam id in members, players_expected
// or players_joined. Returns [sqlFragment, params] starting at $<offset>.
function lobbySearchClause(q, offset) {
  const raw = String(q).trim()
  const like = `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
  const num = /^\d{1,9}$/.test(raw) ? Number(raw) : null
  const L = `$${offset}`, R = `$${offset + 1}`, N = `$${offset + 2}::int`
  const sql = `(
    ml.game_name ILIKE ${L} OR c.name ILIKE ${L} OR ml.dota_match_id = ${R}
    OR (${N} IS NOT NULL AND (ml.id = ${N} OR ml.match_id = ${N} OR qm.id = ${N}))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(${jarr('ml.members')}) m
                WHERE m->>'name' ILIKE ${L} OR m->>'steamId' = ${R})
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(${jarr('ml.players_expected')}) e
                WHERE e->>'name' ILIKE ${L} OR COALESCE(e->>'steam_id', e->>'steamId') = ${R})
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(${jarr('ml.players_joined')}) j
                WHERE j->>'name' ILIKE ${L} OR COALESCE(j->>'steamId', j->>'steam_id') = ${R})
  )`
  return [sql, [like, raw, num]]
}

// Keyset page (id DESC, id < before) of live or non-live lobbies. Fetches one
// extra row to know whether another page exists.
async function adminLobbyPage({ live, q, before, limit }) {
  const params = []
  const where = [`ml.status ${live ? '' : 'NOT '}IN ${LIVE_LOBBY_STATUSES_SQL}`]
  if (before) { params.push(before); where.push(`ml.id < $${params.length}`) }
  if (q) {
    const [sql, p] = lobbySearchClause(q, params.length + 1)
    params.push(...p)
    where.push(sql)
  }
  params.push(limit === null ? null : limit + 1)
  const rows = await query(
    `SELECT ${ADMIN_LOBBY_COLUMNS} ${ADMIN_LOBBY_FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY ml.id DESC
      LIMIT $${params.length}`,
    params
  )
  const hasMore = limit !== null && rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return { rows: page.map(withLabel), nextBefore: hasMore ? page[page.length - 1].id : null }
}

// Replace member names with the registered player's current name (Go never
// knows persona names; rows stored before a rename keep the old one).
async function resolveMemberNames(members) {
  const list = Array.isArray(members) ? members : []
  const ids = list.map(m => String(m?.steamId || '')).filter(Boolean)
  if (ids.length === 0) return list
  const rows = await query('SELECT steam_id, COALESCE(display_name, name) AS name FROM players WHERE steam_id = ANY($1::text[])', [ids])
  const names = new Map(rows.map(r => [String(r.steam_id), r.name]))
  return list.map(m => ({ ...m, name: names.get(String(m.steamId)) || m.name || String(m.steamId) }))
}

const parseLobbyId = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null
}

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true)
    else cb(new Error('Only JPEG, PNG, or WebP images are allowed'))
  },
})

export default function createLobbyRouter(io) {
  const router = Router()

  // ── Bot Management (global admin) ──

  router.get('/api/admin/bots', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      // Reconcile the cached DB statuses against Go's LIVE state before reading,
      // so the page reflects reality instead of a possibly-stale column (e.g.
      // after a restart that reset everything to offline, or a dropped status
      // event). Best-effort: falls back to the cached values if Go is
      // unreachable or slow. `goConnected` + `syncedAt` let the UI flag whether
      // it's showing live status or last-known cache.
      const synced = await botPool._syncBotStatusesFromGo().catch(() => false)
      const bots = await botPool.getBotStatuses()
      res.json({
        bots,
        goConnected: botPool.isGoConnected(),
        syncedAt: synced ? new Date().toISOString() : null,
      })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const { username, password } = req.body
      if (!username || !password) return res.status(400).json({ error: 'Username and password required' })
      const bot = await botPool.addBot(username, password)
      res.json(publicBotFields(bot))
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/connect-all', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const result = await botPool.connectAllBots()
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/disconnect-all', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const result = await botPool.disconnectAllBots()
      res.json({ ok: true, ...result })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.delete('/api/admin/bots/:botId', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      await botPool.removeBot(Number(req.params.botId))
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.get('/api/admin/bots/:botId/logs', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      res.json(await botPool.getBotLogs(Number(req.params.botId)))
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/api/admin/bots/:botId/status-history', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const history = await botPool.getBotStatusHistory(Number(req.params.botId))
      res.json(history)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/:botId/free', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const botId = Number(req.params.botId)
      // Cancel any active lobbies for this bot
      const activeLobbies = await query(
        "SELECT id FROM match_lobbies WHERE bot_id = $1 AND status NOT IN ('completed', 'cancelled', 'error')",
        [botId]
      )
      for (const lobby of activeLobbies) {
        await botPool.cancelLobby(lobby.id, { actorId: admin.id })
      }
      // Force bot status to available
      await execute("UPDATE lobby_bots SET status = 'available' WHERE id = $1", [botId])
      if (io) io.to('perm:manage_bots').emit('bot:statusChanged', { botId, status: 'available' })
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/:botId/connect', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      // Don't await - login happens in background, status updates via socket
      botPool.connectBot(Number(req.params.botId)).catch(() => {})
      res.json({ ok: true, status: 'connecting' })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/:botId/disconnect', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      await botPool.disconnectBot(Number(req.params.botId))
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/admin/bots/:botId/steam-guard', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const { code } = req.body
      if (!code) return res.status(400).json({ error: 'Code required' })
      await botPool.submitSteamGuard(Number(req.params.botId), code)
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // Auth guard runs BEFORE multer so an unauthenticated client can't make us
  // buffer a 5 MB upload into memory.
  const requireManageBots = async (req, res, next) => {
    const admin = await requirePermission(req, res, 'manage_bots')
    if (admin) next()
  }

  router.post('/api/admin/bots/avatar', requireManageBots, avatarUpload.single('avatar'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No image file provided' })

      // Normalize: square 512x512 JPEG so Steam never rejects it
      const jpegBuffer = await sharp(req.file.buffer)
        .resize(512, 512, { fit: 'cover', position: 'center' })
        .jpeg({ quality: 90 })
        .toBuffer()

      const results = await botPool.setAvatarForAllBots(jpegBuffer, 'image/jpeg', 'avatar.jpg')
      res.json({ results })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.put('/api/admin/bots/:botId/auto-connect', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const { autoConnect } = req.body
      await execute('UPDATE lobby_bots SET auto_connect = $1 WHERE id = $2', [!!autoConnect, Number(req.params.botId)])
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  // ── Admin lobby history + kick (bot admins) ──

  // Every bot-run lobby: live ones first (all of them, on the first page),
  // then recent history newest-first with keyset pagination on id.
  router.get('/api/admin/lobbies', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const filter = ['live', 'recent', 'all'].includes(req.query.filter) ? req.query.filter : 'all'
      const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null
      const before = req.query.before ? parseLobbyId(req.query.before) : null
      if (req.query.before && !before) return res.status(400).json({ error: 'Invalid before' })
      const limitRaw = Number(req.query.limit)
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50

      let lobbies, nextBefore
      if (filter === 'live') {
        ({ rows: lobbies, nextBefore } = await adminLobbyPage({ live: true, q, before, limit }))
      } else if (filter === 'recent') {
        ({ rows: lobbies, nextBefore } = await adminLobbyPage({ live: false, q, before, limit }))
      } else {
        // Live lobbies are bounded by the bot count, so page 1 carries all of
        // them; `before` / `limit` then page through the non-live history.
        const live = before ? { rows: [] } : await adminLobbyPage({ live: true, q, before: null, limit: null })
        const recent = await adminLobbyPage({ live: false, q, before, limit })
        lobbies = [...live.rows, ...recent.rows]
        nextBefore = recent.nextBefore
      }
      res.json({ lobbies, nextBefore, goConnected: botPool.isGoConnected() })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.get('/api/admin/lobbies/:lobbyId', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const lobbyId = parseLobbyId(req.params.lobbyId)
      if (!lobbyId) return res.status(400).json({ error: 'Invalid lobby id' })
      const row = await queryOne(
        `SELECT ${ADMIN_LOBBY_COLUMNS},
                ml.members, ml.players_expected, ml.players_joined, ml.blocked_steam_ids,
                ml.team_ids, ml.server_region, b.steam_id AS bot_steam_id
           ${ADMIN_LOBBY_FROM}
          WHERE ml.id = $1`,
        [lobbyId]
      )
      if (!row) return res.status(404).json({ error: 'Lobby not found' })
      const lobby = withLabel({
        ...row,
        members: await resolveMemberNames(row.members),
        players_expected: Array.isArray(row.players_expected) ? row.players_expected : [],
        players_joined: Array.isArray(row.players_joined) ? row.players_joined : [],
        blocked_steam_ids: Array.isArray(row.blocked_steam_ids) ? row.blocked_steam_ids : [],
      })
      const attempts = await query(
        `SELECT id, status, created_at FROM match_lobbies
          WHERE match_id = $1 AND game_number = $2 AND id <> $3
          ORDER BY id`,
        [row.match_id, row.game_number, lobbyId]
      )
      // Newest 1000 events, returned oldest → newest.
      const events = await query(
        `SELECT * FROM (
           SELECT e.*, COALESCE(a.display_name, a.name) AS actor_name, COALESCE(p.display_name, p.name) AS player_name
             FROM lobby_events e
             LEFT JOIN players a ON a.id = e.actor_id
             LEFT JOIN players p ON p.id = e.player_id
            WHERE e.lobby_id = $1
            ORDER BY e.id DESC
            LIMIT 1000
         ) x ORDER BY id`,
        [lobbyId]
      )
      const body = { lobby, attempts, events: events.map(lobbyEventRow), goConnected: botPool.isGoConnected() }
      if (req.query.botLogs === '1' || req.query.botLogs === 'true') {
        body.botLogs = await query(
          'SELECT id, bot_id, level, message, created_at FROM bot_logs WHERE lobby_id = $1 ORDER BY id',
          [lobbyId]
        )
      }
      res.json(body)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/api/admin/lobbies/:lobbyId/kick', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const lobbyId = parseLobbyId(req.params.lobbyId)
      if (!lobbyId) return res.status(400).json({ error: 'Invalid lobby id' })
      const { steamId, mode } = req.body || {}
      await botPool.kickPlayer(lobbyId, steamId, mode, admin.id)
      res.status(202).json({ ok: true })
    } catch (e) {
      res.status(e instanceof LobbyActionError ? e.status : 500).json({ error: e.message })
    }
  })

  router.post('/api/admin/lobbies/:lobbyId/unblock', async (req, res) => {
    try {
      const admin = await requirePermission(req, res, 'manage_bots')
      if (!admin) return
      const lobbyId = parseLobbyId(req.params.lobbyId)
      if (!lobbyId) return res.status(400).json({ error: 'Invalid lobby id' })
      const blockedSteamIds = await botPool.unblockPlayer(lobbyId, req.body?.steamId, admin.id)
      res.json({ ok: true, blockedSteamIds })
    } catch (e) {
      res.status(e instanceof LobbyActionError ? e.status : 500).json({ error: e.message })
    }
  })

  // ── Lobby Management (competition-scoped) ──

  router.post('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/lobby', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const matchId = Number(req.params.matchId)
      const gameNumber = Number(req.params.gameNumber)
      if (!compId || !matchId || !gameNumber) return res.status(400).json({ error: 'Invalid IDs' })

      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      const match = await queryOne('SELECT id FROM matches WHERE id = $1 AND competition_id = $2', [matchId, compId])
      if (!match) return res.status(404).json({ error: 'Match not found' })

      const lobby = await botPool.createLobby(compId, matchId, gameNumber, req.body || {})
      res.json(lobby)
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.get('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/lobby', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const matchId = Number(req.params.matchId)
      const gameNumber = Number(req.params.gameNumber)

      // Must be logged in. This is not admin-gated (players in the match need to
      // read the lobby to get the password), but it must never be anonymous.
      const player = await getAuthPlayer(req)
      if (!player) return res.status(401).json({ error: 'Not authenticated' })

      const lobby = await queryOne(
        "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND competition_id = $3 AND status NOT IN ('cancelled') AND archived_at IS NULL ORDER BY id DESC LIMIT 1",
        [matchId, gameNumber, compId]
      )
      if (!lobby) return res.json({ lobby: null })
      // Auto-fix: if bot is no longer busy and lobby is still waiting/launching,
      // mark as error. Skips loading lobbies (dota_match_id set) — see
      // shouldMarkBotDisconnected.
      if (lobby.bot_id && (lobby.status === 'waiting' || lobby.status === 'launching')) {
        const bot = await queryOne('SELECT status FROM lobby_bots WHERE id = $1', [lobby.bot_id])
        if (shouldMarkBotDisconnected(lobby, bot?.status)) {
          lobby.status = 'error'
          lobby.error_message = 'Bot disconnected from lobby'
          await execute("UPDATE match_lobbies SET status = 'error', error_message = 'Bot disconnected from lobby' WHERE id = $1", [lobby.id])
          await botPool._recordLobbyEvent(lobby.id, 'error', {
            botId: lobby.bot_id, data: { kind: 'bot_disconnected', message: 'Bot disconnected from lobby' },
          })
        }
      }
      // Only match participants (and comp managers) may see the lobby password.
      const canSeePassword =
        (await isMatchParticipant(player.id, matchId)) ||
        (await playerCanManageComp(player, compId))
      res.json({ lobby: canSeePassword ? lobby : stripLobbyPassword(lobby) })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  router.post('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/lobby/launch', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const matchId = Number(req.params.matchId)
      const gameNumber = Number(req.params.gameNumber)

      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      const lobby = await queryOne(
        "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND competition_id = $3 AND status = 'waiting' AND archived_at IS NULL",
        [matchId, gameNumber, compId]
      )
      if (!lobby) return res.status(404).json({ error: 'No active lobby found' })

      await botPool.forceLaunch(lobby.id, { skipValidation: true, actorId: admin.id })
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/lobby/cancel', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const matchId = Number(req.params.matchId)
      const gameNumber = Number(req.params.gameNumber)

      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      const lobby = await queryOne(
        "SELECT * FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND competition_id = $3 AND status NOT IN ('completed', 'cancelled') AND archived_at IS NULL",
        [matchId, gameNumber, compId]
      )
      if (!lobby) return res.status(404).json({ error: 'No active lobby found' })

      await botPool.cancelLobby(lobby.id, { actorId: admin.id })
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  router.post('/api/competitions/:compId/tournament/matches/:matchId/games/:gameNumber/lobby/reset', async (req, res) => {
    try {
      const compId = Number(req.params.compId)
      const matchId = Number(req.params.matchId)
      const gameNumber = Number(req.params.gameNumber)

      const admin = await requireCompPermission(req, res, compId)
      if (!admin) return

      // Cancel any still-live lobby first so the Go service destroys the in-game
      // lobby and frees the bot — otherwise a raw DELETE strands the bot 'busy'
      // with an orphaned live lobby. Scope to this competition so a manager of
      // one comp can't reset another comp's (or a queue) lobby.
      const activeLobbies = await query(
        "SELECT id FROM match_lobbies WHERE match_id = $1 AND game_number = $2 AND competition_id = $3 AND status NOT IN ('completed', 'cancelled') AND archived_at IS NULL",
        [matchId, gameNumber, compId]
      )
      for (const l of activeLobbies) {
        await botPool.cancelLobby(l.id).catch((e) => console.error('[Lobby reset] cancel failed:', e.message))
      }

      // Clear all lobby rows for this game (scoped to the competition). Rows
      // are archived, not deleted, so the admin lobby history survives; a row
      // whose cancel failed above is force-marked cancelled so nothing treats
      // it as live.
      await execute(
        `UPDATE match_lobbies
            SET archived_at = NOW(),
                status = CASE WHEN status IN ('completed', 'cancelled', 'error') THEN status ELSE 'cancelled' END
          WHERE match_id = $1 AND game_number = $2 AND competition_id = $3 AND archived_at IS NULL`,
        [matchId, gameNumber, compId]
      )

      if (io) {
        io.to(`comp:${compId}`).emit('lobby:statusUpdate', {
          matchId, gameNumber, status: null,
        })
      }

      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  })

  return router
}
