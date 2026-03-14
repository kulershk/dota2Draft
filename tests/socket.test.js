import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import {
  startServer, stopServer, cleanupDb,
  createTestPlayer, api, connectSocket, waitForEvent,
  execute,
} from './setup.js'

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

let ctx
let admin, cap1, cap2, player1, player2, player3
let compId

beforeAll(async () => {
  ctx = await startServer()
})

afterAll(async () => {
  await cleanupDb()
  await stopServer()
})

let sockets = []

function trackSocket(socket) {
  sockets.push(socket)
  return socket
}

afterEach(async () => {
  sockets.forEach(s => s.disconnect())
  sockets = []
  await delay(500) // let pending timers settle
})

async function setupDraft() {
  await cleanupDb()
  admin = await createTestPlayer('Admin', { isAdmin: true, mmr: 5000 })
  cap1 = await createTestPlayer('Captain1', { mmr: 6000, roles: ['Carry'] })
  cap2 = await createTestPlayer('Captain2', { mmr: 5500, roles: ['Mid'] })
  player1 = await createTestPlayer('Pool1', { mmr: 4000, roles: ['Pos4'] })
  player2 = await createTestPlayer('Pool2', { mmr: 3500, roles: ['Pos5'] })
  player3 = await createTestPlayer('Pool3', { mmr: 4500, roles: ['Offlane'] })

  const { data: comp } = await api('POST', '/api/competitions', admin.token, {
    name: 'Socket Test', settings: { requireAllOnline: false, bidTimer: 8, playersPerTeam: 2 },
  })
  compId = comp.id

  // Promote captains
  await api('POST', `/api/competitions/${compId}/captains/promote`, admin.token, { playerId: cap1.player.id, team: 'Team A' })
  await api('POST', `/api/competitions/${compId}/captains/promote`, admin.token, { playerId: cap2.player.id, team: 'Team B' })

  // Add players to pool
  await api('POST', `/api/competitions/${compId}/users/${player1.player.id}/add-to-pool`, admin.token)
  await api('POST', `/api/competitions/${compId}/users/${player2.player.id}/add-to-pool`, admin.token)
  await api('POST', `/api/competitions/${compId}/users/${player3.player.id}/add-to-pool`, admin.token)
}

// ─── Connection & Room Join ───────────────────────────
describe('Socket Connection', () => {
  beforeEach(async () => {
    await cleanupDb()
    admin = await createTestPlayer('Admin', { isAdmin: true })
    const { data: comp } = await api('POST', '/api/competitions', admin.token, { name: 'Socket Test' })
    compId = comp.id
  })

  it('connects and joins competition room', async () => {
    const socket = trackSocket(connectSocket(ctx.port, admin.token))
    await new Promise(r => socket.on('connect', r))

    socket.emit('competition:join', { competitionId: compId })
    const state = await waitForEvent(socket, 'auction:stateChanged')
    expect(state.status).toBe('idle')
    expect(state.settings).toBeDefined()
  })

  it('receives captains:online after join', async () => {
    const socket = trackSocket(connectSocket(ctx.port, admin.token))
    await new Promise(r => socket.on('connect', r))

    socket.emit('competition:join', { competitionId: compId })
    const online = await waitForEvent(socket, 'captains:online')
    expect(Array.isArray(online)).toBe(true)
  })

  it('receives auction:logHistory on join', async () => {
    const socket = trackSocket(connectSocket(ctx.port, admin.token))
    await new Promise(r => socket.on('connect', r))

    socket.emit('competition:join', { competitionId: compId })
    const logs = await waitForEvent(socket, 'auction:logHistory')
    expect(Array.isArray(logs)).toBe(true)
  })
})

