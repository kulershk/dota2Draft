import { query, queryOne } from '../db.js'

// Perk keys live in subscription_plans.perks JSONB. Keep them as constants so
// typos at the call site fail fast instead of silently returning false.
//
// Most perks are booleans (hasPerk). GCOIN_MULTIPLIER is the exception: its
// value is a NUMBER (e.g. 5 = 5× gcoins per queue match), read via
// getGcoinMultipliers — not hasPerk, which only tests `=== true`.
export const PERK = {
  AUTO_REQUEUE: 'auto_requeue',
  PROFILE_BANNER: 'profile_banner',
  GCOIN_MULTIPLIER: 'gcoin_multiplier',
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

// Batch lookup of the gcoin payout multiplier for a set of players, used by the
// queue match payout (server/services/botPool.js) so a single match's payout
// can be split per subscriber without one query per player. Returns a
// Map<playerId, multiplier> containing ONLY players whose active plan sets a
// gcoin_multiplier > 1 — callers default any missing id to 1×.
export async function getGcoinMultipliers(playerIds) {
  const out = new Map()
  if (!playerIds?.length) return out
  const rows = await query(`
    SELECT us.player_id,
           sp.perks->>'gcoin_multiplier' AS mult
      FROM user_subscriptions us
      JOIN subscription_plans sp ON sp.id = us.plan_id
     WHERE us.player_id = ANY($1::int[])
       AND us.status = 'active'
       AND (us.expires_at IS NULL OR us.expires_at > NOW())
  `, [playerIds])
  for (const r of rows) {
    const m = Number(r.mult)
    if (Number.isFinite(m) && m > 1) out.set(r.player_id, m)
  }
  return out
}

// Lightweight projection of just the badge for embedding in player rows
// returned to the client. Returns null when the player has no active sub or
// the plan has no badge image uploaded.
export async function getSubscriptionBadgeUrl(playerId) {
  const sub = await getActiveSubscription(playerId)
  return sub?.plan_badge_url || null
}
