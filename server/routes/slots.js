import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { playerInQueue, playerInReadyCheck } from '../socket/queueState.js'
import {
  BET_TIERS, LINES, PAYLINES, SYMBOLS, PAYTABLE, SCATTER, FREE_SPINS,
  AEGIS_ITEM_ID, AEGIS_NAME,
  rollGrid, evaluateAllLines, countScatter, scatterPay, resolveBonus,
} from './slotsMath.js'

// ── Gamble / pending-win state ────────────────────────────────────────────
// A winning spin is NOT banked immediately — it is held "pending" so the player
// can risk it on the red/black gamble. State is in-memory keyed by playerId
// (mirrors the per-player timer Maps in queueState.js). The bet is already
// debited+audited at spin time; the win (or 0, if gambled away) is banked at
// collect. NOTE: an un-collected pending win is lost on a hard server restart —
// acceptable for a casual in-queue minigame, and the auto-collect hooks
// (queue leave / modal close) keep the pending window short.
const pendingWins = new Map() // playerId -> { amount, steps, baseAmount, betTotal }
const gambleBusy = new Set()  // playerId — concurrency guard for gamble/collect

const GAMBLE_MAX_STEPS = 5
const GAMBLE_MAX_AMOUNT = 1_000_000

function canGamble(entry) {
  return !!entry && entry.amount > 0 && entry.steps < GAMBLE_MAX_STEPS && entry.amount * 2 <= GAMBLE_MAX_AMOUNT
}

function isSearching(playerId) {
  return playerInQueue.has(playerId) || playerInReadyCheck.has(playerId)
}

// Bank a player's pending win (atomic credit + audit). Deletes the entry
// synchronously before any await so concurrent callers can't double-bank.
async function bankPending(playerId) {
  const entry = pendingWins.get(playerId)
  if (!entry) return { collected: 0, balance: null }
  pendingWins.delete(playerId)
  const amt = entry.amount
  if (amt <= 0) return { collected: 0, balance: null }
  const upd = await query('UPDATE players SET gcoins = gcoins + $1 WHERE id = $2 RETURNING gcoins', [amt, playerId])
  const balance = upd[0]?.gcoins ?? null
  execute(
    'INSERT INTO gcoin_transactions (player_id, delta, reason, created_by) VALUES ($1, $2, $3, $4)',
    [playerId, amt, `slots: collect ${amt} (win ${entry.baseAmount}, ${entry.steps} gambles, bet ${entry.betTotal})`, playerId],
  ).catch(() => {})
  return { collected: amt, balance }
}

// Exported for the queue lifecycle hooks (leave / disconnect / ready-check):
// bank any pending win so it is never silently forfeited. Fire-and-forget safe.
export async function autoCollectPending(playerId) {
  try { if (pendingWins.has(playerId)) await bankPending(playerId) }
  catch (e) { console.error('[slots] autoCollectPending failed', playerId, e?.message) }
}

