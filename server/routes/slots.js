import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { playerInQueue, playerInReadyCheck } from '../socket/queueState.js'

// ── Slot machine config ──────────────────────────────────────────────────
// All payouts are multipliers on the bet. Tune freely — the spin is computed
// server-side so clients can't fake a result. Rarer symbols pay more.
const BET_TIERS = [10, 50, 100, 500]

// Curated Dota 2 hero reel. heroId is the Valve constant the client renders a
// portrait for (via useDotaConstants). Rarer (lower weight) heroes pay more,
// with Meepo as the jackpot. Keeping it to 6 heroes keeps three-of-a-kind a
// realistic outcome.
const SYMBOLS = [
  { key: 'vengefulspirit',   heroId: 20,  name: 'Vengeful Spirit',   weight: 30, three: 5 },
  { key: 'lina',             heroId: 25,  name: 'Lina',              weight: 24, three: 8 },
  { key: 'legion_commander', heroId: 104, name: 'Legion Commander',  weight: 18, three: 12 },
  { key: 'broodmother',      heroId: 61,  name: 'Broodmother',       weight: 12, three: 20 },
  { key: 'invoker',          heroId: 74,  name: 'Invoker',           weight: 9,  three: 45 },
  { key: 'meepo',            heroId: 82,  name: 'Meepo',             weight: 6,  three: 100 },
]
// Two of the most common hero (Vengeful Spirit) — without a full three-of-a-
// kind — is a small consolation win.
const CONSOLATION_KEY = 'vengefulspirit'
const CONSOLATION_MULT = 2

const TOTAL_WEIGHT = SYMBOLS.reduce((s, x) => s + x.weight, 0)

function rollReel() {
  let r = Math.random() * TOTAL_WEIGHT
  for (const s of SYMBOLS) {
    r -= s.weight
    if (r < 0) return s.key
  }
  return SYMBOLS[SYMBOLS.length - 1].key
}

function payoutFor(reels, bet) {
  const [a, b, c] = reels
  if (a === b && b === c) {
    const sym = SYMBOLS.find(s => s.key === a)
    return bet * (sym ? sym.three : 0)
  }
  if (reels.filter(x => x === CONSOLATION_KEY).length === 2) return bet * CONSOLATION_MULT
  return 0
}

export default function createSlotsRouter(io) {
  const router = Router()

  // Public-ish: the client needs the bet tiers + paytable to render the UI.
  router.get('/api/slots/config', (req, res) => {
    res.json({
      betTiers: BET_TIERS,
      symbols: SYMBOLS.map(s => ({ key: s.key, heroId: s.heroId, name: s.name, three: s.three })),
      consolationKey: CONSOLATION_KEY,
      consolationMult: CONSOLATION_MULT,
    })
  })

  // Spin the slot machine for `bet` gcoins. Server-authoritative: it rolls the
  // reels, computes the payout, and applies the net change atomically.
  router.post('/api/slots/spin', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })

    // Queue-only feature — enforced on the server, not just the UI. The
    // short ready-check window counts as "still searching".
    if (!playerInQueue.has(me.id) && !playerInReadyCheck.has(me.id)) {
      return res.status(403).json({ error: 'Slots are only available while searching for a match' })
    }

    const bet = Number(req.body?.bet)
    if (!BET_TIERS.includes(bet)) return res.status(400).json({ error: 'Invalid bet' })

    const reels = [rollReel(), rollReel(), rollReel()]
    const payout = payoutFor(reels, bet)
    const net = payout - bet

    // Atomic + race-safe: only applies if the balance still covers the bet,
    // which also enforces the no-negative-balance rule under concurrent spins.
    const upd = await query(
      'UPDATE players SET gcoins = gcoins + $1 WHERE id = $2 AND gcoins >= $3 RETURNING gcoins',
      [net, me.id, bet],
    )
    if (upd.length === 0) return res.status(400).json({ error: 'Not enough gcoins' })
    const newBalance = upd[0].gcoins

    // Audit every spin as a single net row (mirrors the dotacoins log).
    execute(
      'INSERT INTO gcoin_transactions (player_id, delta, reason, created_by) VALUES ($1, $2, $3, $4)',
      [me.id, net, `slots: bet ${bet}, won ${payout} [${reels.join(',')}]`, me.id],
    ).catch(() => {})

    res.json({ reels, bet, payout, net, balance: newBalance, win: payout > 0 })
  })

  return router
}
