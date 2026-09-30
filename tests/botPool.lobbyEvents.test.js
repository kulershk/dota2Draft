// Admin lobby history + kick: lobby_events recording, roster diff, block list
// and the kick/unblock orchestration in botPool (see
// docs/superpowers/specs/2026-10-01-admin-lobby-history-design.md §4).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { initDb, query, queryOne, execute } from '../server/db.js'
import { botPool } from '../server/services/botPool.js'
import { seedCompMatch, seedBot, seedLobby, cleanupSeed } from './helpers/botSeed.js'

const BOT_STEAM = '76561190000000001'
const OUTSIDER = '76561190000000999'

let seed, bot, admin
const sent = []
const emitted = []
beforeAll(async () => {
  delete process.env.STEAM_API_KEY
  await initDb()
  seed = await seedCompMatch()
  bot = await seedBot({ status: 'busy' })
  await execute('UPDATE lobby_bots SET steam_id = $1 WHERE id = $2', [BOT_STEAM, bot.id])
  admin = await queryOne("INSERT INTO players (name, steam_id, mmr, roles) VALUES ('LobbyAdmin', $1, 3000, '[\"Mid\"]') RETURNING *", [`adm_${Date.now()}`])
  botPool.io = { to: () => ({ emit: (ev, payload) => emitted.push({ ev, payload }), to() { return this } }) }
})
afterEach(() => { botPool.goWs = null; sent.length = 0; emitted.length = 0 })
afterAll(async () => {
  botPool.io = null
  await cleanupSeed({ ...seed, players: [...seed.players, admin], bots: [bot] })
})

const fakeGo = () => { botPool.goWs = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) } }
const events = (lobbyId, type) => query(
  `SELECT * FROM lobby_events WHERE lobby_id = $1 ${type ? 'AND type = $2' : ''} ORDER BY id`,
  type ? [lobbyId, type] : [lobbyId],
)
const p = (i) => seed.players[i]
// Go always sends name "" (the GC lobby member has no persona name) — Node
// resolves it from players, falling back to the steam id.
const member = (i, team, slot) => ({ steamId: p(i).steam_id, name: '', team, slot })

describe('roster diff in _onLobbyStatus', () => {
  let lobby
  beforeAll(async () => { lobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'waiting' }) })

  it('records joined / moved / left exactly once and stores members', async () => {
    const status = (members) => botPool._onLobbyStatus({ lobbyId: String(lobby.id), status: 'waiting', playersJoined: [], members })

    await status([member(0, 'unassigned', 0)]) // Go sends slot 0 off-team; stored as null
    await status([member(0, 'radiant', 0), member(1, 'pool', null)])
    await status([member(1, 'pool', null)])

    const ev = await events(lobby.id)
    const roster = ev.filter(e => e.type.startsWith('player_'))
    expect(roster.map(e => [e.type, e.steam_id])).toEqual([
      ['player_joined', p(0).steam_id],
      ['player_moved', p(0).steam_id],
      ['player_joined', p(1).steam_id],
      ['player_left', p(0).steam_id],
    ])
    expect(roster[0].data).toEqual({ name: p(0).name, team: 'unassigned', slot: null })
    expect(roster[1].data).toEqual({ name: p(0).name, fromTeam: 'unassigned', fromSlot: null, toTeam: 'radiant', toSlot: 0 })
    expect(roster[3].data).toEqual({ name: p(0).name, team: 'radiant' })
    // player_id resolved from the registered steam id
    expect(roster[0].player_id).toBe(p(0).id)
    expect(roster[0].bot_id).toBe(bot.id)

    const row = await queryOne('SELECT members FROM match_lobbies WHERE id = $1', [lobby.id])
    expect(row.members).toEqual([{ steamId: p(1).steam_id, name: p(1).name, team: 'pool', slot: null }])
    // Each recorded event is pushed to bot admins.
    expect(emitted.filter(e => e.ev === 'admin:lobbyEvent').length).toBe(ev.length)
    expect(emitted.find(e => e.ev === 'admin:lobbyEvent').payload.lobbyId).toBe(lobby.id)
  })

  it('a replayed identical lobby_status records nothing', async () => {
    const before = (await events(lobby.id)).length
    await botPool._onLobbyStatus({ lobbyId: String(lobby.id), status: 'waiting', playersJoined: [], members: [member(1, 'pool', null)] })
    expect((await events(lobby.id)).length).toBe(before)
  })

  it('an unregistered member is named by steam id; an empty roster is a real diff', async () => {
    const st = (members) => botPool._onLobbyStatus({ lobbyId: String(lobby.id), status: 'waiting', playersJoined: [], members })
    await st([member(1, 'pool', null), { steamId: OUTSIDER, name: '', team: 'spectator', slot: null }])
    const joined = (await events(lobby.id, 'player_joined')).at(-1)
    expect(joined).toMatchObject({ steam_id: OUTSIDER, player_id: null, data: { name: OUTSIDER, team: 'spectator', slot: null } })
    await st([member(1, 'pool', null)])
    expect((await events(lobby.id, 'player_left')).at(-1)).toMatchObject({ steam_id: OUTSIDER, data: { name: OUTSIDER, team: 'spectator' } })
  })

  it('missing members (old bot build / manager status) records nothing and keeps stored members', async () => {
    const before = (await events(lobby.id)).length
    await botPool._onLobbyStatus({ lobbyId: String(lobby.id), status: 'waiting', playersJoined: [] })
    expect((await events(lobby.id)).length).toBe(before)
    const row = await queryOne('SELECT members FROM match_lobbies WHERE id = $1', [lobby.id])
    expect(row.members).toHaveLength(1)
  })

  it('never records or stores the bot itself', async () => {
    const before = (await events(lobby.id)).length
    await botPool._onLobbyStatus({
      lobbyId: String(lobby.id), status: 'waiting', playersJoined: [],
      members: [member(1, 'pool', null), { steamId: BOT_STEAM, name: 'bot', team: 'unassigned', slot: null }],
    })
    expect((await events(lobby.id)).length).toBe(before)
    const row = await queryOne('SELECT members FROM match_lobbies WHERE id = $1', [lobby.id])
    expect(row.members.map(m => m.steamId)).toEqual([p(1).steam_id])
  })
})

