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
    last_online: p.last_online || null,
    permission_groups: groupsByPlayer[p.id] || [],
  })))
})

// Public player profile
router.get('/api/players/:id/profile', async (req, res) => {
  const playerId = Number(req.params.id)
  const player = await queryOne('SELECT id, name, steam_id, avatar_url, roles, mmr, info, twitch_username, discord_username, created_at FROM players WHERE id = $1', [playerId])
  if (!player) return res.status(404).json({ error: 'Player not found' })

  // Get all competitions this player participated in (as player or captain)
  const participations = await query(`
    SELECT
      c.id AS competition_id, c.name AS competition_name, c.status AS competition_status,
      cp.roles, cp.mmr AS comp_mmr, cp.drafted, cp.draft_price, cp.draft_round,
      cap.id AS captain_id, cap.team AS captain_team,
      drafted_cap.team AS drafted_by_team, drafted_cap.name AS drafted_by_name
    FROM competition_players cp
    JOIN competitions c ON c.id = cp.competition_id
    LEFT JOIN captains cap ON cap.player_id = $1 AND cap.competition_id = c.id
    LEFT JOIN captains drafted_cap ON drafted_cap.id = cp.drafted_by
    WHERE cp.player_id = $1
    ORDER BY c.created_at DESC
  `, [playerId])

  // Get tournament placements for competitions where player was a captain
  const captainIds = participations.filter(p => p.captain_id).map(p => p.captain_id)
  let placements = []
  if (captainIds.length > 0) {
    // For each captain entry, find their best tournament result
    placements = await query(`
      SELECT
        cap.id AS captain_id, cap.competition_id, c.name AS competition_name,
        cap.team,
        ts.tournament_state
      FROM captains cap
      JOIN competitions c ON c.id = cap.competition_id
      LEFT JOIN LATERAL (
        SELECT c2.tournament_state FROM competitions c2 WHERE c2.id = cap.competition_id
      ) ts ON true
      WHERE cap.id = ANY($1::int[])
    `, [captainIds])
  }

  // Compute placement from tournament_state for each captain
  const tournamentResults = []
  for (const p of placements) {
    const ts = p.tournament_state || {}
    if (!ts.stages || ts.stages.length === 0) continue

    // Check matches to determine placement
    const matches = await query(`
      SELECT * FROM matches
      WHERE competition_id = $1
      ORDER BY stage, round DESC, match_order
    `, [p.competition_id])

    // Find finals matches where this captain participated
    for (const stage of ts.stages) {
      const stageMatches = matches.filter(m => m.stage === stage.id)
      if (stageMatches.length === 0) continue

      // Check if captain won the tournament (won the final match)
      const finalMatch = stageMatches.find(m =>
        !m.next_match_id && m.winner_captain_id && (m.bracket !== 'lower')
      )

      let placement = null
      if (finalMatch) {
        if (finalMatch.winner_captain_id === p.captain_id) {
          placement = 1
        } else if (finalMatch.team1_captain_id === p.captain_id || finalMatch.team2_captain_id === p.captain_id) {
          placement = 2
        }
      }

      // Check for 3rd place (lost in semi-finals for single elim)
      if (!placement) {
        const participated = stageMatches.some(m =>
          m.team1_captain_id === p.captain_id || m.team2_captain_id === p.captain_id
        )
        if (participated) {
          // Count how far they got (highest round reached)
          const maxRound = Math.max(...stageMatches
            .filter(m => m.team1_captain_id === p.captain_id || m.team2_captain_id === p.captain_id)
            .filter(m => m.bracket !== 'lower' && m.bracket !== 'grand_finals')
            .map(m => m.round)
            .filter(r => r < 100), 0)

          if (stage.format === 'single_elimination' && stage.totalRounds) {
            if (maxRound === stage.totalRounds) placement = 2
            else if (maxRound === stage.totalRounds - 1) placement = 3
          }
        }
      }

      if (placement) {
        tournamentResults.push({
          competition_id: p.competition_id,
          competition_name: p.competition_name,
          team: p.team,
          stage_name: stage.name,
          format: stage.format,
          placement,
        })
      }
    }
  }

  res.json({
    id: player.id,
    name: player.name,
    steam_id: player.steam_id || null,
    avatar_url: player.avatar_url || null,
    roles: JSON.parse(player.roles || '[]'),
    mmr: player.mmr,
    info: player.info || '',
    twitch_username: player.twitch_username || null,
    discord_username: player.discord_username || null,
    created_at: player.created_at,
    competitions: participations.map(p => ({
      competition_id: p.competition_id,
      competition_name: p.competition_name,
      competition_status: p.competition_status,
      roles: JSON.parse(p.roles || '[]'),
      mmr: p.comp_mmr,
      was_captain: !!p.captain_id,
      captain_team: p.captain_team || null,
      drafted: !!p.drafted,
      draft_price: p.draft_price || null,
      draft_round: p.draft_round || null,
      drafted_by_team: p.drafted_by_team || null,
      drafted_by_name: p.drafted_by_name || null,
    })),
    tournament_results: tournamentResults,
  })
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
