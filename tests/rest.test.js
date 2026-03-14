import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  startServer, stopServer, cleanupDb,
  createTestPlayer, createTestCompetition, api,
} from './setup.js'

let baseCtx
let admin, user1, user2

beforeAll(async () => {
  baseCtx = await startServer()
})

afterAll(async () => {
  await cleanupDb()
  await stopServer()
})

beforeEach(async () => {
  await cleanupDb()
  admin = await createTestPlayer('Admin', { isAdmin: true })
  user1 = await createTestPlayer('Player1', { mmr: 5000, roles: ['Carry', 'Mid'] })
  user2 = await createTestPlayer('Player2', { mmr: 4000, roles: ['Pos4', 'Pos5'] })
})

// ─── Auth ─────────────────────────────────────────────
describe('Auth', () => {
  it('GET /api/auth/me returns current user', async () => {
    const { status, data } = await api('GET', '/api/auth/me', admin.token)
    expect(status).toBeLessThan(300)
    expect(data.name).toBe('Admin')
    expect(data.is_admin).toBe(true)
    expect(data.permissions).toBeDefined()
  })

  it('GET /api/auth/me without token returns 401', async () => {
    const { status } = await api('GET', '/api/auth/me')
    expect(status).toBe(401)
  })

  it('PUT /api/auth/me updates profile', async () => {
    const { status, data } = await api('PUT', '/api/auth/me', user1.token, { mmr: 6000, info: 'test info' })
    expect(status).toBeLessThan(300)
    expect(data.mmr).toBe(6000)
    expect(data.info).toBe('test info')
  })
})

// ─── Competitions ─────────────────────────────────────
describe('Competitions', () => {
  it('POST /api/competitions creates competition', async () => {
    const { status, data } = await api('POST', '/api/competitions', admin.token, {
      name: 'Season 1',
      settings: { playersPerTeam: 4, bidTimer: 15 },
    })
    expect(status).toBeLessThan(300)
    expect(data.name).toBe('Season 1')
    expect(data.id).toBeDefined()
  })

  it('GET /api/competitions lists competitions', async () => {
    await api('POST', '/api/competitions', admin.token, { name: 'Comp A' })
    await api('POST', '/api/competitions', admin.token, { name: 'Comp B' })
    const { status, data } = await api('GET', '/api/competitions', admin.token)
    expect(status).toBeLessThan(300)
    expect(data.length).toBeGreaterThanOrEqual(2)
  })

  it('PUT /api/competitions/:id updates competition', async () => {
    const { data: comp } = await api('POST', '/api/competitions', admin.token, { name: 'Old Name' })
    const { status, data } = await api('PUT', `/api/competitions/${comp.id}`, admin.token, { name: 'New Name' })
    expect(status).toBeLessThan(300)
    expect(data.name).toBe('New Name')
  })

  it('DELETE /api/competitions/:id deletes competition', async () => {
    const { data: comp } = await api('POST', '/api/competitions', admin.token, { name: 'Delete Me' })
    const { status } = await api('DELETE', `/api/competitions/${comp.id}`, admin.token)
    expect(status).toBeLessThan(300)
  })

  it('non-admin cannot create competition', async () => {
    const { status } = await api('POST', '/api/competitions', user1.token, { name: 'Nope' })
    expect(status).toBe(403)
  })
})

