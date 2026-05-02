import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'

function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export default function createSubscriptionPlansRouter() {
  const router = Router()

  // Public: list active plans for the future pricing page. Subscriber count
  // only included for admin views below — public list omits it.
  router.get('/api/subscription-plans', async (_req, res) => {
    const rows = await query(`
      SELECT id, name, slug, description, price_cents, currency, perks, sort_order
        FROM subscription_plans
       WHERE is_active = TRUE
       ORDER BY sort_order ASC, id ASC
    `)
    res.json(rows)
  })

  // Admin: full list (incl. inactive) with active subscriber counts.
  router.get('/api/admin/subscription-plans', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return
    const rows = await query(`
      SELECT sp.id, sp.name, sp.slug, sp.description, sp.price_cents, sp.currency,
             sp.perks, sp.is_active, sp.sort_order, sp.created_at, sp.updated_at,
             COALESCE(c.active_count, 0) AS active_subscriber_count
        FROM subscription_plans sp
        LEFT JOIN (
          SELECT plan_id, COUNT(*)::int AS active_count
            FROM user_subscriptions
           WHERE status = 'active'
           GROUP BY plan_id
        ) c ON c.plan_id = sp.id
       ORDER BY sp.sort_order ASC, sp.id ASC
    `)
    res.json(rows)
  })

  router.post('/api/admin/subscription-plans', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return
    const { name, slug, description, price_cents, currency, perks, is_active, sort_order } = req.body || {}
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' })
    const finalSlug = slug ? slugify(slug) : slugify(name)
    if (!finalSlug) return res.status(400).json({ error: 'slug could not be derived' })
    const priceCents = Number.isFinite(Number(price_cents)) ? Math.max(0, Math.floor(Number(price_cents))) : 0
    const sortOrder = Number.isFinite(Number(sort_order)) ? Math.floor(Number(sort_order)) : 0
    try {
      const row = await queryOne(
        `INSERT INTO subscription_plans (name, slug, description, price_cents, currency, perks, is_active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [String(name).trim(), finalSlug, description || null, priceCents, currency || 'EUR', perks || {}, is_active !== false, sortOrder]
      )
      res.status(201).json(row)
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: `slug "${finalSlug}" is already used` })
      throw e
    }
  })

  router.put('/api/admin/subscription-plans/:id', async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid id' })
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return
    const existing = await queryOne('SELECT * FROM subscription_plans WHERE id = $1', [id])
    if (!existing) return res.status(404).json({ error: 'plan not found' })

    const { name, slug, description, price_cents, currency, perks, is_active, sort_order } = req.body || {}
    const newName = name !== undefined ? String(name).trim() : existing.name
    if (!newName) return res.status(400).json({ error: 'name is required' })
    const newSlug = slug !== undefined ? slugify(slug) : existing.slug
    if (!newSlug) return res.status(400).json({ error: 'slug could not be derived' })
    const newPrice = price_cents !== undefined && Number.isFinite(Number(price_cents))
      ? Math.max(0, Math.floor(Number(price_cents))) : existing.price_cents
    const newSort = sort_order !== undefined && Number.isFinite(Number(sort_order))
      ? Math.floor(Number(sort_order)) : existing.sort_order

    try {
      await execute(
        `UPDATE subscription_plans
            SET name = $1, slug = $2, description = $3, price_cents = $4,
                currency = $5, perks = $6, is_active = $7, sort_order = $8,
                updated_at = NOW()
          WHERE id = $9`,
        [
          newName, newSlug,
          description !== undefined ? description : existing.description,
          newPrice,
          currency !== undefined ? currency : existing.currency,
          perks !== undefined ? perks : existing.perks,
          is_active !== undefined ? !!is_active : existing.is_active,
          newSort,
          id,
        ]
      )
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: `slug "${newSlug}" is already used` })
      throw e
    }
    const updated = await queryOne('SELECT * FROM subscription_plans WHERE id = $1', [id])
    res.json(updated)
  })

  // Hard delete only when no subscribers ever existed; otherwise the FK with
  // ON DELETE RESTRICT will refuse and the admin should set is_active = FALSE
  // via PUT instead.
  router.delete('/api/admin/subscription-plans/:id', async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid id' })
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return
    try {
      await execute('DELETE FROM subscription_plans WHERE id = $1', [id])
      res.json({ ok: true })
    } catch (e) {
      if (e.code === '23503') return res.status(409).json({ error: 'plan has subscriber history; mark inactive instead of deleting' })
      throw e
    }
  })

  // ── Subscribers ──────────────────────────────────────────
  router.get('/api/admin/subscription-plans/:id/subscribers', async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid id' })
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return
    const rows = await query(`
      SELECT us.id, us.player_id, us.status, us.source, us.external_id,
             us.started_at, us.expires_at, us.cancelled_at,
             p.name AS player_name, p.display_name AS player_display_name,
             p.avatar_url AS player_avatar_url, p.steam_id AS player_steam_id
        FROM user_subscriptions us
        JOIN players p ON p.id = us.player_id
       WHERE us.plan_id = $1
       ORDER BY us.status = 'active' DESC, us.started_at DESC
    `, [id])
    res.json(rows)
  })

  router.post('/api/admin/subscription-plans/:id/subscribers', async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid id' })
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return

    const plan = await queryOne('SELECT id FROM subscription_plans WHERE id = $1', [id])
    if (!plan) return res.status(404).json({ error: 'plan not found' })

    const { player_id, expires_at } = req.body || {}
    const playerId = Number(player_id)
    if (!playerId) return res.status(400).json({ error: 'player_id is required' })

    const player = await queryOne('SELECT id FROM players WHERE id = $1', [playerId])
    if (!player) return res.status(404).json({ error: 'player not found' })

    const expiresAt = expires_at ? new Date(expires_at) : null
    if (expires_at && (!expiresAt || isNaN(expiresAt.getTime()))) {
      return res.status(400).json({ error: 'invalid expires_at' })
    }

    // Cancel any existing active subscription on a different plan first — the
    // partial unique index allows only one active row per player.
    await execute(
      `UPDATE user_subscriptions
          SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE player_id = $1 AND status = 'active'`,
      [playerId]
    )

    try {
      const row = await queryOne(
        `INSERT INTO user_subscriptions (player_id, plan_id, status, source, expires_at)
         VALUES ($1, $2, 'active', 'manual', $3) RETURNING *`,
        [playerId, id, expiresAt]
      )
      res.status(201).json(row)
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'player already has an active subscription' })
      throw e
    }
  })

  // Cancel an active subscriber row (keeps history). Path uses the
  // user_subscriptions.id so an admin can target one specific row even when
  // there are stale cancelled rows for the same player.
  router.delete('/api/admin/subscription-plans/:planId/subscribers/:subscriptionId', async (req, res) => {
    const planId = Number(req.params.planId)
    const subscriptionId = Number(req.params.subscriptionId)
    if (!planId || !subscriptionId) return res.status(400).json({ error: 'invalid id' })
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return

    const sub = await queryOne(
      'SELECT id, plan_id, status FROM user_subscriptions WHERE id = $1',
      [subscriptionId]
    )
    if (!sub) return res.status(404).json({ error: 'subscription not found' })
    if (sub.plan_id !== planId) return res.status(400).json({ error: 'subscription does not belong to this plan' })

    await execute(
      `UPDATE user_subscriptions
          SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [subscriptionId]
    )
    res.json({ ok: true })
  })

  return router
}