export default function createSlotsRouter(io) {
  const router = Router()

  // Public-ish: the client needs the paytable + paylines + caps to render.
  router.get('/api/slots/config', (req, res) => {
    res.json({
      betTiers: BET_TIERS,
      lines: LINES,
      paylines: PAYLINES,
      symbols: SYMBOLS.map(s => ({ key: s.key, heroId: s.heroId, tier: s.tier, pay: PAYTABLE[s.key] })),
      aegis: { itemId: AEGIS_ITEM_ID, name: AEGIS_NAME, scatter: SCATTER, freeSpins: FREE_SPINS },
      gamble: { maxSteps: GAMBLE_MAX_STEPS, maxAmount: GAMBLE_MAX_AMOUNT },
    })
  })

  // Spin for `bet` gcoins. Server-authoritative: rolls the 5×3 grid, evaluates
  // the 10 paylines + scatter, resolves the full free-spins bonus if triggered,
  // and holds the win pending for the gamble.
  router.post('/api/slots/spin', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    if (!isSearching(me.id)) {
      return res.status(403).json({ error: 'Slots are only available while searching for a match' })
    }

    const bet = Number(req.body?.bet)
    if (!BET_TIERS.includes(bet)) return res.status(400).json({ error: 'Invalid bet' })

    // Any leftover pending win from a previous round is banked first — never
    // silently overwritten or risked under a new stake.
    let autoCollected = 0
    if (pendingWins.has(me.id)) autoCollected = (await bankPending(me.id)).collected

    // Debit the stake atomically; the WHERE guard enforces no-negative-balance
    // under concurrent spins.
    const upd = await query(
      'UPDATE players SET gcoins = gcoins - $1 WHERE id = $2 AND gcoins >= $1 RETURNING gcoins',
      [bet, me.id],
    )
    if (upd.length === 0) return res.status(400).json({ error: 'Not enough gcoins' })
    const balance = upd[0].gcoins
    execute(
      'INSERT INTO gcoin_transactions (player_id, delta, reason, created_by) VALUES ($1, $2, $3, $4)',
      [me.id, -bet, `slots: bet ${bet}`, me.id],
    ).catch(() => {})

    const lineStake = bet / LINES
    const grid = rollGrid()
    const lineRes = evaluateAllLines(grid, lineStake)
    const scatter = countScatter(grid)
    const scPay = scatterPay(scatter.count, bet)
    const baseWin = lineRes.lineTotal + scPay

    const bonus = scatter.count >= 3 ? resolveBonus(bet, lineStake) : null
    const totalWin = baseWin + (bonus ? bonus.totalBonusPayout : 0)

    if (totalWin > 0) {
      pendingWins.set(me.id, { amount: totalWin, steps: 0, baseAmount: totalWin, betTotal: bet })
    }
    const entry = pendingWins.get(me.id)

    res.json({
      bet,
      lineStake,
      grid,
      lineWins: lineRes.lineWins,
      scatter,
      baseWin,
      bonus,
      totalWin,
      pendingWin: totalWin,
      canGamble: canGamble(entry),
      balance,
      autoCollected,
    })
  })

  // Risk the pending win on a red/black coin flip. Correct doubles it (up to the
  // caps), wrong loses it. Server decides the card; the client's guess only
  // picks a side. No balance change here — banking happens at /collect.
  router.post('/api/slots/gamble', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    if (!isSearching(me.id)) {
      return res.status(403).json({ error: 'Slots are only available while searching for a match' })
    }
    const guess = req.body?.guess
    if (guess !== 'red' && guess !== 'black') return res.status(400).json({ error: 'Invalid guess' })
    if (gambleBusy.has(me.id)) return res.status(409).json({ error: 'Gamble already in progress' })

    const entry = pendingWins.get(me.id)
    if (!entry || entry.amount <= 0) return res.status(400).json({ error: 'Nothing to gamble' })
    if (!canGamble(entry)) return res.status(400).json({ error: 'Gamble limit reached' })

    gambleBusy.add(me.id)
    try {
      const card = Math.random() < 0.5 ? 'red' : 'black'
      const won = card === guess
      if (won) { entry.amount *= 2; entry.steps += 1 }
      else { pendingWins.delete(me.id) }
      const cur = pendingWins.get(me.id)
      res.json({
        result: won ? 'win' : 'lose',
        card,
        amount: won ? entry.amount : 0,
        steps: won ? entry.steps : entry.steps,
        canGamble: canGamble(cur),
      })
    } finally {
      gambleBusy.delete(me.id)
    }
  })

  // Bank the pending win. Allowed even when no longer searching, so the queue
  // lifecycle hooks and the modal-close path can settle a win.
  router.post('/api/slots/collect', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    if (gambleBusy.has(me.id)) return res.status(409).json({ error: 'Gamble in progress' })

    const r = await bankPending(me.id)
    let balance = r.balance
    if (balance == null) {
      const row = await queryOne('SELECT gcoins FROM players WHERE id = $1', [me.id])
      balance = row?.gcoins ?? 0
    }
    res.json({ balance, collected: r.collected })
  })

  return router
}