// ─── Players ──────────────────────────────────────────
describe('Players', () => {
  let compId

  beforeEach(async () => {
    const { data: comp } = await api('POST', '/api/competitions', admin.token, { name: 'Player Test Comp' })
    compId = comp.id
  })

  it('POST register adds player to pool', async () => {
    const { status } = await api('POST', `/api/competitions/${compId}/players/register`, user1.token, {
      roles: ['Carry'], mmr: 5500, info: 'hello',
    })
    expect(status).toBeLessThan(300)

    const { data: players } = await api('GET', `/api/competitions/${compId}/players`)
    const me = players.find(p => p.id === user1.player.id)
    expect(me).toBeDefined()
    expect(me.mmr).toBe(5500)
    expect(me.in_pool).toBe(true)
  })

  it('admin add-to-pool works', async () => {
    const { status } = await api('POST', `/api/competitions/${compId}/users/${user2.player.id}/add-to-pool`, admin.token)
    expect(status).toBeLessThan(300)

    const { data: players } = await api('GET', `/api/competitions/${compId}/players`)
    const added = players.find(p => p.id === user2.player.id)
    expect(added).toBeDefined()
    expect(added.in_pool).toBe(true)
  })

  it('admin remove-from-pool works', async () => {
    await api('POST', `/api/competitions/${compId}/users/${user1.player.id}/add-to-pool`, admin.token)
    const { status } = await api('POST', `/api/competitions/${compId}/users/${user1.player.id}/remove-from-pool`, admin.token)
    expect(status).toBeLessThan(300)
  })

  it('GET /api/competitions/:compId/me returns comp user data', async () => {
    await api('POST', `/api/competitions/${compId}/players/register`, user1.token, { roles: ['Mid'], mmr: 5000 })
    const { status, data } = await api('GET', `/api/competitions/${compId}/me`, user1.token)
    expect(status).toBeLessThan(300)
    expect(data.in_pool).toBe(true)
    expect(data.mmr).toBe(5000)
  })
})

// ─── Captains ─────────────────────────────────────────
describe('Captains', () => {
  let compId

  beforeEach(async () => {
    const { data: comp } = await api('POST', '/api/competitions', admin.token, { name: 'Captain Test' })
    compId = comp.id
  })

  it('promote and list captains', async () => {
    const { status } = await api('POST', `/api/competitions/${compId}/captains/promote`, admin.token, {
      playerId: user1.player.id, team: 'Team Alpha',
    })
    expect(status).toBeLessThan(300)

    const { data: captains } = await api('GET', `/api/competitions/${compId}/captains`)
    expect(captains.length).toBe(1)
    expect(captains[0].team).toBe('Team Alpha')
    expect(captains[0].player_id).toBe(user1.player.id)
  })

  it('update captain budget and team', async () => {
    await api('POST', `/api/competitions/${compId}/captains/promote`, admin.token, {
      playerId: user1.player.id, team: 'Old Team',
    })
    const { data: captains } = await api('GET', `/api/competitions/${compId}/captains`)
    const capId = captains[0].id

    const { status } = await api('PUT', `/api/competitions/${compId}/captains/${capId}`, admin.token, {
      team: 'New Team', budget: 2000,
    })
    expect(status).toBeLessThan(300)

    const { data: updated } = await api('GET', `/api/competitions/${compId}/captains`)
    expect(updated[0].team).toBe('New Team')
    expect(updated[0].budget).toBe(2000)
  })

  it('demote captain', async () => {
    await api('POST', `/api/competitions/${compId}/captains/promote`, admin.token, {
      playerId: user1.player.id, team: 'Temp Team',
    })
    const { data: captains } = await api('GET', `/api/competitions/${compId}/captains`)
    const { status } = await api('POST', `/api/competitions/${compId}/captains/${captains[0].id}/demote`, admin.token)
    expect(status).toBeLessThan(300)

    const { data: after } = await api('GET', `/api/competitions/${compId}/captains`)
    expect(after.length).toBe(0)
  })
})

// ─── Auction ──────────────────────────────────────────
describe('Auction', () => {
  let compId

  beforeEach(async () => {
    const { data: comp } = await api('POST', '/api/competitions', admin.token, { name: 'Auction Test' })
    compId = comp.id
  })

  it('GET /api/competitions/:compId/auction returns state', async () => {
    const { status, data } = await api('GET', `/api/competitions/${compId}/auction`)
    expect(status).toBeLessThan(300)
    expect(data.status).toBe('idle')
    expect(data.settings).toBeDefined()
  })

  it('GET /api/competitions/:compId/auction/results returns empty results', async () => {
    const { status, data } = await api('GET', `/api/competitions/${compId}/auction/results`)
    expect(status).toBeLessThan(300)
    expect(Array.isArray(data)).toBe(true)
  })
})

