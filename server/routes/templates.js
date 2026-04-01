import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { hasPermission, requireCompPermission } from '../middleware/permissions.js'
import { getCompetition, parseCompSettings } from '../helpers/competition.js'

const router = Router()

// List all templates
router.get('/api/competition-templates', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })

  const canManageAll = await hasPermission(player, 'manage_competitions')
  let templates
  if (canManageAll || player.is_admin) {
    templates = await query('SELECT * FROM competition_templates ORDER BY created_at DESC')
  } else {
    templates = await query('SELECT * FROM competition_templates WHERE created_by = $1 ORDER BY created_at DESC', [player.id])
  }
  res.json(templates)
})

// Create template from an existing competition
router.post('/api/competition-templates/from-competition/:compId', async (req, res) => {
  const compId = Number(req.params.compId)
  const admin = await requireCompPermission(req, res, compId)
  if (!admin) return

  const { name, description } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })

  const comp = await getCompetition(compId)
  if (!comp) return res.status(404).json({ error: 'Competition not found' })

  // Extract only game-config settings (normalized through parseCompSettings)
  const settings = parseCompSettings(comp)

  const template = await queryOne(
    `INSERT INTO competition_templates (name, description, settings, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, description || '', JSON.stringify(settings), admin.id]
  )
  res.status(201).json(template)
})

// Delete a template
router.delete('/api/competition-templates/:id', async (req, res) => {
  const player = await getAuthPlayer(req)
  if (!player) return res.status(401).json({ error: 'Not authenticated' })

  const template = await queryOne('SELECT * FROM competition_templates WHERE id = $1', [req.params.id])
  if (!template) return res.status(404).json({ error: 'Template not found' })

  const canManageAll = await hasPermission(player, 'manage_competitions')
  if (!canManageAll && !player.is_admin && template.created_by !== player.id) {
    return res.status(403).json({ error: 'Not authorized' })
  }

  await execute('DELETE FROM competition_templates WHERE id = $1', [req.params.id])
  res.json({ ok: true })
})

export default router
