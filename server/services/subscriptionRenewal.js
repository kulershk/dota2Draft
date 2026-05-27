import { query, queryOne, execute, withTransaction } from '../db.js'
import { discordBot } from './discordBotClient.js'

// Re-charge / lapse auto-renewing dotacoins subscriptions. Registered as the
// recurring `renew_dotacoin_subscriptions` job (server/index.js), run hourly.
//
// Idempotent: it only acts on subs whose expires_at has passed, and every
// action moves the row out of that set — a renewal pushes expires_at forward,
// a lapse flips status to 'expired'. So repeated ticks, restarts, and a job
// that was down for a while all converge without double-charging (a successful
// renewal always sets expires_at = NOW() + duration, never catching up).
//
// Only source = 'dotacoins' rows are touched; admin-assigned ('manual') subs —
// which keep auto_renew = FALSE and usually expires_at = NULL — are never
// affected here.
export async function runDotacoinRenewals(io) {
  const due = await query(`
    SELECT us.id, us.player_id, us.plan_id, us.auto_renew,
           sp.name AS plan_name, sp.price_dotacoins, sp.duration_days,
           p.dotacoins, p.discord_id
      FROM user_subscriptions us
      JOIN subscription_plans sp ON sp.id = us.plan_id
      JOIN players p ON p.id = us.player_id
     WHERE us.status = 'active'
       AND us.source = 'dotacoins'
       AND us.expires_at IS NOT NULL
       AND us.expires_at <= NOW()
     ORDER BY us.id ASC
  `)

  let renewed = 0
  let lapsed = 0
  for (const row of due) {
    const price = Math.max(0, Math.floor(Number(row.price_dotacoins) || 0))
    const durationDays = Math.max(1, Math.floor(Number(row.duration_days) || 30))
    const canRenew = row.auto_renew && (price === 0 || Number(row.dotacoins) >= price)

    if (canRenew) {
      try {
        await withTransaction(async (c) => {
          if (price > 0) {
            // Conditional deduction guards against a balance that dropped since
            // the SELECT (concurrent spend) — rowCount 0 means lapse instead.
            const deducted = await c.query(
              `UPDATE players SET dotacoins = dotacoins - $2
                WHERE id = $1 AND dotacoins >= $2 RETURNING dotacoins`,
              [row.player_id, price]
            )
            if (deducted.rowCount === 0) { const e = new Error('insufficient'); e.code = 'INSUFFICIENT'; throw e }
            await c.query(
              `INSERT INTO dotacoin_transactions (player_id, delta, reason, created_by)
               VALUES ($1, $2, $3, NULL)`,
              [row.player_id, -price, `Subscription renewal: ${row.plan_name}`]
            )
          }
          await c.query(
            `UPDATE user_subscriptions
                SET expires_at = NOW() + ($2 || ' days')::interval, updated_at = NOW()
              WHERE id = $1 AND status = 'active'`,
            [row.id, String(durationDays)]
          )
        })
        renewed++
        continue
      } catch (e) {
        if (e.code !== 'INSUFFICIENT') {
          // Transient DB error — leave the row due so the next tick retries it.
          console.error('[sub-renew] renewal failed for sub', row.id, e?.message)
          continue
        }
        // Balance changed under us → fall through and lapse it.
      }
    }

    // Lapse: auto-renew is off, or there aren't enough dotacoins to renew.
    await execute(
      `UPDATE user_subscriptions SET status = 'expired', updated_at = NOW()
        WHERE id = $1 AND status = 'active'`,
      [row.id]
    )
    lapsed++

    // Strip the Subscriber Discord role (the partial unique index guarantees no
    // other active sub exists for this player).
    if (row.discord_id) {
      try { discordBot.emit('subscriptionChanged', { discordId: row.discord_id, active: false, planName: null }) } catch {}
    }

    // Tell the player their subscription ended. Insert first, then emit the
    // refetch trigger (the row must be visible when the client refetches).
    try {
      const lostToFunds = row.auto_renew
      const title = lostToFunds
        ? `Your ${row.plan_name} subscription lapsed`
        : `Your ${row.plan_name} subscription ended`
      const body = lostToFunds
        ? 'Not enough dotacoins to renew it. You can resubscribe anytime from your profile.'
        : 'Auto-renew was off, so it was not renewed. You can resubscribe anytime from your profile.'
      const notif = await queryOne(
        `INSERT INTO notifications (recipient_id, type, title, body, link)
         VALUES ($1, 'subscription_lapsed', $2, $3, '/subscription') RETURNING id`,
        [row.player_id, title, body]
      )
      io?.to(`user:${row.player_id}`).emit('notification:new', { id: notif.id })
    } catch (e) {
      console.error('[sub-renew] lapse notify failed for player', row.player_id, e?.message)
    }
  }

  return { due: due.length, renewed, lapsed }
}