// ─── Users (admin) ────────────────────────────────────
describe('Users', () => {
  it('GET /api/users lists all users (admin)', async () => {
    const { status, data } = await api('GET', '/api/users', admin.token)
    expect(status).toBeLessThan(300)
    expect(data.length).toBeGreaterThanOrEqual(3)
  })

  it('GET /api/users denied for non-admin', async () => {
    const { status } = await api('GET', '/api/users', user1.token)
    expect(status).toBe(403)
  })

  it('PUT /api/players/:id updates user (admin)', async () => {
    const { status } = await api('PUT', `/api/players/${user1.player.id}`, admin.token, {
      mmr: 9000, roles: ['Carry', 'Offlane'],
    })
    expect(status).toBeLessThan(300)
  })

  it('GET /api/players/:id/profile returns public profile', async () => {
    const { status, data } = await api('GET', `/api/players/${user1.player.id}/profile`)
    expect(status).toBeLessThan(300)
    expect(data.name).toBe('Player1')
    expect(data.competitions).toBeDefined()
  })
})

// ─── Permissions ──────────────────────────────────────
describe('Permissions', () => {
  it('CRUD permission groups', async () => {
    // Create
    const { status: cs, data: created } = await api('POST', '/api/permission-groups', admin.token, {
      name: 'Moderators', permissions: ['manage_news', 'manage_players'],
    })
    expect(cs).toBeLessThan(300)
    expect(created.id).toBeDefined()

    // List
    const { data: groups } = await api('GET', '/api/permission-groups', admin.token)
    expect(groups.length).toBeGreaterThanOrEqual(1)

    // Update
    const { status: us } = await api('PUT', `/api/permission-groups/${created.id}`, admin.token, {
      name: 'Super Mods', permissions: ['manage_news'],
    })
    expect(us).toBeLessThan(300)

    // Assign to player
    const { status: as } = await api('PUT', `/api/players/${user1.player.id}/groups`, admin.token, {
      groupIds: [created.id],
    })
    expect(as).toBeLessThan(300)

    // Check player groups
    const { data: playerGroups } = await api('GET', `/api/players/${user1.player.id}/groups`, admin.token)
    expect(playerGroups.length).toBe(1)

    // Delete
    const { status: ds } = await api('DELETE', `/api/permission-groups/${created.id}`, admin.token)
    expect(ds).toBeLessThan(300)
  })

  it('GET /api/permissions/all lists all permissions', async () => {
    const { status, data } = await api('GET', '/api/permissions/all')
    expect(status).toBeLessThan(300)
    expect(data).toContain('manage_users')
    expect(data).toContain('manage_auction')
  })
})

// ─── News ─────────────────────────────────────────────
describe('News', () => {
  it('CRUD news posts', async () => {
    // Create
    const { status: cs, data: post } = await api('POST', '/api/news', admin.token, {
      title: 'Season Starts', content: 'Get ready!',
    })
    expect(cs).toBeLessThan(300)
    expect(post.id).toBeDefined()

    // List
    const { data: news } = await api('GET', '/api/news')
    expect(news.length).toBeGreaterThanOrEqual(1)

    // Update
    const { status: us } = await api('PUT', `/api/news/${post.id}`, admin.token, { title: 'Updated Title' })
    expect(us).toBeLessThan(300)

    // Comment
    const { status: commentStatus } = await api('POST', `/api/news/${post.id}/comments`, user1.token, { content: 'Hype!' })
    expect(commentStatus).toBeLessThan(300)

    // List comments
    const { data: comments } = await api('GET', `/api/news/${post.id}/comments`)
    expect(comments.length).toBe(1)

    // Delete
    const { status: ds } = await api('DELETE', `/api/news/${post.id}`, admin.token)
    expect(ds).toBeLessThan(300)
  })
})

// ─── Settings ─────────────────────────────────────────
describe('Site Settings', () => {
  it('GET /api/site-settings returns settings', async () => {
    const { status, data } = await api('GET', '/api/site-settings')
    expect(status).toBeLessThan(300)
    expect(data).toBeDefined()
  })

  it('PUT /api/site-settings updates (admin)', async () => {
    const { status } = await api('PUT', '/api/site-settings', admin.token, {
      site_title: 'Test Draft',
    })
    expect(status).toBeLessThan(300)
  })
})
