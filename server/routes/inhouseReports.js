// Inhouse toxic + grief report endpoints.
//
// Toxic: any match participant can report any other. Reports accumulate
// lifetime; configured thresholds promote them into strikes; strike counts
// at configured tiers insert a row into queue_bans (the existing ban-
// enforcement at queue:join applies the cooldown for free).
//
// Grief: any match participant can report any other (same gating as toxic),
// requires comment, admin-reviewed. On approval, a grief_strikes increment +
// cooldown via the parallel grief-cooldowns config. If the reported player was
// in the captain pool, they lose it.
//
// Both flows emit socket notifications via the per-user `user:${id}` room.

import { Router } from 'express'
import pgPool, { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requirePermission, hasPermission } from '../middleware/permissions.js'

// Returns { qm, pool } where qm is the queue_matches row + parsed roster
// or { error, status } on validation failure. Centralises the membership
// check both report endpoints need.
async function _loadMatchAndPool(queueMatchId) {
  const qm = await queryOne(`SELECT * FROM queue_matches WHERE id = $1`, [queueMatchId])
  if (!qm) return { error: 'Queue match not found', status: 404 }
  const pool = await queryOne('SELECT * FROM queue_pools WHERE id = $1', [qm.pool_id])
  return { qm, pool }
}

function _allPlayerIds(qm) {
  // qm.all_player_ids is JSONB array of player ids
  if (Array.isArray(qm.all_player_ids)) return qm.all_player_ids.map(n => Number(n))
  return []
}

// Is this match reportable right now for `reporterId`? Rules:
//   * status must not be 'cancelled' (the game didn't happen)
//   * if the match is completed, completed_at must be within
//     pool.report_window_minutes — defaults to 15. While the match is
//     still active (picking/lobby_creating/live) the window doesn't apply
//     yet.
// Returns { ok: true } or { ok: false, error: string }.
function _isWithinReportWindow(qm, pool) {
  if (qm.status === 'cancelled') return { ok: false, error: 'Cancelled matches cannot be reported' }
  if (qm.status === 'completed') {
    const windowMin = Math.max(0, Number(pool?.report_window_minutes ?? 15))
    if (!qm.completed_at) return { ok: false, error: 'Match has no completion time' }
    const ageMs = Date.now() - new Date(qm.completed_at).getTime()
    if (ageMs > windowMin * 60 * 1000) {
      return { ok: false, error: `Report window expired (${windowMin} min after match end)` }
    }
  }
  return { ok: true }
}

// Look up the matching cooldown rule for a given strike count. Rules are
// `{ strikes, hours? , action? }` — `hours` wins if present (insert a ban
// with that duration), `action: 'warn'` is a no-op, `action: 'ban'` is a
// permanent ban.
function _cooldownFor(strikes, rules) {
  if (!Array.isArray(rules)) return null
  return rules.find(r => Number(r.strikes) === Number(strikes)) || null
}