describe('status_changed', () => {
  it('records only real changes and never touches terminal rows', async () => {
    const lobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'creating', gameNumber: 2 })
    const st = (status) => botPool._onLobbyStatus({ lobbyId: String(lobby.id), status, playersJoined: [], members: [] })
    await st('waiting')
    await st('waiting')
    await st('launching')
    const changes = await events(lobby.id, 'status_changed')
    expect(changes.map(e => e.data)).toEqual([{ from: 'creating', to: 'waiting' }, { from: 'waiting', to: 'launching' }])

    await execute("UPDATE match_lobbies SET status = 'completed' WHERE id = $1", [lobby.id])
    await botPool._onLobbyStatus({ lobbyId: String(lobby.id), status: 'waiting', playersJoined: [], members: [member(0, 'radiant', 0)] })
    expect(await events(lobby.id, 'status_changed')).toHaveLength(2)
    expect(await events(lobby.id, 'player_joined')).toHaveLength(0)
    expect((await queryOne('SELECT status, members FROM match_lobbies WHERE id = $1', [lobby.id]))).toEqual({ status: 'completed', members: [] })
  })
})

describe('lifecycle events', () => {
  it('match id, abort, draft start are recorded once each (replays are no-ops)', async () => {
    const lobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'launching', gameNumber: 3 })
    const id = String(lobby.id)
    await botPool._onGameStarted({ lobbyId: id, matchId: '7001' })
    await botPool._onGameStarted({ lobbyId: id, matchId: '7001' })
    await botPool._onGameAborted({ lobbyId: id, matchId: '7001' })
    await botPool._onGameAborted({ lobbyId: id, matchId: '7001' })
    await botPool._onGameStarted({ lobbyId: id, matchId: '7002' })
    await botPool._onDraftStarted({ lobbyId: id, matchId: '7002', confirmed: true })
    await botPool._onDraftStarted({ lobbyId: id, matchId: '7002', confirmed: true })
    const ev = (await events(lobby.id)).map(e => [e.type, e.data.matchId])
    expect(ev).toEqual([
      ['match_id_assigned', '7001'],
      ['game_aborted', '7001'],
      ['match_id_assigned', '7002'],
      ['draft_started', '7002'],
    ])
  })

  it('lobby_error is recorded when applied, not on replay', async () => {
    const lobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'waiting', gameNumber: 4 })
    // Stop the competition retry from claiming a real bot.
    const retry = vi.spyOn(botPool, '_retryCompLobby').mockResolvedValue(false)
    await botPool._onLobbyError({ lobbyId: String(lobby.id), error: 'GC went away', kind: 'create_failed' })
    await botPool._onLobbyError({ lobbyId: String(lobby.id), error: 'GC went away', kind: 'create_failed' })
    retry.mockRestore()
    const ev = await events(lobby.id, 'error')
    expect(ev.map(e => e.data)).toEqual([{ kind: 'create_failed', message: 'GC went away' }])
  })

  it('forceLaunch records launch_requested (auto flag + actor)', async () => {
    fakeGo()
    const lobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'waiting', gameNumber: 5 })
    await botPool.forceLaunch(lobby.id, { skipValidation: true, actorId: admin.id })
    await execute("UPDATE match_lobbies SET status = 'waiting' WHERE id = $1", [lobby.id])
    botPool._autoLaunchAt.delete(lobby.id)
    await botPool._autoLaunchQueueLobby(lobby.id)
    const ev = await events(lobby.id, 'launch_requested')
    expect(ev.map(e => [e.data.auto, e.actor_id])).toEqual([[false, admin.id], [true, null]])
  })

  it('cancelLobby records cancelled once', async () => {
    const lobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'waiting', gameNumber: 6 })
    await botPool.cancelLobby(lobby.id)
    await botPool.cancelLobby(lobby.id)
    expect(await events(lobby.id, 'cancelled')).toHaveLength(1)
  })

  it('an event write failure never throws into lobby handling', async () => {
    const r = await botPool._recordLobbyEvent(-1, 'created', { data: {} })
    expect(r).toBeNull()
  })
})