// ─── Captain Ready ────────────────────────────────────
describe('Captain Ready', () => {
  beforeEach(setupDraft)

  it('captain:ready and captain:unready work', async () => {
    const socket = trackSocket(connectSocket(ctx.port, cap1.token))
    await new Promise(r => socket.on('connect', r))
    socket.emit('competition:join', { competitionId: compId })
    await waitForEvent(socket, 'auction:stateChanged')

    // Ready
    socket.emit('captain:ready')
    const readyList = await waitForEvent(socket, 'captains:ready')
    expect(readyList.length).toBeGreaterThanOrEqual(1)

    // Unready
    socket.emit('captain:unready')
    const unreadyList = await waitForEvent(socket, 'captains:ready')
    expect(unreadyList.length).toBe(0)
  })

  it('non-captain gets error on ready', async () => {
    const socket = trackSocket(connectSocket(ctx.port, player1.token))
    await new Promise(r => socket.on('connect', r))
    socket.emit('competition:join', { competitionId: compId })
    await waitForEvent(socket, 'auction:stateChanged')

    socket.emit('captain:ready')
    const err = await waitForEvent(socket, 'auction:error')
    expect(err.message).toContain('Not a captain')
  })
})

// ─── Auction Flow ─────────────────────────────────────
describe('Auction Flow', () => {
  beforeEach(setupDraft)

  it('admin starts draft', async () => {
    const socket = trackSocket(connectSocket(ctx.port, admin.token))
    await new Promise(r => socket.on('connect', r))
    socket.emit('competition:join', { competitionId: compId })
    await waitForEvent(socket, 'auction:stateChanged')

    socket.emit('auction:start')
    const state = await waitForEvent(socket, 'auction:stateChanged')
    expect(state.status).toBe('nominating')
    expect(state.currentRound).toBe(1)
    expect(state.nominator).toBeDefined()
  })

  it('non-admin cannot start draft', async () => {
    const socket = trackSocket(connectSocket(ctx.port, cap1.token))
    await new Promise(r => socket.on('connect', r))
    socket.emit('competition:join', { competitionId: compId })
    await waitForEvent(socket, 'auction:stateChanged')

    socket.emit('auction:start')
    const err = await waitForEvent(socket, 'auction:error')
    expect(err.message).toContain('Admin')
  })

  it('full auction: start → nominate → bid → sold', async () => {
    const adminSock = trackSocket(connectSocket(ctx.port, admin.token))
    const cap1Sock = trackSocket(connectSocket(ctx.port, cap1.token))
    const cap2Sock = trackSocket(connectSocket(ctx.port, cap2.token))

    // Connect all
    await Promise.all([
      new Promise(r => adminSock.on('connect', r)),
      new Promise(r => cap1Sock.on('connect', r)),
      new Promise(r => cap2Sock.on('connect', r)),
    ])

    // Join room
    adminSock.emit('competition:join', { competitionId: compId })
    cap1Sock.emit('competition:join', { competitionId: compId })
    cap2Sock.emit('competition:join', { competitionId: compId })

    await waitForEvent(adminSock, 'auction:stateChanged')
    await waitForEvent(cap1Sock, 'auction:stateChanged')
    await waitForEvent(cap2Sock, 'auction:stateChanged')

    // Start
    adminSock.emit('auction:start')
    const started = await waitForEvent(adminSock, 'auction:stateChanged', 5000, d => d.status === 'nominating')
    expect(started.status).toBe('nominating')

    // Get captains to find nominator
    const { data: captains } = await api('GET', `/api/competitions/${compId}/captains`)
    const nominatorCaptain = captains.find(c => c.id === started.nominator.id)
    const nominatorSock = nominatorCaptain.player_id === cap1.player.id ? cap1Sock : cap2Sock
    const otherSock = nominatorSock === cap1Sock ? cap2Sock : cap1Sock

    // Nominate
    nominatorSock.emit('auction:nominate', { playerId: player1.player.id })
    const nominated = await waitForEvent(adminSock, 'auction:stateChanged', 5000, d => d.status === 'bidding')
    expect(nominated.nominatedPlayer.id).toBe(player1.player.id)

    // Bid
    otherSock.emit('auction:bid', { amount: nominated.currentBid + 10 })
    const bidState = await waitForEvent(adminSock, 'auction:stateChanged', 5000, d => d.currentBid > nominated.currentBid)
    expect(bidState.currentBid).toBe(nominated.currentBid + 10)

    // Wait for timer to expire (bidTimer: 8s) — use fresh socket to avoid missed events
    const watchSock = trackSocket(connectSocket(ctx.port, admin.token))
    await new Promise(r => watchSock.on('connect', r))
    watchSock.emit('competition:join', { competitionId: compId })

    const sold = await waitForEvent(watchSock, 'auction:sold', 15000)
    expect(sold.playerName).toBeDefined()
    expect(sold.captainName).toBeDefined()
    expect(sold.amount).toBeGreaterThan(0)
  }, 15000)
})

