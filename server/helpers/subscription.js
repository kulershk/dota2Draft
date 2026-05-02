import { queryOne } from '../db.js'

// Perk keys live in subscription_plans.perks JSONB. Keep them as constants so
// typos at the call site fail fast instead of silently returning false.
export const PERK = {
  AUTO_REQUEUE: 'auto_requeue',
}

// TODO: when payment integration lands, also gate by `expires_at IS NULL OR
// expires_at > NOW()`. For now active manual rows are open-ended and the
// admin UI exposes expires_at if a temporary perk is desired.
export async function getActiveSubscription(playerId) {
  if (!playerId) return null
  return queryOne(`
    SELECT us.id          AS subscription_id,
           us.player_id,
           us.status,
           us.source,
           us.expires_at,
           sp.id          AS plan_id,
           sp.name        AS plan_name,
           sp.slug        AS plan_slug,
           sp.badge_url   AS plan_badge_url,
           sp.perks       AS plan_perks
      FROM user_subscriptions us
      JOIN subscription_plans sp ON sp.id = us.plan_id
     WHERE us.player_id = $1
       AND us.status = 'active'
       AND (us.expires_at IS NULL OR us.expires_at > NOW())
     LIMIT 1
  `, [playerId])
}

export async function hasPerk(playerId, perkKey) {
  const sub = await getActiveSubscription(playerId)
  if (!sub) return false
  const perks = sub.plan_perks || {}
  return perks[perkKey] === true
}

// Lightweight projection of just the badge for embedding in player rows
// returned to the client. Returns null when the player has no active sub or
// the plan has no badge image uploaded.
export async function getSubscriptionBadgeUrl(playerId) {
  const sub = await getActiveSubscription(playerId)
  return sub?.plan_badge_url || null
}
