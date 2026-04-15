import { query, queryOne, execute } from '../db.js'

const handlers = new Map()
const schedules = new Map() // type -> { everyMs, payload, maxAttempts }
const POLL_INTERVAL_MS = 2000
const SCHEDULE_SEED_MS = 60_000
const CONCURRENCY = 2
const STUCK_RUNNING_MS = 10 * 60 * 1000

let _timer = null
let _seedTimer = null
let _running = 0
let _shuttingDown = false

export function registerHandler(type, fn) {
  if (handlers.has(type)) {
    console.warn(`[jobs] handler for "${type}" is being overridden`)
  }
  handlers.set(type, fn)
}

export function getRegisteredTypes() {
  return Array.from(handlers.keys())
}

/**
 * Declare a recurring job. The worker guarantees there's always exactly one
 * pending/running row for this type: on startup and every SCHEDULE_SEED_MS,
 * if none exists, one is enqueued. After each completed run, the next one is
 * queued at NOW() + everyMs.
 */
export function registerSchedule(type, { everyMs, payload = {}, maxAttempts = 3 }) {
  if (!handlers.has(type)) {
    console.warn(`[jobs] registerSchedule("${type}") before handler — register handler first`)
  }
  schedules.set(type, { everyMs, payload, maxAttempts })
}

export function getSchedules() {
  return Array.from(schedules.entries()).map(([type, s]) => ({ type, ...s }))
}

async function seedSchedules() {
  for (const [type, s] of schedules.entries()) {
    try {
      const existing = await queryOne(
        `SELECT 1 FROM jobs WHERE type = $1 AND status IN ('pending', 'running') LIMIT 1`,
        [type]
      )
      if (!existing) {
        await enqueueJob({ type, payload: s.payload, maxAttempts: s.maxAttempts })
      }
    } catch (err) {
      console.error(`[jobs] seedSchedules(${type}) error:`, err)
    }
  }
}

export async function enqueueJob({ type, payload = {}, maxAttempts = 3, runAt = null, createdBy = null } = {}) {
  if (!type) throw new Error('enqueueJob: type is required')
  const row = await queryOne(
    `INSERT INTO jobs (type, payload, max_attempts, run_at, created_by)
     VALUES ($1, $2, $3, COALESCE($4, NOW()), $5) RETURNING *`,
    [type, JSON.stringify(payload), maxAttempts, runAt, createdBy]
  )
  return row
}

async function claimNextJob() {
  // Reset jobs stuck in 'running' past the deadline so they can retry.
  await execute(
    `UPDATE jobs SET status = 'pending', started_at = NULL
     WHERE status = 'running' AND started_at < NOW() - ($1 || ' milliseconds')::interval`,
    [String(STUCK_RUNNING_MS)]
  )
  const row = await queryOne(
    `UPDATE jobs SET status = 'running', started_at = NOW(), attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'pending' AND run_at <= NOW()
       ORDER BY run_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`
  )
  return row
}

function backoffMs(attempts) {
  // Exponential backoff with cap: 10s, 30s, 2m, 5m, 15m…
  const base = [10_000, 30_000, 120_000, 300_000, 900_000]
  return base[Math.min(attempts - 1, base.length - 1)] || 900_000
}

async function runJob(job) {
  const handler = handlers.get(job.type)
  if (!handler) {
    await execute(
      `UPDATE jobs SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2`,
      [`No handler registered for type "${job.type}"`, job.id]
    )
    return
  }
  try {
    const result = await handler(job.payload || {}, job)
    await execute(
      `UPDATE jobs SET status = 'completed', result = $1, completed_at = NOW(), error = NULL WHERE id = $2`,
      [result == null ? null : JSON.stringify(result), job.id]
    )
    const schedule = schedules.get(job.type)
    if (schedule) {
      await enqueueJob({
        type: job.type,
        payload: schedule.payload,
        maxAttempts: schedule.maxAttempts,
        runAt: new Date(Date.now() + schedule.everyMs),
      })
    }
  } catch (err) {
    const message = err?.message || String(err)
    const stack = err?.stack ? `\n${err.stack}` : ''
    if (job.attempts >= job.max_attempts) {
      await execute(
        `UPDATE jobs SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2`,
        [message + stack, job.id]
      )
      // Recurring jobs should keep running even after a failure — enqueue the
      // next occurrence so a transient error doesn't break the chain. The
      // failed row stays visible in history.
      const schedule = schedules.get(job.type)
      if (schedule) {
        await enqueueJob({
          type: job.type,
          payload: schedule.payload,
          maxAttempts: schedule.maxAttempts,
          runAt: new Date(Date.now() + schedule.everyMs),
        })
      }
    } else {
      await execute(
        `UPDATE jobs SET status = 'pending', error = $1, run_at = NOW() + ($2 || ' milliseconds')::interval WHERE id = $3`,
        [message, String(backoffMs(job.attempts)), job.id]
      )
    }
  }
}

async function tick() {
  if (_shuttingDown) return
  while (_running < CONCURRENCY) {
    let job
    try {
      job = await claimNextJob()
    } catch (err) {
      console.error('[jobs] claim error:', err)
      return
    }
    if (!job) return
    _running++
    runJob(job).finally(() => { _running-- }).catch(err => {
      console.error('[jobs] unexpected runJob error:', err)
    })
  }
}

export async function startJobWorker() {
  if (_timer) return
  await seedSchedules()
  _timer = setInterval(() => { tick().catch(err => console.error('[jobs] tick error:', err)) }, POLL_INTERVAL_MS)
  _seedTimer = setInterval(() => { seedSchedules().catch(err => console.error('[jobs] seed error:', err)) }, SCHEDULE_SEED_MS)
  console.log(`[jobs] worker started (poll=${POLL_INTERVAL_MS}ms, concurrency=${CONCURRENCY}, schedules=${schedules.size})`)
}

export function stopJobWorker() {
  _shuttingDown = true
  if (_timer) { clearInterval(_timer); _timer = null }
  if (_seedTimer) { clearInterval(_seedTimer); _seedTimer = null }
}

// Built-in handler so the page has at least one live example and admins can
// sanity-check that the worker is actually running.
registerHandler('noop', async (payload) => {
  const delay = Math.min(Number(payload?.delayMs) || 0, 10_000)
  if (delay > 0) await new Promise(r => setTimeout(r, delay))
  return { ok: true, at: new Date().toISOString() }
})