// ─── Auction Admin Controls ───────────────────────────
describe('Auction Admin Controls', () => {
  beforeEach(setupDraft)

  it('pause and resume', async () => {
    const socket = trackSocket(connectSocket(ctx.port, admin.token))
    await new Promise(r => socket.on('connect', r))
    socket.emit('competition:join', { competitionId: compId })
    await waitForEvent(socket, 'auction:stateChanged')

    // Start
    socket.emit('auction:start')
    await waitForEvent(socket, 'auction:stateChanged')

    // Nominate (admin can nominate on behalf)
    const { data: state } = await api('GET', `/api/competitions/${compId}/auction`)
    socket.emit('auction:nominate', { playerId: player1.player.id })
    const nominated = await waitForEvent(socket, 'auction:stateChanged')
    expect(nominated.status).toBe('bidding')

    // Pause
    socket.emit('auction:pause')
    const paused = await waitForEvent(socket, 'auction:stateChanged')
    expect(paused.status).toBe('paused')

    // Resume
    socket.emit('auction:resume')
    const resumed = await waitForEvent(socket, 'auction:stateChanged')
    expect(resumed.status).toBe('bidding')
  })

  it('undo nomination', async () => {
    const socket = trackSocket(connectSocket(ctx.port, admin.token))
    await new Promise(r => socket.on('connect', r))
    socket.emit('competition:join', { competitionId: compId })
    await waitForEvent(socket, 'auction:stateChanged')

    socket.emit('auction:start')
    await waitForEvent(socket, 'auction:stateChanged')

    socket.emit('auction:nominate', { playerId: player1.player.id })
    await waitForEvent(socket, 'auction:stateChanged')

    socket.emit('auction:undo')
    const undone = await waitForEvent(socket, 'auction:stateChanged')
    expect(undone.status).toBe('nominating')
  })

  it('end draft', async () => {
    const socket = trackSocket(connectSocket(ctx.port, admin.token))
    await new Promise(r => socket.on('connect', r))
    socket.emit('competition:join', { competitionId: compId })
    await waitForEvent(socket, 'auction:stateChanged')

    socket.emit('auction:start')
    await waitForEvent(socket, 'auction:stateChanged')

    socket.emit('auction:end')
    const ended = await waitForEvent(socket, 'auction:stateChanged')
    expect(ended.status).toBe('finished')
  })

  it('reset draft', async () => {
    const socket = trackSocket(connectSocket(ctx.port, admin.token))
    await new Promise(r => socket.on('connect', r))
    socket.emit('competition:join', { competitionId: compId })
    await waitForEvent(socket, 'auction:stateChanged')

    socket.emit('auction:start')
    await waitForEvent(socket, 'auction:stateChanged')

    socket.emit('auction:reset')
    const reset = await waitForEvent(socket, 'auction:stateChanged')
    expect(reset.status).toBe('idle')
    expect(reset.currentRound).toBe(0)
  })
})