describe('kickPlayer', () => {
  let lobby
  beforeAll(async () => {
    lobby = await seedLobby({ match: seed.match, botId: bot.id, status: 'waiting', gameNumber: 7 })
    await execute('UPDATE match_lobbies SET members = $1 WHERE id = $2', [
      JSON.stringify([member(0, 'radiant', 0), member(1, 'dire', 0)]), lobby.id,
    ])
  })

  it('409 when the lobby is not waiting', async () => {
    fakeGo()
    const other = await seedLobby({ match: seed.match, botId: bot.id, status: 'active', gameNumber: 8 })
    await expect(botPool.kickPlayer(other.id, p(0).steam_id, 'kick', admin.id)).rejects.toMatchObject({ status: 409 })
  })

  it('409 when Go is disconnected', async () => {
    await expect(botPool.kickPlayer(lobby.id, p(0).steam_id, 'kick', admin.id)).rejects.toMatchObject({ status: 409 })
  })

  it('404 for an unknown lobby, 400 for a bad mode', async () => {
    fakeGo()
    await expect(botPool.kickPlayer(999999999, p(0).steam_id, 'kick', admin.id)).rejects.toMatchObject({ status: 404 })
    await expect(botPool.kickPlayer(lobby.id, p(0).steam_id, 'ban', admin.id)).rejects.toMatchObject({ status: 400 })
  })

  it('400 when the target is not in the lobby or is the bot itself', async () => {
    fakeGo()
    await expect(botPool.kickPlayer(lobby.id, '76561190000000555', 'kick', admin.id)).rejects.toMatchObject({ status: 400 })
    await expect(botPool.kickPlayer(lobby.id, BOT_STEAM, 'kick', admin.id)).rejects.toMatchObject({ status: 400 })
    expect(sent).toEqual([])
  })

  it('unassign sends kick_player only and records admin_unassign', async () => {
    fakeGo()
    await execute('UPDATE match_lobbies SET members = members || $1::jsonb WHERE id = $2', [
      JSON.stringify([{ steamId: OUTSIDER, name: OUTSIDER, team: 'pool', slot: null }]), lobby.id,
    ])
    await expect(botPool.kickPlayer(lobby.id, OUTSIDER, 'unassign', admin.id)).rejects.toMatchObject({ status: 400 })
    await botPool.kickPlayer(lobby.id, p(1).steam_id, 'unassign', admin.id)
    expect(sent).toEqual([{ type: 'kick_player', data: { lobbyId: String(lobby.id), steamId: p(1).steam_id, mode: 'unassign' } }])
    const ev = await events(lobby.id, 'admin_unassign')
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ actor_id: admin.id, steam_id: p(1).steam_id, player_id: p(1).id })
    expect((await queryOne('SELECT blocked_steam_ids FROM match_lobbies WHERE id = $1', [lobby.id])).blocked_steam_ids).toEqual([])
  })

  it('kick blocks (idempotently), sends kick_player + set_lobby_blocklist, records admin_kick', async () => {
    fakeGo()
    await botPool.kickPlayer(lobby.id, p(0).steam_id, 'kick', admin.id)
    await botPool.kickPlayer(lobby.id, p(0).steam_id, 'kick', admin.id)
    expect((await queryOne('SELECT blocked_steam_ids FROM match_lobbies WHERE id = $1', [lobby.id])).blocked_steam_ids)
      .toEqual([p(0).steam_id])
    expect(sent.slice(0, 2)).toEqual([
      { type: 'kick_player', data: { lobbyId: String(lobby.id), steamId: p(0).steam_id, mode: 'kick' } },
      { type: 'set_lobby_blocklist', data: { lobbyId: String(lobby.id), steamIds: [p(0).steam_id] } },
    ])
    const ev = await events(lobby.id, 'admin_kick')
    expect(ev).toHaveLength(2)
    expect(ev[0].actor_id).toBe(admin.id)
    expect(ev[0].data).toEqual({})
  })

  it('kick_result is recorded; manual replays and auto repeats are de-duplicated', async () => {
    const res = { lobbyId: String(lobby.id), steamId: p(0).steam_id, mode: 'kick', ok: true, reason: '', auto: false }
    await botPool._onKickResult(res)
    await botPool._onKickResult(res) // replay: second admin_kick above is still "pending", so this one counts
    await botPool._onKickResult(res) // replay with nothing pending → dropped
    const auto = { ...res, auto: true }
    await botPool._onKickResult(auto)
    await botPool._onKickResult(auto)
    const ev = await events(lobby.id, 'kick_result')
    expect(ev.map(e => e.data)).toEqual([
      { mode: 'kick', ok: true, reason: '', auto: false },
      { mode: 'kick', ok: true, reason: '', auto: false },
      { mode: 'kick', ok: true, reason: '', auto: true },
    ])
  })

  it('kick_result goes through the Go message dispatcher', async () => {
    const spy = vi.spyOn(botPool, '_onKickResult').mockResolvedValue()
    await botPool._handleGoMessage({ type: 'kick_result', data: { lobbyId: '1' } })
    expect(spy).toHaveBeenCalledWith({ lobbyId: '1' })
    spy.mockRestore()
  })

  it('unblockPlayer removes the id, resends the list and records admin_unblock', async () => {
    fakeGo()
    const r = await botPool.unblockPlayer(lobby.id, p(0).steam_id, admin.id)
    expect(r).toEqual([])
    expect(sent).toEqual([{ type: 'set_lobby_blocklist', data: { lobbyId: String(lobby.id), steamIds: [] } }])
    const ev = await events(lobby.id, 'admin_unblock')
    expect(ev).toHaveLength(1)
    expect(ev[0].actor_id).toBe(admin.id)
    // Unblocking someone who isn't blocked is a quiet no-op.
    sent.length = 0
    await botPool.unblockPlayer(lobby.id, p(0).steam_id, admin.id)
    expect(await events(lobby.id, 'admin_unblock')).toHaveLength(1)
  })
})

