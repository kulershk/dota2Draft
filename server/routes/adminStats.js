import { Router } from 'express'
import { query } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'

const router = Router()

const PERIOD_HOURS = { '1h': 1, '24h': 24, '7d': 7 * 24, '14d': 14 * 24 }
const BUCKETS = new Set(['minute', 'hour', 'day'])

function parsePeriodHours(period) {
  return PERIOD_HOURS[period] || 24
}

function defaultBucketFor(period) {
  if (period === '1h') return 'minute'
  if (period === '24h') return 'hour'
  return 'day'
}

// Builds the WHERE clause for request_logs. Always filters by ts >= now-hours.
// Optionally filters by user_id and/or ip when provided. Returns { where, params }.
function buildRequestFilter(req, alias = '') {
  const a = alias ? `${alias}.` : ''
  const params = []
  const parts = []

  const hours = parsePeriodHours(req.query.period || '24h')
  params.push(String(hours))
  parts.push(`${a}ts >= NOW() - ($${params.length} || ' hours')::interval`)

  const userId = req.query.userId ? Number(req.query.userId) : null
  if (userId && Number.isFinite(userId)) {
    params.push(userId)
    parts.push(`${a}user_id = $${params.length}`)
  }

  const ip = req.query.ip ? String(req.query.ip) : null
  if (ip) {
    params.push(ip)
    parts.push(`${a}ip = $${params.length}`)
  }

  return { where: parts.join(' AND '), params, hours, userId, ip }
}

// socket_event_logs has no `ip` column — only user_id is filterable.
function buildSocketFilter(req) {
  const params = []
  const parts = []

  const hours = parsePeriodHours(req.query.period || '24h')
  params.push(String(hours))
  parts.push(`ts >= NOW() - ($${params.length} || ' hours')::interval`)

  const userId = req.query.userId ? Number(req.query.userId) : null
  if (userId && Number.isFinite(userId)) {
    params.push(userId)
    parts.push(`user_id = $${params.length}`)
  }

  return { where: parts.join(' AND '), params }
}

router.get('/api/admin/stats/summary', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const f = buildRequestFilter(req)
  const sf = buildSocketFilter(req)

  const [totals, status, sockets] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(DISTINCT user_id)::int AS unique_users,
              COUNT(DISTINCT ip)::int AS unique_ips,
              COALESCE(AVG(duration_ms), 0)::int AS avg_ms,
              COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms
         FROM request_logs WHERE ${f.where}`,
      f.params
    ),
    query(
      `SELECT (status / 100)::int AS klass, COUNT(*)::int AS count
         FROM request_logs WHERE ${f.where}
         GROUP BY klass ORDER BY klass`,
      f.params
    ),
    query(
      `SELECT COUNT(*)::int AS total, COUNT(DISTINCT user_id)::int AS unique_users
         FROM socket_event_logs WHERE ${sf.where}`,
      sf.params
    ),
  ])

  res.json({
    period: req.query.period || '24h',
    requests: totals[0] || { total: 0, unique_users: 0, unique_ips: 0, avg_ms: 0, p95_ms: 0 },
    status_breakdown: status,
    socket: sockets[0] || { total: 0, unique_users: 0 },
  })
})

router.get('/api/admin/stats/top-routes', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const f = buildRequestFilter(req)
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100)
  f.params.push(limit)

  const rows = await query(
    `SELECT method, path,
            COUNT(*)::int AS count,
            COALESCE(AVG(duration_ms), 0)::int AS avg_ms,
            COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms,
            (COUNT(*) FILTER (WHERE status >= 400))::int AS errors
       FROM request_logs WHERE ${f.where}
       GROUP BY method, path
       ORDER BY count DESC
       LIMIT $${f.params.length}`,
    f.params
  )
  res.json(rows)
})

router.get('/api/admin/stats/timeseries', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const f = buildRequestFilter(req)
  const period = req.query.period || '24h'
  const bucket = BUCKETS.has(req.query.bucket) ? req.query.bucket : defaultBucketFor(period)
  const path = req.query.path || null
  const method = req.query.method || null

  let where = f.where
  if (path) {
    f.params.push(path)
    where += ` AND path = $${f.params.length}`
  }
  if (method) {
    f.params.push(method)
    where += ` AND method = $${f.params.length}`
  }
  f.params.push(bucket)
  const bucketIdx = f.params.length

  const rows = await query(
    `SELECT date_trunc($${bucketIdx}, ts) AS bucket,
            COUNT(*)::int AS count,
            (COUNT(*) FILTER (WHERE status >= 400))::int AS errors,
            COALESCE(AVG(duration_ms), 0)::int AS avg_ms
       FROM request_logs WHERE ${where}
       GROUP BY bucket ORDER BY bucket`,
    f.params
  )
  res.json({ bucket, rows })
})

router.get('/api/admin/stats/top-users', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const f = buildRequestFilter(req, 'rl')
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100)
  f.params.push(limit)

  const rows = await query(
    `SELECT rl.user_id,
            COALESCE(p.display_name, p.name, '(anon)') AS name,
            p.avatar_url,
            COUNT(*)::int AS count,
            (COUNT(*) FILTER (WHERE rl.status >= 400))::int AS errors,
            MAX(rl.ts) AS last_seen
       FROM request_logs rl
       LEFT JOIN players p ON p.id = rl.user_id
       WHERE ${f.where}
       GROUP BY rl.user_id, p.display_name, p.name, p.avatar_url
       ORDER BY count DESC
       LIMIT $${f.params.length}`,
    f.params
  )
  res.json(rows)
})

router.get('/api/admin/stats/socket-events', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const sf = buildSocketFilter(req)
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200)
  sf.params.push(limit)

  const rows = await query(
    `SELECT event,
            COUNT(*)::int AS count,
            COUNT(DISTINCT user_id)::int AS unique_users
       FROM socket_event_logs WHERE ${sf.where}
       GROUP BY event
       ORDER BY count DESC
       LIMIT $${sf.params.length}`,
    sf.params
  )
  res.json(rows)
})

router.get('/api/admin/stats/top-ips', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const f = buildRequestFilter(req)
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100)
  f.params.push(limit)

  const rows = await query(
    `SELECT ip,
            COUNT(*)::int AS count,
            COUNT(DISTINCT user_id)::int AS unique_users,
            (COUNT(*) FILTER (WHERE status >= 400))::int AS errors,
            MAX(ts) AS last_seen
       FROM request_logs
       WHERE ${f.where} AND ip IS NOT NULL
       GROUP BY ip
       ORDER BY count DESC
       LIMIT $${f.params.length}`,
    f.params
  )
  res.json(rows)
})

router.get('/api/admin/stats/recent-requests', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const f = buildRequestFilter(req)
  if (!f.userId && !f.ip) {
    return res.status(400).json({ error: 'userId or ip filter required' })
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500)
  f.params.push(limit)

  const rows = await query(
    `SELECT rl.ts, rl.method, rl.path, rl.status, rl.duration_ms, rl.user_id,
            rl.ip, rl.user_agent,
            COALESCE(p.display_name, p.name) AS user_name
       FROM request_logs rl
       LEFT JOIN players p ON p.id = rl.user_id
       WHERE ${f.where}
       ORDER BY rl.ts DESC
       LIMIT $${f.params.length}`,
    f.params
  )
  res.json(rows)
})

export default router
