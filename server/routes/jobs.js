import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'
import { enqueueJob, getRegisteredTypes, getSchedules } from '../services/jobs.js'

const router = Router()

router.get('/api/admin/jobs', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_jobs')
  if (!admin) return
  const { status, type, limit = 100, offset = 0 } = req.query
  const where = []
  const params = []
  if (status && status !== 'all') { params.push(status); where.push(`status = $${params.length}`) }
  if (type) { params.push(type); where.push(`type = $${params.length}`) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  params.push(Math.min(Number(limit) || 100, 500))
  params.push(Math.max(Number(offset) || 0, 0))
  const rows = await query(
    `SELECT * FROM jobs ${whereSql} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )
  const totalRow = await queryOne(
    `SELECT COUNT(*)::int AS total FROM jobs ${whereSql}`,
    params.slice(0, params.length - 2)
  )
  const countsRows = await query(`SELECT status, COUNT(*)::int AS count FROM jobs GROUP BY status`)
  const counts = { pending: 0, running: 0, completed: 0, failed: 0 }
  for (const r of countsRows) counts[r.status] = r.count
  res.json({ rows, total: totalRow?.total || 0, counts, types: getRegisteredTypes(), schedules: getSchedules() })
})

router.get('/api/admin/jobs/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_jobs')
  if (!admin) return
  const job = await queryOne('SELECT * FROM jobs WHERE id = $1', [req.params.id])
  if (!job) return res.status(404).json({ error: 'Not found' })
  res.json(job)
})

router.post('/api/admin/jobs', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_jobs')
  if (!admin) return
  const { type, payload, maxAttempts } = req.body || {}
  if (!type) return res.status(400).json({ error: 'type is required' })
  if (!getRegisteredTypes().includes(type)) {
    return res.status(400).json({ error: `Unknown job type "${type}"` })
  }
  const job = await enqueueJob({ type, payload: payload || {}, maxAttempts: maxAttempts || 3, createdBy: admin.id })
  res.json(job)
})

router.post('/api/admin/jobs/:id/retry', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_jobs')
  if (!admin) return
  const job = await queryOne('SELECT * FROM jobs WHERE id = $1', [req.params.id])
  if (!job) return res.status(404).json({ error: 'Not found' })
  if (job.status === 'running') return res.status(409).json({ error: 'Job is running' })
  const updated = await queryOne(
    `UPDATE jobs SET status = 'pending', run_at = NOW(), error = NULL, completed_at = NULL,
       max_attempts = GREATEST(max_attempts, attempts + 1)
     WHERE id = $1 RETURNING *`,
    [req.params.id]
  )
  res.json(updated)
})

router.post('/api/admin/jobs/:id/cancel', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_jobs')
  if (!admin) return
  const job = await queryOne('SELECT * FROM jobs WHERE id = $1', [req.params.id])
  if (!job) return res.status(404).json({ error: 'Not found' })
  if (job.status !== 'pending') return res.status(409).json({ error: 'Only pending jobs can be cancelled' })
  const updated = await queryOne(
    `UPDATE jobs SET status = 'failed', error = 'Cancelled by admin', completed_at = NOW() WHERE id = $1 RETURNING *`,
    [req.params.id]
  )
  res.json(updated)
})

router.delete('/api/admin/jobs/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_jobs')
  if (!admin) return
  await execute('DELETE FROM jobs WHERE id = $1', [req.params.id])
  res.json({ ok: true })
})

router.post('/api/admin/jobs/prune', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_jobs')
  if (!admin) return
  const { status = 'completed', olderThanDays = 7 } = req.body || {}
  const days = Math.max(0, Number(olderThanDays) || 0)
  const result = await execute(
    `DELETE FROM jobs WHERE status = $1 AND completed_at < NOW() - ($2 || ' days')::interval`,
    [status, String(days)]
  )
  res.json({ ok: true, deleted: result.rowCount })
})

export default router
