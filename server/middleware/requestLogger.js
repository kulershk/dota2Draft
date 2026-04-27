import { execute } from '../db.js'
import { getSessionPlayerId, getTokenFromReq } from './auth.js'

const FLUSH_INTERVAL_MS = 5_000
const FLUSH_BATCH_SIZE = 100

const requestQueue = []
const socketQueue = []

const SKIP_PATH_PREFIXES = [
  '/api/docs',
  '/api/admin/stats',
  '/api/version',
  '/uploads',
  '/assets',
]

function shouldSkip(path) {
  if (!path) return true
  for (const p of SKIP_PATH_PREFIXES) {
    if (path === p || path.startsWith(p + '/')) return true
  }
  return false
}

function normalizePath(rawPath) {
  if (!rawPath) return ''
  const path = rawPath.split('?')[0]
  return path
    .replace(/\/[0-9]+(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, '/:hash')
}

export function requestLogger(req, res, next) {
  const start = Date.now()
  const path = normalizePath(req.originalUrl || req.url || '')

  if (shouldSkip(path)) return next()

  res.on('finish', () => {
    const userId = getSessionPlayerId(getTokenFromReq(req))
    const ua = (req.headers['user-agent'] || '').slice(0, 200)
    requestQueue.push({
      method: req.method,
      path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      user_id: userId || null,
      ip: req.ip || null,
      user_agent: ua || null,
    })
    if (requestQueue.length >= FLUSH_BATCH_SIZE) flushRequests().catch(() => {})
  })

  next()
}

export function logSocketEvent({ event, userId, competitionId, path }) {
  if (!event) return
  socketQueue.push({
    event,
    user_id: userId || null,
    competition_id: competitionId || null,
    path: path || null,
  })
  if (socketQueue.length >= FLUSH_BATCH_SIZE) flushSocketEvents().catch(() => {})
}

async function flushRequests() {
  if (requestQueue.length === 0) return
  const batch = requestQueue.splice(0, requestQueue.length)
  const values = []
  const params = []
  let i = 1
  for (const r of batch) {
    values.push(`($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6})`)
    params.push(r.method, r.path, r.status, r.duration_ms, r.user_id, r.ip, r.user_agent)
    i += 7
  }
  try {
    await execute(
      `INSERT INTO request_logs (method, path, status, duration_ms, user_id, ip, user_agent) VALUES ${values.join(',')}`,
      params
    )
  } catch (e) {
    console.error('[requestLogger] flush failed:', e.message)
  }
}

async function flushSocketEvents() {
  if (socketQueue.length === 0) return
  const batch = socketQueue.splice(0, socketQueue.length)
  const values = []
  const params = []
  let i = 1
  for (const r of batch) {
    values.push(`($${i}, $${i + 1}, $${i + 2}, $${i + 3})`)
    params.push(r.event, r.user_id, r.competition_id, r.path)
    i += 4
  }
  try {
    await execute(
      `INSERT INTO socket_event_logs (event, user_id, competition_id, path) VALUES ${values.join(',')}`,
      params
    )
  } catch (e) {
    console.error('[requestLogger] socket flush failed:', e.message)
  }
}

export function startRequestLoggerWorkers() {
  setInterval(() => {
    flushRequests().catch(() => {})
    flushSocketEvents().catch(() => {})
  }, FLUSH_INTERVAL_MS).unref?.()

  const flushOnExit = () => {
    flushRequests().catch(() => {})
    flushSocketEvents().catch(() => {})
  }
  process.on('SIGTERM', flushOnExit)
  process.on('SIGINT', flushOnExit)
}