// Insert a `notifications` row for the punished player. Called INSIDE the
// strike transaction so it rolls back atomically; the caller is responsible
// for emitting `notification:new` to user:${id} AFTER commit so the bell
// badge updates in real time. Returns the inserted notification id.
async function _insertStrikeNotification(client, { playerId, type, title, body, link, byAdminId }) {
  const r = await client.query(
    `INSERT INTO notifications (recipient_id, type, title, body, link, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [playerId, type, title, body || null, link || null, byAdminId || null]
  )
  return r.rows[0].id
}

// Insert a queue_bans row reflecting a strike-driven cooldown. Returns the
// ISO string of `banned_until` (or null for permanent).
async function _applyCooldown(client, playerId, poolId, rule, reasonText, banner) {
  if (!rule || rule.action === 'warn') return null
  if (rule.action === 'ban') {
    await client.query(
      `INSERT INTO queue_bans (player_id, pool_id, banned_until, reason, banned_by)
       VALUES ($1, NULL, NULL, $2, $3)
       ON CONFLICT (player_id) WHERE pool_id IS NULL DO UPDATE SET reason = EXCLUDED.reason, banned_until = NULL`,
      [playerId, reasonText, banner || null]
    )
    return null
  }
  const hours = Number(rule.hours) || 0
  if (hours <= 0) return null
  const r = await client.query(
    `INSERT INTO queue_bans (player_id, pool_id, banned_until, reason, banned_by)
     VALUES ($1, $2, NOW() + ($3 || ' hours')::interval, $4, $5)
     ON CONFLICT (player_id, pool_id) WHERE pool_id IS NOT NULL DO UPDATE
       SET banned_until = GREATEST(COALESCE(queue_bans.banned_until, NOW()), EXCLUDED.banned_until),
           reason = EXCLUDED.reason
     RETURNING banned_until`,
    [playerId, poolId || null, String(hours), reasonText, banner || null]
  )
  return r.rows[0]?.banned_until || null
}

export default function createInhouseReportsRouter(io) {
  const router = Router()

  // ── User: file a toxic report against a match participant ──
  router.post('/api/inhouse/reports/toxic', async (req, res) => {
    const reporter = await getAuthPlayer(req)
    if (!reporter) return res.status(401).json({ error: 'Not authenticated' })

    const queueMatchId = Number(req.body?.queue_match_id)
    const reportedId = Number(req.body?.reported_player_id)
    const comment = (req.body?.comment || '').toString().slice(0, 500)
    if (!queueMatchId || !reportedId) return res.status(400).json({ error: 'queue_match_id and reported_player_id required' })
    if (reportedId === reporter.id) return res.status(400).json({ error: "Can't report yourself" })

    const { qm, pool, error, status } = await _loadMatchAndPool(queueMatchId)
    if (error) return res.status(status).json({ error })
    if (!pool?.inhouse_enabled) return res.status(400).json({ error: 'Reports only available on inhouse matches' })

    const allIds = _allPlayerIds(qm)
    if (!allIds.includes(reporter.id)) return res.status(403).json({ error: 'You were not in this match' })
    if (!allIds.includes(reportedId))  return res.status(400).json({ error: 'Reported player was not in this match' })

    // Window: matches stay reportable for pool.report_window_minutes after
    // they complete (default 15). Prevents weaponising the system months
    // later while still tolerating "let me re-queue first then report".
    const windowCheck = _isWithinReportWindow(qm, pool)
    if (!windowCheck.ok) return res.status(403).json({ error: windowCheck.error })

    // Insert as pending. The unique constraint still blocks dupes for the
    // same (reporter, reported, match). The strike + cooldown logic lives
    // on the admin approve endpoint — see /api/admin/inhouse/toxic-reports/:id/approve.
    try {
      let insertedId
      try {
        const ins = await queryOne(
          `INSERT INTO inhouse_toxic_reports (reporter_player_id, reported_player_id, queue_match_id, pool_id, comment, status)
           VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
          [reporter.id, reportedId, queueMatchId, qm.pool_id, comment || null]
        )
        insertedId = ins.id
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'You already reported this player for this match' })
        throw e
      }
      io.to(`user:${reporter.id}`).emit('inhouse:reportFiled', { kind: 'toxic', queueMatchId, reportedPlayerId: reportedId })
      res.status(201).json({ ok: true, reportId: insertedId, status: 'pending' })
    } catch (e) {
      console.error('[inhouse toxic]', e)
      res.status(500).json({ error: e.message })
    }
  })

  // ── User: file a grief report against any match participant ──
  router.post('/api/inhouse/reports/grief', async (req, res) => {
    const reporter = await getAuthPlayer(req)
    if (!reporter) return res.status(401).json({ error: 'Not authenticated' })

    const queueMatchId = Number(req.body?.queue_match_id)
    const reportedId = Number(req.body?.reported_player_id)
    const comment = (req.body?.comment || '').toString().trim()
    if (!queueMatchId || !reportedId) return res.status(400).json({ error: 'queue_match_id and reported_player_id required' })
    if (!comment) return res.status(400).json({ error: 'Comment is required for grief reports' })
    if (reportedId === reporter.id) return res.status(400).json({ error: "Can't report yourself" })

    const { qm, pool, error, status } = await _loadMatchAndPool(queueMatchId)
    if (error) return res.status(status).json({ error })
    if (!pool?.inhouse_enabled) return res.status(400).json({ error: 'Reports only available on inhouse matches' })

    // Any match participant can file a grief report against any other
    // participant (was captain-only + same-team).
    const allIds = _allPlayerIds(qm)
    if (!allIds.includes(reporter.id)) return res.status(403).json({ error: 'You were not in this match' })
    if (!allIds.includes(reportedId))  return res.status(400).json({ error: 'Reported player was not in this match' })

    // Window: same rule as toxic — reportable until pool.report_window_minutes
    // after completion.
    const windowCheck = _isWithinReportWindow(qm, pool)
    if (!windowCheck.ok) return res.status(403).json({ error: windowCheck.error })

    try {
      let inserted
      try {
        inserted = await queryOne(
          `INSERT INTO inhouse_grief_reports (reporter_player_id, reported_player_id, queue_match_id, pool_id, comment)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
          [reporter.id, reportedId, queueMatchId, qm.pool_id, comment]
        )
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'You already reported this player for this match' })
        throw e
      }
      io.to(`user:${reporter.id}`).emit('inhouse:reportFiled', { kind: 'grief', queueMatchId, reportedPlayerId: reportedId })
      res.status(201).json({ ok: true, reportId: inserted.id, status: 'pending' })
    } catch (e) {
      console.error('[inhouse grief]', e)
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: list grief reports (default: pending) ──
  router.get('/api/admin/inhouse/grief-reports', async (req, res) => {
    const admin = await getAuthPlayer(req)
    if (!admin) return res.status(401).json({ error: 'Not authenticated' })
    const allowed = admin.is_admin || await hasPermission(admin, 'review_grief_reports')
    if (!allowed) return res.status(403).json({ error: 'Permission denied' })
    const status = (req.query.status || 'pending').toString()
    try {
      // Captain status now lives per-season as membership in a custom
      // group with captains_drawn_from=TRUE. Resolve via the pool's
      // season; falls back to FALSE if the pool has no season or no
      // captain group is defined.
      const rows = await query(`
        SELECT gr.*,
               rp.name AS reporter_name, COALESCE(rp.display_name, rp.name) AS reporter_display_name, rp.avatar_url AS reporter_avatar,
               tp.name AS reported_name, COALESCE(tp.display_name, tp.name) AS reported_display_name, tp.avatar_url AS reported_avatar,
               EXISTS (
                 SELECT 1 FROM season_player_group_members m
                 JOIN season_player_groups g ON g.id = m.group_id
                 WHERE m.player_id = gr.reported_player_id
                   AND g.season_id = qp.season_id
                   AND g.captains_drawn_from = TRUE
               ) AS reported_captain_pool,
               tp.grief_strikes AS reported_grief_strikes,
               qp.name AS pool_name
          FROM inhouse_grief_reports gr
          LEFT JOIN players rp ON rp.id = gr.reporter_player_id
          LEFT JOIN players tp ON tp.id = gr.reported_player_id
          LEFT JOIN queue_pools qp ON qp.id = gr.pool_id
         WHERE gr.status = $1
         ORDER BY gr.created_at DESC
      `, [status])
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: list toxic reports ──
  // Defaults to status='pending'. Optional ?player_id filter shows only
  // reports against one specific player. Same permission as grief reports.
  router.get('/api/admin/inhouse/toxic-reports', async (req, res) => {
    const admin = await getAuthPlayer(req)
    if (!admin) return res.status(401).json({ error: 'Not authenticated' })
    const allowed = admin.is_admin || await hasPermission(admin, 'review_grief_reports')
    if (!allowed) return res.status(403).json({ error: 'Permission denied' })
    const status = (req.query.status || 'pending').toString()
    const playerId = req.query.player_id ? Number(req.query.player_id) : null
    const limit = Math.min(Number(req.query.limit) || 100, 500)
    const params = [status]
    let where = `WHERE tr.status = $1`
    if (playerId) {
      params.push(playerId)
      where += ` AND tr.reported_player_id = $${params.length}`
    }
    params.push(limit)
    try {
      const rows = await query(`
        SELECT tr.*,
               rp.name AS reporter_name, COALESCE(rp.display_name, rp.name) AS reporter_display_name, rp.avatar_url AS reporter_avatar,
               tp.name AS reported_name, COALESCE(tp.display_name, tp.name) AS reported_display_name, tp.avatar_url AS reported_avatar,
               tp.toxic_reports_received AS reported_toxic_reports_received,
               tp.toxic_strikes AS reported_toxic_strikes,
               qp.name AS pool_name
          FROM inhouse_toxic_reports tr
          LEFT JOIN players rp ON rp.id = tr.reporter_player_id
          LEFT JOIN players tp ON tp.id = tr.reported_player_id
          LEFT JOIN queue_pools qp ON qp.id = tr.pool_id
          ${where}
         ORDER BY tr.created_at DESC
         LIMIT $${params.length}
      `, params)
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: approve a toxic report ──
  // This is where the strike + cooldown actually happen — the user-facing
  // POST only files a pending report. Re-uses the same threshold-firing
  // logic the original auto-fire flow had: bump toxic_reports_received,
  // walk pool.toxic_report_thresholds for any unfired thresholds <= the
  // new count, apply the strike delta, and (if the new strike count
  // matches a cooldown rule) insert a queue_bans row.
  router.post('/api/admin/inhouse/toxic-reports/:id/approve', async (req, res) => {
    const admin = await getAuthPlayer(req)
    if (!admin) return res.status(401).json({ error: 'Not authenticated' })
    const allowed = admin.is_admin || await hasPermission(admin, 'review_grief_reports')
    if (!allowed) return res.status(403).json({ error: 'Permission denied' })
    const reportId = Number(req.params.id)
    const note = (req.body?.review_note || '').toString().trim() || null

    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const report = (await client.query(
        `SELECT * FROM inhouse_toxic_reports WHERE id = $1 FOR UPDATE`,
        [reportId]
      )).rows[0]
      if (!report) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Report not found' }) }
      if (report.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: `Report already ${report.status}` }) }

      const pool = (await client.query('SELECT * FROM queue_pools WHERE id = $1', [report.pool_id])).rows[0]

      await client.query(
        `UPDATE inhouse_toxic_reports SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), review_note = $2 WHERE id = $3`,
        [admin.id, note, reportId]
      )

      const updated = (await client.query(
        `UPDATE players
            SET toxic_reports_received = toxic_reports_received + 1
          WHERE id = $1
          RETURNING toxic_reports_received, toxic_strikes, toxic_thresholds_fired`,
        [report.reported_player_id]
      )).rows[0]
      const newReportCount = updated.toxic_reports_received
      const firedRaw = Array.isArray(updated.toxic_thresholds_fired) ? updated.toxic_thresholds_fired : []
      const fired = new Set(firedRaw.map(n => Number(n)))
      const thresholds = Array.isArray(pool?.toxic_report_thresholds) ? pool.toxic_report_thresholds : []

      let strikeDelta = 0
      const newlyFired = []
      for (const t of thresholds) {
        const n = Number(t.reports)
        if (!Number.isFinite(n)) continue
        if (fired.has(n)) continue
        if (newReportCount < n) continue
        strikeDelta += Number(t.strike_delta) || 0
        newlyFired.push(n)
      }

      let newStrikes = Number(updated.toxic_strikes)
      let banUntil = null
      let cooldownRule = null
      let notificationId = null
      if (strikeDelta > 0 || newlyFired.length) {
        newStrikes = Number(updated.toxic_strikes) + strikeDelta
        const mergedFired = [...fired, ...newlyFired]
        await client.query(
          `UPDATE players SET toxic_strikes = $1, toxic_thresholds_fired = $2::jsonb, toxic_clean_games_since_last_strike = 0 WHERE id = $3`,
          [newStrikes, JSON.stringify(mergedFired), report.reported_player_id]
        )
        await client.query(
          `INSERT INTO inhouse_strike_log (player_id, kind, delta, reason, source_report_id, source_queue_match_id, applied_by)
           VALUES ($1, 'toxic', $2, $3, $4, $5, $6)`,
          [report.reported_player_id, strikeDelta, `Reached toxic-report threshold(s): ${newlyFired.join(',')}`, reportId, report.queue_match_id, admin.id]
        )
        cooldownRule = _cooldownFor(newStrikes, pool?.toxic_strike_cooldowns)
        if (cooldownRule) {
          const reasonText = `Toxic strike ${newStrikes}${cooldownRule.hours ? ` (${cooldownRule.hours}h cooldown)` : (cooldownRule.action === 'ban' ? ' (banned)' : ' (warning)')}`
          banUntil = await _applyCooldown(client, report.reported_player_id, report.pool_id, cooldownRule, reasonText, admin.id)
        }
        // Notify the reported player — bell badge + sidebar entry.
        const bodyLines = [`You received a toxic strike (now at ${newStrikes}).`]
        if (banUntil) {
          bodyLines.push(`Queue cooldown until ${new Date(banUntil).toLocaleString()}.`)
        } else if (cooldownRule?.action === 'ban') {
          bodyLines.push('Permanently banned from the queue.')
        } else if (cooldownRule?.action === 'warn') {
          bodyLines.push('This is a warning — no cooldown yet.')
        }
        notificationId = await _insertStrikeNotification(client, {
          playerId: report.reported_player_id,
          type: 'inhouse_strike_toxic',
          title: `Toxic strike +${strikeDelta}`,
          body: bodyLines.join(' '),
          link: '/queue',
          byAdminId: admin.id,
        })
      }

      await client.query('COMMIT')

      if (strikeDelta > 0) {
        io.to(`user:${report.reported_player_id}`).emit('inhouse:strikeApplied', {
          kind: 'toxic',
          newStrikes,
          strikeDelta,
          banUntil: banUntil ? new Date(banUntil).toISOString() : null,
        })
      }
      if (notificationId) {
        io.to(`user:${report.reported_player_id}`).emit('notification:new', { id: notificationId })
      }
      io.to(`user:${report.reporter_player_id}`).emit('inhouse:toxicReviewed', { reportId, status: 'approved' })
      io.to(`user:${report.reported_player_id}`).emit('inhouse:toxicReviewed', { reportId, status: 'approved' })
      res.json({ ok: true, newReportCount, strikeDelta, newStrikes, banUntil })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      console.error('[inhouse toxic approve]', e)
      res.status(500).json({ error: e.message })
    } finally {
      client.release()
    }
  })

  // ── Admin: reject a toxic report ──
  router.post('/api/admin/inhouse/toxic-reports/:id/reject', async (req, res) => {
    const admin = await getAuthPlayer(req)
    if (!admin) return res.status(401).json({ error: 'Not authenticated' })
    const allowed = admin.is_admin || await hasPermission(admin, 'review_grief_reports')
    if (!allowed) return res.status(403).json({ error: 'Permission denied' })
    const reportId = Number(req.params.id)
    const note = (req.body?.review_note || '').toString().trim() || null
    try {
      const updated = await queryOne(
        `UPDATE inhouse_toxic_reports
            SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), review_note = $2
          WHERE id = $3 AND status = 'pending'
          RETURNING reporter_player_id, reported_player_id`,
        [admin.id, note, reportId]
      )
      if (!updated) return res.status(404).json({ error: 'Report not found or already reviewed' })
      io.to(`user:${updated.reporter_player_id}`).emit('inhouse:toxicReviewed', { reportId, status: 'rejected' })
      io.to(`user:${updated.reported_player_id}`).emit('inhouse:toxicReviewed', { reportId, status: 'rejected' })
      res.json({ ok: true })
    } catch (e) {
      console.error('[inhouse toxic reject]', e)
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: strike log (toxic + grief, including decays) ──
  router.get('/api/admin/inhouse/strike-log', async (req, res) => {
    const admin = await getAuthPlayer(req)
    if (!admin) return res.status(401).json({ error: 'Not authenticated' })
    const allowed = admin.is_admin || await hasPermission(admin, 'review_grief_reports')
    if (!allowed) return res.status(403).json({ error: 'Permission denied' })
    const playerId = req.query.player_id ? Number(req.query.player_id) : null
    const limit = Math.min(Number(req.query.limit) || 100, 500)
    const params = []
    let where = ''
    if (playerId) {
      params.push(playerId)
      where = `WHERE sl.player_id = $${params.length}`
    }
    params.push(limit)
    try {
      const rows = await query(`
        SELECT sl.*,
               p.name AS player_name, COALESCE(p.display_name, p.name) AS player_display_name, p.avatar_url AS player_avatar,
               ab.name AS applied_by_name, COALESCE(ab.display_name, ab.name) AS applied_by_display_name
          FROM inhouse_strike_log sl
          LEFT JOIN players p  ON p.id  = sl.player_id
          LEFT JOIN players ab ON ab.id = sl.applied_by
          ${where}
         ORDER BY sl.created_at DESC
         LIMIT $${params.length}
      `, params)
      res.json(rows)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ── Admin: approve a grief report ──
  router.post('/api/admin/inhouse/grief-reports/:id/approve', async (req, res) => {
    const admin = await getAuthPlayer(req)
    if (!admin) return res.status(401).json({ error: 'Not authenticated' })
    const allowed = admin.is_admin || await hasPermission(admin, 'review_grief_reports')
    if (!allowed) return res.status(403).json({ error: 'Permission denied' })
    const reportId = Number(req.params.id)
    const note = (req.body?.review_note || '').toString().trim() || null

    const client = await pgPool.connect()
    try {
      await client.query('BEGIN')
      const report = (await client.query(
        `SELECT * FROM inhouse_grief_reports WHERE id = $1 FOR UPDATE`,
        [reportId]
      )).rows[0]
      if (!report) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Report not found' }) }
      if (report.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: `Report already ${report.status}` }) }

      const pool = (await client.query('SELECT * FROM queue_pools WHERE id = $1', [report.pool_id])).rows[0]

      await client.query(
        `UPDATE inhouse_grief_reports SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), review_note = $2 WHERE id = $3`,
        [admin.id, note, reportId]
      )

      const reportedRow = (await client.query(
        `UPDATE players SET grief_strikes = grief_strikes + 1 WHERE id = $1 RETURNING grief_strikes`,
        [report.reported_player_id]
      )).rows[0]
      const newStrikes = reportedRow.grief_strikes
      // Captain status is now per-season membership in a captains_drawn_from
      // group. Find the matching group + membership row in one query so the
      // revocation step can target the right (group, player) pair.
      const captainGroupRow = pool?.season_id
        ? (await client.query(
            `SELECT g.id FROM season_player_groups g
               JOIN season_player_group_members m ON m.group_id = g.id
              WHERE g.season_id = $1
                AND g.captains_drawn_from = TRUE
                AND m.player_id = $2
              ORDER BY g.id ASC LIMIT 1`,
            [pool.season_id, report.reported_player_id]
          )).rows[0]
        : null
      const wasCaptain = !!captainGroupRow
      await client.query(
        `INSERT INTO inhouse_strike_log (player_id, kind, delta, reason, source_report_id, source_queue_match_id, applied_by)
         VALUES ($1, 'grief', 1, $2, $3, $4, $5)`,
        [report.reported_player_id, 'Grief report approved', reportId, report.queue_match_id, admin.id]
      )

      const cooldown = _cooldownFor(newStrikes, pool?.grief_strike_cooldowns)
      let banUntil = null
      if (cooldown) {
        const reasonText = `Grief strike ${newStrikes}${cooldown.hours ? ` (${cooldown.hours}h cooldown)` : (cooldown.action === 'ban' ? ' (banned)' : ' (warning)')}`
        banUntil = await _applyCooldown(client, report.reported_player_id, report.pool_id, cooldown, reasonText, admin.id)
      }

      // Captain who griefs loses their captain status per spec — scoped
      // to this report's season so they keep captain flags they may hold
      // in unrelated seasons. We remove their membership in the
      // captains_drawn_from group rather than touching any global flag.
      let captainRevoked = false
      if (wasCaptain && captainGroupRow) {
        await client.query(
          `DELETE FROM season_player_group_members WHERE group_id = $1 AND player_id = $2`,
          [captainGroupRow.id, report.reported_player_id]
        )
        await client.query(
          `INSERT INTO inhouse_strike_log (player_id, kind, delta, reason, source_report_id, applied_by)
           VALUES ($1, 'captain_revoked', 0, 'Lost captain status due to approved grief report', $2, $3)`,
          [report.reported_player_id, reportId, admin.id]
        )
        captainRevoked = true
      }

      // Notify the reported player.
      const bodyLines = [`A grief report was upheld. You now have ${newStrikes} grief strike${newStrikes === 1 ? '' : 's'}.`]
      if (banUntil) {
        bodyLines.push(`Queue cooldown until ${new Date(banUntil).toLocaleString()}.`)
      } else if (cooldown?.action === 'ban') {
        bodyLines.push('Permanently banned from the queue.')
      } else if (cooldown?.action === 'warn') {
        bodyLines.push('This is a warning — no cooldown yet.')
      }
      if (captainRevoked) bodyLines.push('Captain status revoked.')
      const notificationId = await _insertStrikeNotification(client, {
        playerId: report.reported_player_id,
        type: 'inhouse_strike_grief',
        title: 'Grief strike +1',
        body: bodyLines.join(' '),
        link: '/queue',
        byAdminId: admin.id,
      })

      await client.query('COMMIT')

      io.to(`user:${report.reported_player_id}`).emit('inhouse:strikeApplied', {
        kind: 'grief',
        newStrikes,
        strikeDelta: 1,
        banUntil: banUntil ? new Date(banUntil).toISOString() : null,
        captainRevoked,
      })
      io.to(`user:${report.reported_player_id}`).emit('notification:new', { id: notificationId })
      io.to(`user:${report.reporter_player_id}`).emit('inhouse:griefReviewed', { reportId, status: 'approved' })
      io.to(`user:${report.reported_player_id}`).emit('inhouse:griefReviewed', { reportId, status: 'approved' })
      res.json({ ok: true, newStrikes, banUntil, captainRevoked })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch {}
      console.error('[inhouse grief approve]', e)
      res.status(500).json({ error: e.message })
    } finally {
      client.release()
    }
  })

  // ── Admin: reject a grief report ──
  router.post('/api/admin/inhouse/grief-reports/:id/reject', async (req, res) => {
    const admin = await getAuthPlayer(req)
    if (!admin) return res.status(401).json({ error: 'Not authenticated' })
    const allowed = admin.is_admin || await hasPermission(admin, 'review_grief_reports')
    if (!allowed) return res.status(403).json({ error: 'Permission denied' })
    const reportId = Number(req.params.id)
    const note = (req.body?.review_note || '').toString().trim() || null
    try {
      const updated = await queryOne(
        `UPDATE inhouse_grief_reports
            SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), review_note = $2
          WHERE id = $3 AND status = 'pending'
          RETURNING reporter_player_id, reported_player_id`,
        [admin.id, note, reportId]
      )
      if (!updated) return res.status(404).json({ error: 'Report not found or already reviewed' })
      io.to(`user:${updated.reporter_player_id}`).emit('inhouse:griefReviewed', { reportId, status: 'rejected' })
      io.to(`user:${updated.reported_player_id}`).emit('inhouse:griefReviewed', { reportId, status: 'rejected' })
      res.json({ ok: true })
    } catch (e) {
      console.error('[inhouse grief reject]', e)
      res.status(500).json({ error: e.message })
    }
  })

  return router
}