describe('Go reconnect + payloads', () => {
  it('hello resends block lists for live lobbies only', async () => {
    fakeGo()
    const live = await seedLobby({ match: seed.match, botId: bot.id, status: 'waiting', gameNumber: 9 })
    const dead = await seedLobby({ match: seed.match, botId: bot.id, status: 'error', gameNumber: 10 })
    const empty = await seedLobby({ match: seed.match, botId: bot.id, status: 'waiting', gameNumber: 11 })
    await execute('UPDATE match_lobbies SET blocked_steam_ids = $1 WHERE id = ANY($2::int[])', [JSON.stringify([OUTSIDER]), [live.id, dead.id]])
    const sync = vi.spyOn(botPool, '_sendSync').mockResolvedValue()
    await botPool._handleGoMessage({ type: 'hello', data: { version: 'test' } })
    sync.mockRestore()
    const lists = sent.filter(m => m.type === 'set_lobby_blocklist').map(m => m.data.lobbyId)
    expect(lists).toContain(String(live.id))
    expect(lists).not.toContain(String(dead.id))
    expect(lists).not.toContain(String(empty.id))
    expect(sent.find(m => m.data.lobbyId === String(live.id)).data.steamIds).toEqual([OUTSIDER])
  })

  it('payload builders carry blockedSteamIds', () => {
    const lobby = { id: 1, bot_id: 2, game_name: 'g', password: 'p', blocked_steam_ids: [OUTSIDER] }
    expect(botPool._buildCompLobbyPayload(lobby, {}, {}, []).blockedSteamIds).toEqual([OUTSIDER])
    expect(botPool._buildGoLobbyPayload(lobby, {}, 'a', 'b', []).blockedSteamIds).toEqual([OUTSIDER])
    expect(botPool._buildGoLobbyPayload({ ...lobby, blocked_steam_ids: undefined }, {}, 'a', 'b', []).blockedSteamIds).toEqual([])
  })

  it('rejoin_lobby carries blockedSteamIds', async () => {
    fakeGo()
    const rb = await seedBot({ status: 'busy' })
    const l = await seedLobby({ match: seed.match, botId: rb.id, status: 'waiting', gameNumber: 12 })
    await execute('UPDATE match_lobbies SET blocked_steam_ids = $1 WHERE id = $2', [JSON.stringify([OUTSIDER]), l.id])
    await botPool._onBotStatus({ botId: String(rb.id), status: 'available' })
    const rejoin = sent.find(m => m.type === 'rejoin_lobby' && m.data.lobbyId === String(l.id))
    expect(rejoin.data.blockedSteamIds).toEqual([OUTSIDER])
    await execute('DELETE FROM match_lobbies WHERE id = $1', [l.id])
    await execute('DELETE FROM lobby_bots WHERE id = $1', [rb.id])
  })

  it('comp retry copies the block list and records created with the attempt', async () => {
    fakeGo()
    const rb = await seedBot({ status: 'available' })
    const errored = await seedLobby({ match: seed.match, botId: bot.id, status: 'error', gameNumber: 13 })
    await execute('UPDATE match_lobbies SET blocked_steam_ids = $1 WHERE id = $2', [JSON.stringify([OUTSIDER]), errored.id])
    const reloaded = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [errored.id])
    const claim = vi.spyOn(botPool, '_findAvailableBotId').mockResolvedValue(rb.id)
    expect(await botPool._retryCompLobby(reloaded)).toBe(true)
    claim.mockRestore()
    const create = sent.find(m => m.type === 'create_lobby')
    expect(create.data.blockedSteamIds).toEqual([OUTSIDER])
    const newRow = await queryOne('SELECT * FROM match_lobbies WHERE id = $1', [Number(create.data.lobbyId)])
    expect(newRow.blocked_steam_ids).toEqual([OUTSIDER])
    const created = await events(newRow.id, 'created')
    expect(created).toHaveLength(1)
    expect(created[0].data).toEqual({ gameName: 'test lobby', attempt: 2 })
    await execute('DELETE FROM match_lobbies WHERE id = $1', [newRow.id])
    await execute('DELETE FROM lobby_bots WHERE id = $1', [rb.id])
  })

  it('re-creating a game lobby archives old rows instead of deleting their history', async () => {
    fakeGo()
    const rb = await seedBot({ status: 'available' })
    const old = await seedLobby({ match: seed.match, botId: bot.id, status: 'error', gameNumber: 15 })
    await botPool._recordLobbyEvent(old.id, 'error', { data: { kind: 'timeout', message: 'x' } })
    const claim = vi.spyOn(botPool, '_findAvailableBotId').mockResolvedValue(rb.id)
    await botPool.createLobby(seed.comp.id, seed.match.id, 15)
    claim.mockRestore()

    const rows = await query('SELECT id, archived_at FROM match_lobbies WHERE match_id = $1 AND game_number = 15 ORDER BY id', [seed.match.id])
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe(old.id)
    expect(rows[0].archived_at).not.toBeNull()
    expect(rows[1].archived_at).toBeNull()
    expect(await events(old.id, 'error')).toHaveLength(1)
    await execute('DELETE FROM match_lobbies WHERE id = $1', [rows[1].id])
    await execute('DELETE FROM lobby_bots WHERE id = $1', [rb.id])
  })

  it('archived errored rows do not count toward the retry cap', async () => {
    fakeGo()
    const rb = await seedBot({ status: 'available' })
    for (let i = 0; i < 3; i++) {
      const l = await seedLobby({ match: seed.match, botId: bot.id, status: 'error', gameNumber: 16 })
      await execute('UPDATE match_lobbies SET archived_at = NOW() WHERE id = $1', [l.id])
    }
    const errored = await seedLobby({ match: seed.match, botId: bot.id, status: 'error', gameNumber: 16 })
    const claim = vi.spyOn(botPool, '_findAvailableBotId').mockResolvedValue(rb.id)
    expect(await botPool._retryCompLobby(errored)).toBe(true)
    claim.mockRestore()
    await execute("DELETE FROM match_lobbies WHERE match_id = $1 AND game_number = 16 AND status <> 'error'", [seed.match.id])
    await execute('DELETE FROM lobby_bots WHERE id = $1', [rb.id])
  })

  it('retention drops events older than 90 days', async () => {
    const l = await seedLobby({ match: seed.match, botId: bot.id, status: 'completed', gameNumber: 14 })
    await execute("INSERT INTO lobby_events (lobby_id, type, created_at) VALUES ($1, 'created', NOW() - INTERVAL '91 days'), ($1, 'cancelled', NOW())", [l.id])
    await botPool._cleanupZombieLobbies()
    expect((await events(l.id)).map(e => e.type)).toEqual(['cancelled'])
  })
})
