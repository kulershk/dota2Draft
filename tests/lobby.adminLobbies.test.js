// REST: /api/admin/lobbies* (admin lobby history + kick). Mounts only the
// lobby router on a throwaway express app — tests/setup.js doesn't mount it.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import express from 'express'
import { createServer } from 'http'
import { initDb, queryOne, execute } from '../server/db.js'
import { createSession } from '../server/middleware/auth.js'
import { botPool } from '../server/services/botPool.js'
import createLobbyRouter from '../server/routes/lobby.js'
import { seedCompMatch, seedBot, seedLobby, cleanupSeed, seedQueueMatch, seedQueueLobby, cleanupQueueSeed } from './helpers/botSeed.js'

let server, baseUrl, seed, qseed, bot, admin, user, adminToken, userToken
let liveLobby, doneLobby, oldLobby, queueLobby
const sent = []

beforeAll(async () => {
  delete process.env.STEAM_API_KEY
  await initDb()
  const app = express()
  app.use(express.json())
  app.use(createLobbyRouter(null))
  server = createServer(app)
  await new Promise(r => server.listen(0, r))
  baseUrl = `http://localhost:${server.address().port}`

  seed = await seedCompMatch()
  qseed = await seedQueueMatch()
  bot = await seedBot({ status: 'busy' })
  admin = await queryOne("INSERT INTO players (name, steam_id, mmr, roles, is_admin) VALUES ('LobAdmin', $1, 3000, '[]', TRUE) RETURNING *", [`la_${Date.now()}`])
  user = await queryOne("INSERT INTO players (name, steam_id, mmr, roles) VALUES ('LobUser', $1, 3000, '[]') RETURNING *", [`lu_${Date.now()}`])
  adminToken = createSession(admin.id)
  userToken = createSession(user.id)

  oldLobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'error' })
  doneLobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'completed' })
  liveLobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'waiting' })
  queueLobby = await seedQueueLobby({ match: qseed.match, botId: bot.id, playersExpected: qseed.playersExpected, status: 'completed' })
  const p0 = seed.players[0]
  await execute('UPDATE match_lobbies SET members = $1 WHERE id = $2', [
    JSON.stringify([{ steamId: p0.steam_id, name: '', team: 'radiant', slot: 0 }]), liveLobby.id,
  ])
  await execute("INSERT INTO bot_logs (bot_id, level, lobby_id, message) VALUES ($1, 'info', $2, 'hello from the bot')", [bot.id, liveLobby.id])
})
afterEach(() => { botPool.goWs = null; sent.length = 0 })
afterAll(async () => {
  await new Promise(r => server.close(r))
  await cleanupQueueSeed({ ...qseed })
  await cleanupSeed({ ...seed, players: [...seed.players, admin, user], bots: [bot] })
})

const fakeGo = () => { botPool.goWs = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) } }
const api = async (path, { token = adminToken, method = 'GET', body } = {}) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

describe('permissions', () => {
  it('401 without a session, 403 without manage_bots', async () => {
    expect((await api('/api/admin/lobbies', { token: null })).status).toBe(401)
    expect((await api('/api/admin/lobbies', { token: userToken })).status).toBe(403)
    expect((await api(`/api/admin/lobbies/${liveLobby.id}`, { token: userToken })).status).toBe(403)
    expect((await api(`/api/admin/lobbies/${liveLobby.id}/kick`, { token: userToken, method: 'POST', body: {} })).status).toBe(403)
    expect((await api(`/api/admin/lobbies/${liveLobby.id}/unblock`, { token: userToken, method: 'POST', body: {} })).status).toBe(403)
  })
})

describe('GET /api/admin/lobbies', () => {
  const q = () => encodeURIComponent(seed.comp.name)

  it('filters live / recent and orders all as live first then id DESC', async () => {
    const live = await api(`/api/admin/lobbies?filter=live&q=${q()}`)
    expect(live.status).toBe(200)
    expect(live.body.lobbies.map(l => l.id)).toEqual([liveLobby.id])
    const recent = await api(`/api/admin/lobbies?filter=recent&q=${q()}`)
    expect(recent.body.lobbies.map(l => l.id)).toEqual([doneLobby.id, oldLobby.id])
    const all = await api(`/api/admin/lobbies?q=${q()}`)
    expect(all.body.lobbies.map(l => l.id)).toEqual([liveLobby.id, doneLobby.id, oldLobby.id])
    expect(all.body.nextBefore).toBeNull()
    expect(typeof all.body.goConnected).toBe('boolean')
  })

  it('row shape + labels', async () => {
    const { body } = await api(`/api/admin/lobbies?filter=live&q=${q()}`)
    const row = body.lobbies[0]
    expect(row).toMatchObject({
      id: liveLobby.id, status: 'waiting', bot_id: bot.id, bot_name: bot.username,
      match_id: seed.match.id, game_number: 1, competition_id: seed.comp.id, competition_name: seed.comp.name,
      queue_match_id: null, label: `${seed.comp.name} · Match #${seed.match.id} G1`,
      players_joined_count: 0, players_expected_count: 0, members_count: 1,
      error_message: null, dota_match_id: null,
    })
    expect(row.created_at).toBeTruthy()
    expect(row.updated_at).toBeTruthy()
    const queue = await api(`/api/admin/lobbies?q=${queueLobby.id}`)
    const qrow = queue.body.lobbies.find(l => l.id === queueLobby.id)
    expect(qrow.label).toBe(`Queue #${qseed.queueMatch.id}`)
    expect(qrow.queue_match_id).toBe(qseed.queueMatch.id)
  })

  it('searches by member steam id and expected player name', async () => {
    const byMember = await api(`/api/admin/lobbies?q=${seed.players[0].steam_id}`)
    expect(byMember.body.lobbies.map(l => l.id)).toContain(liveLobby.id)
    const byExpected = await api(`/api/admin/lobbies?q=${encodeURIComponent(qseed.players[1].name)}`)
    expect(byExpected.body.lobbies.map(l => l.id)).toEqual([queueLobby.id])
  })

  it('keyset-paginates the history', async () => {
    const p1 = await api(`/api/admin/lobbies?filter=recent&q=${q()}&limit=1`)
    expect(p1.body.lobbies.map(l => l.id)).toEqual([doneLobby.id])
    expect(p1.body.nextBefore).toBe(doneLobby.id)
    const p2 = await api(`/api/admin/lobbies?filter=recent&q=${q()}&limit=1&before=${p1.body.nextBefore}`)
    expect(p2.body.lobbies.map(l => l.id)).toEqual([oldLobby.id])
    expect(p2.body.nextBefore).toBeNull()
    // 'all': page 1 carries every live lobby, later pages only history.
    const a1 = await api(`/api/admin/lobbies?q=${q()}&limit=1`)
    expect(a1.body.lobbies.map(l => l.id)).toEqual([liveLobby.id, doneLobby.id])
    const a2 = await api(`/api/admin/lobbies?q=${q()}&limit=1&before=${a1.body.nextBefore}`)
    expect(a2.body.lobbies.map(l => l.id)).toEqual([oldLobby.id])
  })
})

