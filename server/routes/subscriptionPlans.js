import { Router } from 'express'
import fs from 'fs'
import { join } from 'path'
import sharp from 'sharp'
import { query, queryOne, execute, withTransaction } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { upload, uploadsDir } from '../middleware/upload.js'
import { discordBot } from '../services/discordBotClient.js'
import { getActiveSubscription } from '../helpers/subscription.js'

// Fire-and-forget: tell the Discord bot to grant/remove the Subscriber role.
// No-op when the player hasn't linked Discord; the bot client swallows outages.
function syncDiscordSubscriberRole(discordId, active, planName) {
  if (!discordId) return
  discordBot.emit('subscriptionChanged', { discordId, active, planName: planName || null })
}

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
      SELECT id, name, slug, description, price_cents, currency,
             price_dotacoins, duration_days,
             trial_enabled, trial_days, trial_max_concurrent,
             perks, badge_url, sort_order
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
             sp.price_dotacoins, sp.duration_days,
             sp.trial_enabled, sp.trial_days, sp.trial_max_concurrent,
             sp.perks, sp.badge_url, sp.is_active, sp.sort_order, sp.created_at, sp.updated_at,
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
    const { name, slug, description, price_cents, currency, price_dotacoins, duration_days, trial_enabled, trial_days, trial_max_concurrent, perks, is_active, sort_order } = req.body || {}
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' })
    const finalSlug = slug ? slugify(slug) : slugify(name)
    if (!finalSlug) return res.status(400).json({ error: 'slug could not be derived' })
    const priceCents = Number.isFinite(Number(price_cents)) ? Math.max(0, Math.floor(Number(price_cents))) : 0
    const priceDotacoins = Number.isFinite(Number(price_dotacoins)) ? Math.max(0, Math.floor(Number(price_dotacoins))) : 0
    const durationDays = Number.isFinite(Number(duration_days)) ? Math.max(1, Math.floor(Number(duration_days))) : 30
    const trialEnabled = trial_enabled === true
    const trialDays = Number.isFinite(Number(trial_days)) ? Math.max(1, Math.floor(Number(trial_days))) : 7
    const trialMaxConcurrent = Number.isFinite(Number(trial_max_concurrent)) ? Math.max(0, Math.floor(Number(trial_max_concurrent))) : 0
    const sortOrder = Number.isFinite(Number(sort_order)) ? Math.floor(Number(sort_order)) : 0
    try {
      const row = await queryOne(
        `INSERT INTO subscription_plans (name, slug, description, price_cents, currency, price_dotacoins, duration_days, trial_enabled, trial_days, trial_max_concurrent, perks, is_active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [String(name).trim(), finalSlug, description || null, priceCents, currency || 'EUR', priceDotacoins, durationDays, trialEnabled, trialDays, trialMaxConcurrent, perks || {}, is_active !== false, sortOrder]
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

    const { name, slug, description, price_cents, currency, price_dotacoins, duration_days, trial_enabled, trial_days, trial_max_concurrent, perks, is_active, sort_order } = req.body || {}
    const newName = name !== undefined ? String(name).trim() : existing.name
    if (!newName) return res.status(400).json({ error: 'name is required' })
    const newSlug = slug !== undefined ? slugify(slug) : existing.slug
    if (!newSlug) return res.status(400).json({ error: 'slug could not be derived' })
    const newPrice = price_cents !== undefined && Number.isFinite(Number(price_cents))
      ? Math.max(0, Math.floor(Number(price_cents))) : existing.price_cents
    const newPriceDotacoins = price_dotacoins !== undefined && Number.isFinite(Number(price_dotacoins))
      ? Math.max(0, Math.floor(Number(price_dotacoins))) : existing.price_dotacoins
    const newDurationDays = duration_days !== undefined && Number.isFinite(Number(duration_days))
      ? Math.max(1, Math.floor(Number(duration_days))) : existing.duration_days
    const newTrialEnabled = trial_enabled !== undefined ? !!trial_enabled : existing.trial_enabled
    const newTrialDays = trial_days !== undefined && Number.isFinite(Number(trial_days))
      ? Math.max(1, Math.floor(Number(trial_days))) : existing.trial_days
    const newTrialMaxConcurrent = trial_max_concurrent !== undefined && Number.isFinite(Number(trial_max_concurrent))
      ? Math.max(0, Math.floor(Number(trial_max_concurrent))) : existing.trial_max_concurrent
    const newSort = sort_order !== undefined && Number.isFinite(Number(sort_order))
      ? Math.floor(Number(sort_order)) : existing.sort_order

    try {
      await execute(
        `UPDATE subscription_plans
            SET name = $1, slug = $2, description = $3, price_cents = $4,
                currency = $5, price_dotacoins = $6, duration_days = $7,
                trial_enabled = $8, trial_days = $9, trial_max_concurrent = $10,
                perks = $11, is_active = $12, sort_order = $13,
                updated_at = NOW()
          WHERE id = $14`,
        [
          newName, newSlug,
          description !== undefined ? description : existing.description,
          newPrice,
          currency !== undefined ? currency : existing.currency,
          newPriceDotacoins,
          newDurationDays,
          newTrialEnabled,
          newTrialDays,
          newTrialMaxConcurrent,
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

  // ── Badge upload ────────────────────────────────────────
  // Resize to 64x64 PNG so layout next to avatars stays consistent regardless
  // of what the admin uploads. Old badge file is unlinked when replaced.
  router.post('/api/admin/subscription-plans/:id/badge', upload.single('badge'), async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid id' })
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return
    const plan = await queryOne('SELECT id, badge_url FROM subscription_plans WHERE id = $1', [id])
    if (!plan) return res.status(404).json({ error: 'plan not found' })
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' })

    const resizedFilename = `plan_badge_${id}_${Date.now()}.png`
    const resizedPath = join(uploadsDir, resizedFilename)
    await sharp(req.file.path)
      .resize(64, 64, { fit: 'cover', position: 'center' })
      .png()
      .toFile(resizedPath)
    if (req.file.path !== resizedPath) {
      try { fs.unlinkSync(req.file.path) } catch {}
    }

    if (plan.badge_url) {
      const oldPath = join(uploadsDir, plan.badge_url.replace('/uploads/', ''))
      try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath) } catch {}
    }

    const badgeUrl = `/uploads/${resizedFilename}`
    await execute(
      'UPDATE subscription_plans SET badge_url = $1, updated_at = NOW() WHERE id = $2',
      [badgeUrl, id]
    )
    res.json({ badge_url: badgeUrl })
  })

  router.delete('/api/admin/subscription-plans/:id/badge', async (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid id' })
    const admin = await requirePermission(req, res, 'manage_subscription_plans')
    if (!admin) return
    const plan = await queryOne('SELECT id, badge_url FROM subscription_plans WHERE id = $1', [id])
    if (!plan) return res.status(404).json({ error: 'plan not found' })
    if (plan.badge_url) {
      const oldPath = join(uploadsDir, plan.badge_url.replace('/uploads/', ''))
      try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath) } catch {}
    }
    await execute('UPDATE subscription_plans SET badge_url = NULL, updated_at = NOW() WHERE id = $1', [id])
    res.json({ ok: true })
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

    const plan = await queryOne('SELECT id, name FROM subscription_plans WHERE id = $1', [id])
    if (!plan) return res.status(404).json({ error: 'plan not found' })

    const { player_id, expires_at } = req.body || {}
    const playerId = Number(player_id)
    if (!playerId) return res.status(400).json({ error: 'player_id is required' })

    const player = await queryOne('SELECT id, discord_id FROM players WHERE id = $1', [playerId])
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
      // Now active → grant the Subscriber Discord role. A prior plan was just
      // cancelled above, but the role is plan-agnostic so re-granting is a no-op.
      syncDiscordSubscriberRole(player.discord_id, true, plan.name)
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
      'SELECT id, plan_id, player_id, status FROM user_subscriptions WHERE id = $1',
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

    // Only strip the Discord role if the player has no other active subscription
    // (defensive — the partial unique index allows one, but stay correct).
    const stillActive = await queryOne(
      `SELECT 1 FROM user_subscriptions
        WHERE player_id = $1 AND status = 'active'
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1`,
      [sub.player_id]
    )
    if (!stillActive) {
      const player = await queryOne('SELECT discord_id FROM players WHERE id = $1', [sub.player_id])
      syncDiscordSubscriberRole(player?.discord_id, false)
    }
    res.json({ ok: true })
  })

  // ── Self-serve (player) subscription with dotacoins ──────────────────────
  // Players buy/cancel their own subscription from the /subscription page.
  // Plans are charged in dotacoins (the in-site currency) and auto-renew every
  // plan.duration_days via the renew_dotacoin_subscriptions background job.

  // Current player's active subscription (full detail for the /subscription
  // page: auto_renew, expires_at, the plan's price + period) plus live balance.
  router.get('/api/me/subscription', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    const sub = await queryOne(`
      SELECT us.id AS subscription_id, us.status, us.source, us.auto_renew,
             us.started_at, us.expires_at, us.cancelled_at,
             sp.id AS plan_id, sp.name AS plan_name, sp.slug AS plan_slug,
             sp.badge_url AS plan_badge_url, sp.perks AS plan_perks,
             sp.price_dotacoins, sp.duration_days
        FROM user_subscriptions us
        JOIN subscription_plans sp ON sp.id = us.plan_id
       WHERE us.player_id = $1
         AND us.status = 'active'
         AND (us.expires_at IS NULL OR us.expires_at > NOW())
       LIMIT 1
    `, [player.id])
    const me = await queryOne('SELECT dotacoins FROM players WHERE id = $1', [player.id])

    // Trial state for rendering Try buttons on the /subscription page:
    //  - used_plan_ids: plans this player has already trialed (any status), so
    //    the once-per-plan rule can be reflected in the UI.
    //  - active_counts: how many players currently hold an active (non-expired)
    //    trial per plan, so a plan whose seat cap is full shows as unavailable.
    const trialedRows = await query(
      `SELECT DISTINCT plan_id FROM user_subscriptions
        WHERE player_id = $1 AND source = 'trial'`,
      [player.id]
    )
    const trialCountRows = await query(
      `SELECT plan_id, COUNT(*)::int AS n
         FROM user_subscriptions
        WHERE source = 'trial' AND status = 'active' AND expires_at > NOW()
        GROUP BY plan_id`
    )
    const activeCounts = {}
    for (const r of trialCountRows) activeCounts[r.plan_id] = r.n

    res.json({
      subscription: sub,
      dotacoins: me?.dotacoins || 0,
      trial: {
        used_plan_ids: trialedRows.map(r => r.plan_id),
        active_counts: activeCounts,
      },
    })
  })

  // Start a free trial of a trial-enabled plan. No charge; grants the plan's
  // perks for trial_days. Guarded by three rules, all re-checked server-side:
  //  1. Eligibility — the player must have no active subscription (matches the
  //     one-active-row unique index; a trial would otherwise collide).
  //  2. Once per plan — a prior trial row for this plan (any status) blocks a
  //     re-try. Also enforced by the partial unique index as a race backstop.
  //  3. Seat cap — at most trial_max_concurrent players may hold an active
  //     trial of this plan at once (0 = unlimited). A slot frees once a trial
  //     passes its expires_at, so the count only includes non-expired rows.
  // The plan row is locked FOR UPDATE so concurrent trial starts on the same
  // plan are serialized and can't overshoot the cap.
  router.post('/api/me/subscription/trial', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    const planId = Number(req.body?.plan_id)
    if (!planId) return res.status(400).json({ error: 'plan_id is required' })

    let result
    try {
      result = await withTransaction(async (c) => {
        const planRes = await c.query(
          `SELECT id, name, is_active, trial_enabled, trial_days, trial_max_concurrent
             FROM subscription_plans WHERE id = $1 FOR UPDATE`,
          [planId]
        )
        const plan = planRes.rows[0]
        if (!plan || !plan.is_active) { const e = new Error('plan'); e.code = 'NOTFOUND'; throw e }
        if (!plan.trial_enabled) { const e = new Error('no trial'); e.code = 'NO_TRIAL'; throw e }

        // 1. No active subscription already.
        const active = await c.query(
          `SELECT 1 FROM user_subscriptions
            WHERE player_id = $1 AND status = 'active'
              AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 1`,
          [player.id]
        )
        if (active.rowCount) { const e = new Error('has sub'); e.code = 'HAS_SUB'; throw e }

        // 2. Hasn't trialed this plan before.
        const used = await c.query(
          `SELECT 1 FROM user_subscriptions
            WHERE player_id = $1 AND plan_id = $2 AND source = 'trial' LIMIT 1`,
          [player.id, planId]
        )
        if (used.rowCount) { const e = new Error('used'); e.code = 'TRIAL_USED'; throw e }

        // 3. Seat cap not full.
        const cap = Math.max(0, Math.floor(Number(plan.trial_max_concurrent) || 0))
        if (cap > 0) {
          const cnt = await c.query(
            `SELECT COUNT(*)::int AS n FROM user_subscriptions
              WHERE plan_id = $1 AND source = 'trial' AND status = 'active'
                AND expires_at > NOW()`,
            [planId]
          )
          if (cnt.rows[0].n >= cap) { const e = new Error('full'); e.code = 'TRIAL_FULL'; throw e }
        }

        const days = Math.max(1, Math.floor(Number(plan.trial_days) || 7))
        const inserted = await c.query(
          `INSERT INTO user_subscriptions (player_id, plan_id, status, source, auto_renew, expires_at)
           VALUES ($1, $2, 'active', 'trial', FALSE, NOW() + ($3 || ' days')::interval)
           RETURNING *`,
          [player.id, planId, String(days)]
        )
        return { sub: inserted.rows[0], planName: plan.name }
      })
    } catch (e) {
      if (e.code === 'NOTFOUND') return res.status(404).json({ error: 'plan not available' })
      if (e.code === 'NO_TRIAL') return res.status(400).json({ error: 'this plan has no trial' })
      if (e.code === 'HAS_SUB') return res.status(409).json({ error: 'You already have an active subscription' })
      if (e.code === 'TRIAL_USED') return res.status(409).json({ error: 'You have already used your trial for this plan' })
      if (e.code === 'TRIAL_FULL') return res.status(409).json({ error: 'All trial slots are currently in use — try again later' })
      // Unique index race: a concurrent request already created the trial row.
      if (e.code === '23505') return res.status(409).json({ error: 'You have already used your trial for this plan' })
      throw e
    }

    // Active now → grant the Subscriber Discord role (after commit). The
    // trial-expiration sweep strips it again once expires_at passes.
    const acct = await queryOne('SELECT discord_id FROM players WHERE id = $1', [player.id])
    syncDiscordSubscriberRole(acct?.discord_id, true, result.planName)
    res.status(201).json({ ok: true, subscription: result.sub })
  })

  // Subscribe to (or switch to) a plan, paying its price_dotacoins up front.
  // Atomic: the balance is deducted with a conditional UPDATE that guards
  // against going negative even under concurrent spends, an audit row is
  // written to dotacoin_transactions, any prior active sub is cancelled, and a
  // new auto-renewing row is inserted — all in one transaction.
  router.post('/api/me/subscription', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    const planId = Number(req.body?.plan_id)
    if (!planId) return res.status(400).json({ error: 'plan_id is required' })

    const plan = await queryOne(
      'SELECT id, name, price_dotacoins, duration_days, is_active FROM subscription_plans WHERE id = $1',
      [planId]
    )
    if (!plan || !plan.is_active) return res.status(404).json({ error: 'plan not available' })
    const price = Math.max(0, Math.floor(Number(plan.price_dotacoins) || 0))
    if (price <= 0) return res.status(400).json({ error: 'this plan is not purchasable with dotacoins' })
    const durationDays = Math.max(1, Math.floor(Number(plan.duration_days) || 30))

    // Block re-buying the plan you're already on (would just charge again).
    const current = await getActiveSubscription(player.id)
    if (current && current.plan_id === planId) {
      return res.status(409).json({ error: 'You are already subscribed to this plan' })
    }

    let result
    try {
      result = await withTransaction(async (c) => {
        const deducted = await c.query(
          `UPDATE players SET dotacoins = dotacoins - $2
            WHERE id = $1 AND dotacoins >= $2
            RETURNING dotacoins`,
          [player.id, price]
        )
        if (deducted.rowCount === 0) {
          const err = new Error('insufficient dotacoins'); err.code = 'INSUFFICIENT'; throw err
        }
        await c.query(
          `INSERT INTO dotacoin_transactions (player_id, delta, reason, created_by)
           VALUES ($1, $2, $3, $1)`,
          [player.id, -price, `Subscription: ${plan.name}`]
        )
        await c.query(
          `UPDATE user_subscriptions
              SET status = 'cancelled', cancelled_at = NOW(), auto_renew = FALSE, updated_at = NOW()
            WHERE player_id = $1 AND status = 'active'`,
          [player.id]
        )
        const subRow = await c.query(
          `INSERT INTO user_subscriptions (player_id, plan_id, status, source, auto_renew, expires_at)
           VALUES ($1, $2, 'active', 'dotacoins', TRUE, NOW() + ($3 || ' days')::interval)
           RETURNING *`,
          [player.id, planId, String(durationDays)]
        )
        return { newBalance: deducted.rows[0].dotacoins, sub: subRow.rows[0] }
      })
    } catch (e) {
      if (e.code === 'INSUFFICIENT') return res.status(400).json({ error: 'Not enough dotacoins for this plan' })
      if (e.code === '23505') return res.status(409).json({ error: 'You already have an active subscription' })
      throw e
    }

    // Now active → grant the Subscriber Discord role (after commit).
    const acct = await queryOne('SELECT discord_id FROM players WHERE id = $1', [player.id])
    syncDiscordSubscriberRole(acct?.discord_id, true, plan.name)
    res.status(201).json({ ok: true, dotacoins: result.newBalance, subscription: result.sub })
  })

  // Cancel: turn off auto-renew but keep access (and perks) until the current
  // period's expires_at. No refund. The renewal job lapses it (status ->
  // 'expired') and strips the Discord role once expires_at passes.
  router.delete('/api/me/subscription', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Not authenticated' })
    const sub = await queryOne(
      `SELECT id, expires_at, auto_renew FROM user_subscriptions
        WHERE player_id = $1 AND status = 'active' AND source = 'dotacoins'
        LIMIT 1`,
      [player.id]
    )
    if (!sub) return res.status(404).json({ error: 'No active dotacoins subscription to cancel' })
    if (!sub.auto_renew) return res.status(409).json({ error: 'Auto-renew is already off' })
    await execute(
      `UPDATE user_subscriptions SET auto_renew = FALSE, updated_at = NOW() WHERE id = $1`,
      [sub.id]
    )
    res.json({ ok: true, expires_at: sub.expires_at })
  })

  return router
}
