// One-off Monte-Carlo RTP simulator for the Book of Ra-style Hero Spin.
// Imports the SAME math the server uses (server/routes/slotsMath.js) so the
// estimate matches production. Tune SYMBOL_WEIGHTS / PAYTABLE in slotsMath.js
// until RTP lands in ~[0.90, 0.95], then re-run.
//
// Usage:
//   node scripts/slots-rtp-sim.mjs --spins 5000000 --bet 100
//
// The gamble feature is a fair 50/50 double-or-nothing → EV-neutral, so it does
// not affect RTP and is intentionally not simulated.

import {
  LINES, rollGrid, evaluateAllLines, countScatter, scatterPay, resolveBonus,
} from '../server/routes/slotsMath.js'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] != null ? Number(process.argv[i + 1]) : def
}

const SPINS = arg('spins', 5_000_000)
const BET = arg('bet', 100)
const lineStake = BET / LINES

let staked = 0
let returned = 0
let baseReturned = 0
let bonusReturned = 0
let hits = 0          // spins with any base win
let triggers = 0      // spins that triggered free spins
let bonusPayoutSum = 0
let maxRound = 0

const t0 = Date.now()
for (let n = 0; n < SPINS; n++) {
  staked += BET
  const grid = rollGrid()
  const lineRes = evaluateAllLines(grid, lineStake)
  const sc = countScatter(grid)
  const scPay = scatterPay(sc.count, BET)
  const baseWin = lineRes.lineTotal + scPay

  let bonusWin = 0
  if (sc.count >= 3) {
    triggers++
    bonusWin = resolveBonus(BET, lineStake).totalBonusPayout
    bonusPayoutSum += bonusWin
  }

  const roundWin = baseWin + bonusWin
  if (baseWin > 0) hits++
  returned += roundWin
  baseReturned += baseWin
  bonusReturned += bonusWin
  if (roundWin > maxRound) maxRound = roundWin
}

const secs = (Date.now() - t0) / 1000
const pct = (x) => (x * 100).toFixed(2) + '%'

console.log(`\nBook of Ra Hero Spin — RTP simulation`)
console.log(`spins=${SPINS.toLocaleString()}  bet=${BET}  lineStake=${lineStake}  (${secs.toFixed(1)}s)\n`)
console.log(`RTP (total):        ${pct(returned / staked)}`)
console.log(`  base lines+scatter: ${pct(baseReturned / staked)}`)
console.log(`  free-spins bonus:   ${pct(bonusReturned / staked)}`)
console.log(`base hit frequency: ${pct(hits / SPINS)}`)
console.log(`free-spin trigger:  ${pct(triggers / SPINS)}  (1 in ${(SPINS / Math.max(triggers, 1)).toFixed(0)})`)
console.log(`avg bonus payout:   ${(bonusPayoutSum / Math.max(triggers, 1)).toFixed(0)} gcoins  (${(bonusPayoutSum / Math.max(triggers, 1) / BET).toFixed(1)}× bet)`)
console.log(`max single round:   ${maxRound.toLocaleString()} gcoins  (${(maxRound / BET).toFixed(0)}× bet)`)