describe('GET /api/admin/lobbies/:lobbyId', () => {
  it('returns lobby, other attempts, events and (optionally) bot logs', async () => {
    fakeGo()
    await botPool.kickPlayer(liveLobby.id, seed.players[0].steam_id, 'kick', admin.id)
    const { status, body } = await api(`/api/admin/lobbies/${liveLobby.id}?botLogs=1`)
    expect(status).toBe(200)
    expect(body.lobby).toMatchObject({
      id: liveLobby.id, label: `${seed.comp.name} · Match #${seed.match.id} G1`, bot_name: bot.username,
      game_name: 'test lobby', blocked_steam_ids: [seed.players[0].steam_id], players_expected: [], players_joined: [],
      members: [{ steamId: seed.players[0].steam_id, name: seed.players[0].name, team: 'radiant', slot: 0 }],
    })
    expect(body.lobby.password).toBeUndefined()
    expect(body.attempts.map(a => a.id)).toEqual([oldLobby.id, doneLobby.id])
    expect(Object.keys(body.attempts[0]).sort()).toEqual(['created_at', 'id', 'status'])
    const kick = body.events.find(e => e.type === 'admin_kick')
    expect(kick).toMatchObject({
      lobby_id: liveLobby.id, bot_id: bot.id, steam_id: seed.players[0].steam_id, player_id: seed.players[0].id,
      player_name: seed.players[0].name, actor_id: admin.id, actor_name: 'LobAdmin', data: {},
    })
    expect(typeof kick.id).toBe('number')
    expect(body.botLogs.map(l => l.message)).toEqual(['hello from the bot'])
    expect(body.botLogs[0]).toHaveProperty('level', 'info')
    expect(body.botLogs[0]).toHaveProperty('created_at')

    const noLogs = await api(`/api/admin/lobbies/${liveLobby.id}`)
    expect(noLogs.body.botLogs).toBeUndefined()
  })

  it('404 for an unknown lobby, 400 for a bad id', async () => {
    expect((await api('/api/admin/lobbies/999999999')).status).toBe(404)
    expect((await api('/api/admin/lobbies/abc')).status).toBe(400)
  })
})

describe('POST kick / unblock', () => {
  it('kick: 202 on success; 400 / 404 / 409 on guard failures', async () => {
    fakeGo()
    const sid = seed.players[0].steam_id
    const ok = await api(`/api/admin/lobbies/${liveLobby.id}/kick`, { method: 'POST', body: { steamId: sid, mode: 'unassign' } })
    expect(ok).toEqual({ status: 202, body: { ok: true } })
    expect(sent[0]).toEqual({ type: 'kick_player', data: { lobbyId: String(liveLobby.id), steamId: sid, mode: 'unassign' } })
    expect((await api(`/api/admin/lobbies/${liveLobby.id}/kick`, { method: 'POST', body: { steamId: sid, mode: 'nope' } })).status).toBe(400)
    expect((await api('/api/admin/lobbies/999999999/kick', { method: 'POST', body: { steamId: sid, mode: 'kick' } })).status).toBe(404)
    const done = await api(`/api/admin/lobbies/${doneLobby.id}/kick`, { method: 'POST', body: { steamId: sid, mode: 'kick' } })
    expect(done.status).toBe(409)
    expect(done.body.error).toBeTruthy()
    botPool.goWs = null
    expect((await api(`/api/admin/lobbies/${liveLobby.id}/kick`, { method: 'POST', body: { steamId: sid, mode: 'kick' } })).status).toBe(409)
  })

  it('unblock: 200 with the remaining list', async () => {
    fakeGo()
    const sid = seed.players[0].steam_id
    const res = await api(`/api/admin/lobbies/${liveLobby.id}/unblock`, { method: 'POST', body: { steamId: sid } })
    expect(res).toEqual({ status: 200, body: { ok: true, blockedSteamIds: [] } })
    expect(sent).toEqual([{ type: 'set_lobby_blocklist', data: { lobbyId: String(liveLobby.id), steamIds: [] } }])
    expect((await api(`/api/admin/lobbies/${doneLobby.id}/unblock`, { method: 'POST', body: { steamId: sid } })).status).toBe(409)
  })
})
