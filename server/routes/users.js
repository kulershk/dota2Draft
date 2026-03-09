import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { createSession } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'

const router = Router()

router.get('/api/users', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_users')
  if (!admin) return

  const rows = await query('SELECT * FROM players ORDER BY id')
  const groupMemberships = await query(`
    SELECT ppg.player_id, pg.id AS group_id, pg.name AS group_name
    FROM player_permission_groups ppg
    JOIN permission_groups pg ON pg.id = ppg.group_id
    ORDER BY pg.name
  `)
  const groupsByPlayer = {}
  for (const m of groupMemberships) {
    if (!groupsByPlayer[m.player_id]) groupsByPlayer[m.player_id] = []
    groupsByPlayer[m.player_id].push({ id: m.group_id, name: m.group_name })
  }
  res.json(rows.map(p => ({
    id: p.id,
    name: p.name,
    steam_id: p.steam_id || null,
    avatar_url: p.avatar_url || null,
    roles: JSON.parse(p.roles || '[]'),
    mmr: p.mmr,
    info: p.info || '',
    is_admin: !!p.is_admin,
    is_banned: !!p.is_banned,
    twitch_username: p.twitch_username || null,
    created_at: p.created_at,
    permission_groups: groupsByPlayer[p.id] || [],
  })))
})

router.put('/api/players/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_users')
  if (!admin) return

  const player = await queryOne('SELECT * FROM players WHERE id = $1', [req.params.id])
  if (!player) return res.status(404).json({ error: 'Player not found' })
  const { name, roles, mmr, info, is_admin, is_banned } = req.body
  await execute(
    'UPDATE players SET name = $1, roles = $2, mmr = $3, info = $4, is_admin = $5, is_banned = $6 WHERE id = $7',
    [
      name ?? player.name,
      roles ? JSON.stringify(roles) : player.roles,
      mmr ?? player.mmr,
      info ?? player.info,
      is_admin !== undefined ? is_admin : player.is_admin,
      is_banned !== undefined ? is_banned : !!player.is_banned,
      req.params.id,
    ]
  )
  res.json({ ok: true })
})

router.post('/api/admin/impersonate/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_users')
  if (!admin) return
  if (!admin.is_admin) return res.status(403).json({ error: 'Only root admins can impersonate' })
  const target = await queryOne('SELECT * FROM players WHERE id = $1', [req.params.id])
  if (!target) return res.status(404).json({ error: 'User not found' })
  const token = createSession(target.id)
  res.json({ token })
})

router.post('/api/admin/generate-test-users', async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'Not available in production' })
  const admin = await requirePermission(req, res, 'manage_users')
  if (!admin) return

  const { count = 5 } = req.body
  const num = Math.min(Math.max(1, Number(count)), 50)

  const DOTA_HEROES = [
    'Anti-Mage', 'Axe', 'Crystal Maiden', 'Drow Ranger', 'Earthshaker',
    'Juggernaut', 'Mirana', 'Morphling', 'Phantom Assassin', 'Pudge',
    'Shadow Fiend', 'Sniper', 'Storm Spirit', 'Sven', 'Tiny',
    'Vengeful Spirit', 'Windranger', 'Zeus', 'Invoker', 'Rubick',
    'Lina', 'Lion', 'Witch Doctor', 'Tidehunter', 'Sand King',
    'Ogre Magi', 'Techies', 'Io', 'Phoenix', 'Tusk',
    'Bristleback', 'Slark', 'Ember Spirit', 'Earth Spirit', 'Oracle',
    'Monkey King', 'Pangolier', 'Dark Willow', 'Grimstroke', 'Snapfire',
    'Void Spirit', 'Hoodwink', 'Dawnbreaker', 'Marci', 'Primal Beast',
    'Muerta', 'Ringmaster', 'Kez', 'Luna', 'Ursa'
  ]

  const ADJECTIVES = [
    'Swift', 'Dark', 'Silent', 'Mighty', 'Ancient', 'Frozen', 'Blazing',
    'Shadow', 'Iron', 'Storm', 'Toxic', 'Divine', 'Cursed', 'Noble', 'Wild',
    'Brutal', 'Arcane', 'Mystic', 'Radiant', 'Dire', 'Immortal', 'Ethereal'
  ]

  const created = []
  for (let i = 0; i < num; i++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
    const hero = DOTA_HEROES[Math.floor(Math.random() * DOTA_HEROES.length)]
    const suffix = Math.floor(Math.random() * 9999)
    const name = `${adj} ${hero} ${suffix}`
    const fakeSteamId = `7656${Date.now()}${Math.floor(Math.random() * 10000)}`
    const avatarHash = Math.random().toString(36).substring(2, 10)
    const avatarUrl = `https://api.dicebear.com/7.x/identicon/svg?seed=${avatarHash}`
    const mmr = Math.floor(Math.random() * 8000) + 1000

    const p = await queryOne(
      'INSERT INTO players (name, steam_id, avatar_url, roles, mmr, info) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name',
      [name, fakeSteamId, avatarUrl, '["core","support"]', mmr, `Test user - MMR ${mmr}`]
    )
    created.push(p)
  }
  res.json({ created: created.length, users: created })
})

export default router