// ─── Blind Bidding ────────────────────────────────────
describe('Blind Bidding', () => {
  beforeEach(async () => {
    await cleanupDb()
    admin = await createTestPlayer('Admin', { isAdmin: true, mmr: 5000 })
    cap1 = await createTestPlayer('Captain1', { mmr: 6000 })
    cap2 = await createTestPlayer('Captain2', { mmr: 5500 })
    player1 = await createTestPlayer('Pool1', { mmr: 4000 })
    player2 = await createTestPlayer('Pool2', { mmr: 3500 })

    const { data: comp } = await api('POST', '/api/competitions', admin.token, {
      name: 'Blind Test',
      settings: { requireAllOnline: false, bidTimer: 8, playersPerTeam: 1, biddingType: 'blind', blindTopBidders: 2 },
    })
    compId = comp.id

    await api('POST', `/api/competitions/${compId}/captains/promote`, admin.token, { playerId: cap1.player.id, team: 'Team A' })
    await api('POST', `/api/competitions/${compId}/captains/promote`, admin.token, { playerId: cap2.player.id, team: 'Team B' })
    await api('POST', `/api/competitions/${compId}/users/${player1.player.id}/add-to-pool`, admin.token)
    await api('POST', `/api/competitions/${compId}/users/${player2.player.id}/add-to-pool`, admin.token)
  })

  it('nomination enters blind phase', async () => {
    const adminSock = trackSocket(connectSocket(ctx.port, admin.token))
    await new Promise(r => adminSock.on('connect', r))
    adminSock.emit('competition:join', { competitionId: compId })
    await waitForEvent(adminSock, 'auction:stateChanged')

    adminSock.emit('auction:start')
    await waitForEvent(adminSock, 'auction:stateChanged')

    adminSock.emit('auction:nominate', { playerId: player1.player.id })
    const state = await waitForEvent(adminSock, 'auction:stateChanged')
    expect(state.status).toBe('bidding')
    expect(state.blindPhase).toBe(true)
    expect(state.blindBidCount).toBe(0)
  })

  it('captains can submit blind bids and phase resolves', async () => {
    const adminSock = trackSocket(connectSocket(ctx.port, admin.token))
    const cap1Sock = trackSocket(connectSocket(ctx.port, cap1.token))
    const cap2Sock = trackSocket(connectSocket(ctx.port, cap2.token))

    await Promise.all([
      new Promise(r => adminSock.on('connect', r)),
      new Promise(r => cap1Sock.on('connect', r)),
      new Promise(r => cap2Sock.on('connect', r)),
    ])

    adminSock.emit('competition:join', { competitionId: compId })
    cap1Sock.emit('competition:join', { competitionId: compId })
    cap2Sock.emit('competition:join', { competitionId: compId })

    await waitForEvent(adminSock, 'auction:stateChanged')
    await waitForEvent(cap1Sock, 'auction:stateChanged')
    await waitForEvent(cap2Sock, 'auction:stateChanged')

    // Start and wait
    adminSock.emit('auction:start')
    await waitForEvent(adminSock, 'auction:stateChanged')
    await delay(200)

    // Nominate
    adminSock.emit('auction:nominate', { playerId: player1.player.id })
    await waitForEvent(adminSock, 'auction:stateChanged')
    await delay(200)

    // Submit blind bids
    cap1Sock.emit('auction:blind-bid', { amount: 200 })
    const confirmed1 = await waitForEvent(cap1Sock, 'auction:blind-bid-confirmed')
    expect(confirmed1.amount).toBe(200)

    cap2Sock.emit('auction:blind-bid', { amount: 150 })
    const confirmed2 = await waitForEvent(cap2Sock, 'auction:blind-bid-confirmed')
    expect(confirmed2.amount).toBe(150)

    // Normal bid should be rejected during blind phase
    cap1Sock.emit('auction:bid', { amount: 300 })
    const err = await waitForEvent(cap1Sock, 'auction:error')
    expect(err.message).toContain('blind')

    // Wait for blind phase to resolve (bidTimer: 8s)
    // Use a fresh socket to avoid missed events
    const watchSock = trackSocket(connectSocket(ctx.port, admin.token))
    await new Promise(r => watchSock.on('connect', r))
    watchSock.emit('competition:join', { competitionId: compId })

    // The join will get current state — if blind already resolved, we get it immediately
    // Otherwise we wait for the next stateChanged
    const finalState = await waitForEvent(watchSock, 'auction:stateChanged', 15000, d => Array.isArray(d.revealedBids) && d.revealedBids.length > 0)
    expect(finalState.revealedBids.length).toBe(2)
    expect(finalState.revealedBids[0].amount).toBeGreaterThanOrEqual(finalState.revealedBids[1].amount)
  }, 20000)
})
