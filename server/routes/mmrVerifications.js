import { Router } from 'express'
import fs from 'fs'
import { join } from 'path'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { upload, uploadsDir } from '../middleware/upload.js'

const MIN_MMR = 0
const MAX_MMR = 13000

export default function createMmrVerificationsRouter(io) {
  const router = Router()

  // ── User: submit a new MMR verification ──
  router.post('/api/mmr-verifications', upload.single('screenshot'), async (req, res) => {
    try {
      const player = await getAuthPlayer(req)
      if (!player) {
        if (req.file) try { fs.unlinkSync(req.file.path) } catch {}
        return res.status(401).json({ error: 'Not authenticated' })
      }
      if (player.is_banned) {
        if (req.file) try { fs.unlinkSync(req.file.path) } catch {}
        return res.status(403).json({ error: 'Your account has been banned' })
      }
      if (!req.file) return res.status(400).json({ error: 'Screenshot is required' })

      const submitted = Number(req.body.mmr)
      if (!Number.isFinite(submitted) || submitted < MIN_MMR || submitted > MAX_MMR) {
        try { fs.unlinkSync(req.file.path) } catch {}
        return res.status(400).json({ error: 'MMR must be between 0 and 13000' })
      }

      // One active pending per player. If there's already one, auto-cancel
      // it (preserve the row + screenshot so the admin trail is complete).
      await execute(
        `UPDATE mmr_verifications
            SET status = 'cancelled', reviewed_at = NOW(), review_note = COALESCE(review_note, 'Auto-cancelled when player submitted a new request')
          WHERE player_id = $1 AND status = 'pending'`,
        [player.id]
      )

      const screenshotUrl = `/uploads/${req.file.filename}`
      const created = await queryOne(`
        INSERT INTO mmr_verifications (player_id, submitted_mmr, screenshot_url)
        VALUES ($1, $2, $3) RETURNING *
      `, [player.id, Math.round(submitted), screenshotUrl])

      if (io) io.emit('mmrVerification:new', { id: created.id, playerId: player.id })
      res.status(201).json(created)
    } catch (e) {
      if (req.file) try { fs.unlinkSync(req.file.path) } catch {}
      res.status(500).json({ error: e.message })
    }
  })

  // ── User: list my own submissions ──
  router.get('/api/mmr-verifications/mine', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    try {
      const rows = await query(`
        SELECT v.*, COALESCE(rp.display_name, rp.name) AS reviewed_by_name
        FROM mmr_verifications v
        LEFT JOIN players rp ON rp.id = v.reviewed_by
        WHERE v.player_id = $1
        ORDER BY v.submitted_at DESC
        LIMIT 25
      `, [player.id])
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── User: cancel my own pending submission ──
  // Row stays in the DB and the screenshot stays on disk so the admin still
  // sees it in the player's history with status = 'cancelled'.
  router.post('/api/mmr-verifications/:id/cancel', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    try {
      const v = await queryOne('SELECT * FROM mmr_verifications WHERE id = $1', [req.params.id])
      if (!v) return res.status(404).json({ error: 'Submission not found' })
      if (v.player_id !== player.id) return res.status(403).json({ error: 'Not your submission' })
      if (v.status !== 'pending') return res.status(409).json({ error: 'Submission is not pending' })
      await execute(`
        UPDATE mmr_verifications
          SET status = 'cancelled', reviewed_at = NOW(), review_note = COALESCE($1, 'Cancelled by player')
        WHERE id = $2
      `, [req.body?.note || null, v.id])
      if (io) io.emit('mmrVerification:reviewed', { id: v.id, playerId: player.id, status: 'cancelled' })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: list submissions ──
  router.get('/api/admin/mmr-verifications', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_mmr_verifications')
    if (!admin) return
    try {
      const status = (req.query.status || 'pending').toString()
      const allowedStatuses = ['pending', 'approved', 'rejected', 'cancelled', 'all']
      if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' })
      const playerId = req.query.playerId ? Number(req.query.playerId) : null
      const params = []
      const conds = []
      if (status !== 'all') { params.push(status); conds.push(`v.status = $${params.length}`) }
      if (playerId)         { params.push(playerId); conds.push(`v.player_id = $${params.length}`) }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
      const limit = Math.min(Number(req.query.limit) || 100, 200)
      params.push(limit)
      const rows = await query(`
        SELECT v.*,
          p.name AS player_name, COALESCE(p.display_name, p.name) AS player_display_name,
          p.avatar_url AS player_avatar, p.mmr AS player_current_mmr,
          COALESCE(rp.display_name, rp.name) AS reviewed_by_name
        FROM mmr_verifications v
        JOIN players p ON p.id = v.player_id
        LEFT JOIN players rp ON rp.id = v.reviewed_by
        ${where}
        ORDER BY
          CASE WHEN v.status = 'pending' THEN 0 ELSE 1 END,
          v.submitted_at DESC
        LIMIT $${params.length}
      `, params)
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: approve — sets players.mmr to the submitted value ──
  router.post('/api/admin/mmr-verifications/:id/approve', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_mmr_verifications')
    if (!admin) return
    try {
      const v = await queryOne('SELECT * FROM mmr_verifications WHERE id = $1', [req.params.id])
      if (!v) return res.status(404).json({ error: 'Submission not found' })
      if (v.status !== 'pending') return res.status(409).json({ error: 'Already reviewed' })
      await execute(`
        UPDATE mmr_verifications
        SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), review_note = $2
        WHERE id = $3
      `, [admin.id, req.body.note || null, v.id])
      // Apply the new MMR and stamp the verified-at marker on first approval.
      await execute(
        'UPDATE players SET mmr = $1, mmr_verified_at = COALESCE(mmr_verified_at, NOW()) WHERE id = $2',
        [v.submitted_mmr, v.player_id]
      )
      if (io) io.emit('mmrVerification:reviewed', { id: v.id, playerId: v.player_id, status: 'approved', mmr: v.submitted_mmr })
      res.json({ ok: true, player_id: v.player_id, mmr: v.submitted_mmr })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: reject ──
  router.post('/api/admin/mmr-verifications/:id/reject', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_mmr_verifications')
    if (!admin) return
    try {
      const v = await queryOne('SELECT * FROM mmr_verifications WHERE id = $1', [req.params.id])
      if (!v) return res.status(404).json({ error: 'Submission not found' })
      if (v.status !== 'pending') return res.status(409).json({ error: 'Already reviewed' })
      await execute(`
        UPDATE mmr_verifications
        SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), review_note = $2
        WHERE id = $3
      `, [admin.id, req.body.note || null, v.id])
      if (io) io.emit('mmrVerification:reviewed', { id: v.id, playerId: v.player_id, status: 'rejected' })
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  return router
}
