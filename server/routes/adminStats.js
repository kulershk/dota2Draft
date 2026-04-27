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

router.get('/api/admin/stats/summary', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const period = req.query.period || '24h'
  const hours = parsePeriodHours(period)

  const [totals, status, sockets] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(DISTINCT user_id)::int AS unique_users,
              COUNT(DISTINCT ip)::int AS unique_ips,
              COALESCE(AVG(duration_ms), 0)::int AS avg_ms,
              COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms
         FROM request_logs WHERE ts >= NOW() - ($1 || ' hours')::interval`,
      [String(hours)]
    ),
    query(
      `SELECT
         (status / 100)::int AS klass,
         COUNT(*)::int AS count
         FROM request_logs WHERE ts >= NOW() - ($1 || ' hours')::interval
         GROUP BY klass ORDER BY klass`,
      [String(hours)]
    ),
    query(
      `SELECT COUNT(*)::int AS total,
              COUNT(DISTINCT user_id)::int AS unique_users
         FROM socket_event_logs WHERE ts >= NOW() - ($1 || ' hours')::interval`,
      [String(hours)]
    ),
  ])

  res.json({
    period,
    requests: totals[0] || { total: 0, unique_users: 0, unique_ips: 0, avg_ms: 0, p95_ms: 0 },
    status_breakdown: status,
    socket: sockets[0] || { total: 0, unique_users: 0 },
  })
})

router.get('/api/admin/stats/top-routes', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const hours = parsePeriodHours(req.query.period || '24h')
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100)

  const rows = await query(
    `SELECT method, path,
            COUNT(*)::int AS count,
            COALESCE(AVG(duration_ms), 0)::int AS avg_ms,
            COALESCE(percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int AS p95_ms,
            (COUNT(*) FILTER (WHERE status >= 400))::int AS errors
       FROM request_logs WHERE ts >= NOW() - ($1 || ' hours')::interval
       GROUP BY method, path
       ORDER BY count DESC
       LIMIT $2`,
    [String(hours), limit]
  )
  res.json(rows)
})

router.get('/api/admin/stats/timeseries', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const period = req.query.period || '24h'
  const hours = parsePeriodHours(period)
  const bucket = BUCKETS.has(req.query.bucket) ? req.query.bucket : defaultBucketFor(period)
  const path = req.query.path || null
  const method = req.query.method || null

  const params = [String(hours)]
  let where = `ts >= NOW() - ($1 || ' hours')::interval`
  if (path) {
    params.push(path)
    where += ` AND path = $${params.length}`
  }
  if (method) {
    params.push(method)
    where += ` AND method = $${params.length}`
  }

  const rows = await query(
    `SELECT date_trunc($${params.length + 1}, ts) AS bucket,
            COUNT(*)::int AS count,
            (COUNT(*) FILTER (WHERE status >= 400))::int AS errors,
            COALESCE(AVG(duration_ms), 0)::int AS avg_ms
       FROM request_logs WHERE ${where}
       GROUP BY bucket ORDER BY bucket`,
    [...params, bucket]
  )
  res.json({ bucket, rows })
})

router.get('/api/admin/stats/top-users', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const hours = parsePeriodHours(req.query.period || '24h')
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100)

  const rows = await query(
    `SELECT rl.user_id,
            COALESCE(p.display_name, p.name, '(anon)') AS name,
            p.avatar_url,
            COUNT(*)::int AS count,
            (COUNT(*) FILTER (WHERE rl.status >= 400))::int AS errors,
            MAX(rl.ts) AS last_seen
       FROM request_logs rl
       LEFT JOIN players p ON p.id = rl.user_id
       WHERE rl.ts >= NOW() - ($1 || ' hours')::interval
       GROUP BY rl.user_id, p.display_name, p.name, p.avatar_url
       ORDER BY count DESC
       LIMIT $2`,
    [String(hours), limit]
  )
  res.json(rows)
})

router.get('/api/admin/stats/socket-events', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const hours = parsePeriodHours(req.query.period || '24h')
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200)

  const rows = await query(
    `SELECT event,
            COUNT(*)::int AS count,
            COUNT(DISTINCT user_id)::int AS unique_users
       FROM socket_event_logs WHERE ts >= NOW() - ($1 || ' hours')::interval
       GROUP BY event
       ORDER BY count DESC
       LIMIT $2`,
    [String(hours), limit]
  )
  res.json(rows)
})

router.get('/api/admin/stats/top-ips', async (req, res) => {
  if (!await requirePermission(req, res, 'view_request_stats')) return
  const hours = parsePeriodHours(req.query.period || '24h')
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100)

  const rows = await query(
    `SELECT ip,
            COUNT(*)::int AS count,
            COUNT(DISTINCT user_id)::int AS unique_users,
            (COUNT(*) FILTER (WHERE status >= 400))::int AS errors,
            MAX(ts) AS last_seen
       FROM request_logs
       WHERE ts >= NOW() - ($1 || ' hours')::interval AND ip IS NOT NULL
       GROUP BY ip
       ORDER BY count DESC
       LIMIT $2`,
    [String(hours), limit]
  )
  res.json(rows)
})

export default router
