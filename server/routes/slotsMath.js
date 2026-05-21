// Pure slot-machine math for the Book of Ra-style "Hero Spin". No I/O — imported
// by both the HTTP router (server/routes/slots.js) and the RTP simulator
// (scripts/slots-rtp-sim.mjs) so production and the sim can never drift.
//
// Model: 5 reels × 3 rows, 10 fixed paylines. Each grid cell is rolled
// independently by symbol weight. The Aegis of the Immortal (a Dota item) is
// the special symbol: WILD (substitutes for any hero on a line, but never forms
// a line win as itself) + SCATTER (pays anywhere; 3+ triggers free spins).
//
// All payouts are integers: line wins pay `mult × lineStake` (lineStake =
// totalBet / LINES), scatter pays `mult × totalBet`. Tune via SYMBOL_WEIGHTS +
// PAYTABLE and re-run the RTP sim.

export const AEGIS = 'aegis'
export const AEGIS_ITEM_ID = 117
export const AEGIS_NAME = 'Aegis of the Immortal'

export const BET_TIERS = [10, 50, 100, 500] // total stake; lineStake = bet / LINES
export const FREE_SPINS = 10                // awarded per 3+ scatter trigger
const MAX_FREE_SPINS = 300                  // hard cap on the re-trigger loop

// Hero symbols (Aegis is handled separately). heroId is the Valve constant the
// client renders a portrait for; tier is cosmetic (paytable grouping).
export const SYMBOLS = [
  { key: 'meepo',            heroId: 82,  tier: 'high' }, // top symbol, pays from 2
  { key: 'invoker',          heroId: 74,  tier: 'high' },
  { key: 'broodmother',      heroId: 61,  tier: 'mid'  },
  { key: 'legion_commander', heroId: 104, tier: 'mid'  },
  { key: 'lina',             heroId: 25,  tier: 'low'  },
  { key: 'vengefulspirit',   heroId: 20,  tier: 'low'  },
  { key: 'pudge',            heroId: 14,  tier: 'low'  },
  { key: 'juggernaut',       heroId: 8,   tier: 'low'  },
]

// Per-line multipliers (× lineStake). Only the top symbol pays from 2.
// Tuned down from the design starting values to land RTP in ~[0.90, 0.95]
// (see scripts/slots-rtp-sim.mjs).
export const PAYTABLE = {
  meepo:            { 2: 2, 3: 18, 4: 140, 5: 700 },
  invoker:          { 3: 14, 4: 70, 5: 280 },
  broodmother:      { 3: 8,  4: 40, 5: 140 },
  legion_commander: { 3: 7,  4: 35, 5: 100 },
  lina:             { 3: 4,  4: 18, 5: 70  },
  vengefulspirit:   { 3: 4,  4: 14, 5: 50  },
  pudge:            { 3: 3,  4: 10, 5: 40  },
  juggernaut:       { 3: 3,  4: 10, 5: 40  },
}

// Scatter (Aegis) pay-anywhere multipliers on TOTAL bet. 3+ also triggers free spins.
export const SCATTER = { 3: 2, 4: 5, 5: 20 }

// Per-reel symbol weights (same strip on every reel). STARTING values — the RTP
// sim is the tuning surface. Lower aegis to cut the bonus trigger rate; lower
// top-tier x4/x5 to tame the expanding full-screen pay.
export const SYMBOL_WEIGHTS = {
  juggernaut: 24,
  pudge: 24,
  vengefulspirit: 20,
  lina: 18,
  legion_commander: 14,
  broodmother: 11,
  invoker: 7,
  meepo: 4,
  aegis: 5,
}

// 10 paylines. Each is the row index (0=top, 1=mid, 2=bottom) per reel, left→right.
export const PAYLINES = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [0, 1, 1, 1, 0],
]

export const LINES = PAYLINES.length
export const REELS = 5
export const ROWS = 3

const WEIGHT_KEYS = Object.keys(SYMBOL_WEIGHTS)
const TOTAL_WEIGHT = WEIGHT_KEYS.reduce((s, k) => s + SYMBOL_WEIGHTS[k], 0)

// Minimum matching reels for a symbol to pay (top symbol pays from 2).
export function minCount(sym) {
  return PAYTABLE[sym] && PAYTABLE[sym][2] != null ? 2 : 3
}

export function rollReel() {
  let r = Math.random() * TOTAL_WEIGHT
  for (const k of WEIGHT_KEYS) {
    r -= SYMBOL_WEIGHTS[k]
    if (r < 0) return k
  }
  return WEIGHT_KEYS[WEIGHT_KEYS.length - 1]
}

// grid[reel][row] — 5 columns of 3.
export function rollGrid() {
  const grid = []
  for (let reel = 0; reel < REELS; reel++) {
    grid.push([rollReel(), rollReel(), rollReel()])
  }
  return grid
}

function lineCells(grid, line) {
  return line.map((row, reel) => grid[reel][row])
}

function lineCandidate(cells) {
  for (const c of cells) if (c !== AEGIS) return c
  return null // all-wild line — never pays as a line (scatter handles Aegis)
}

// Evaluate all paylines. `skipSymbol` lets free spins exclude the expanded
// symbol so it isn't paid twice (expanded pays full-screen separately).
export function evaluateAllLines(grid, lineStake, skipSymbol = null) {
  const lineWins = []
  let lineTotal = 0
  for (let i = 0; i < PAYLINES.length; i++) {
    const cells = lineCells(grid, PAYLINES[i])
    const cand = lineCandidate(cells)
    if (!cand || cand === skipSymbol) continue
    let run = 0
    for (let r = 0; r < cells.length; r++) {
      if (cells[r] === cand || cells[r] === AEGIS) run++
      else break
    }
    if (run < minCount(cand)) continue
    const mult = PAYTABLE[cand][run] || 0
    if (mult <= 0) continue
    const amount = mult * lineStake
    const winCells = []
    for (let r = 0; r < run; r++) winCells.push({ reel: r, row: PAYLINES[i][r] })
    lineWins.push({ line: i, symbol: cand, count: run, amount, cells: winCells })
    lineTotal += amount
  }
  return { lineWins, lineTotal }
}

export function countScatter(grid) {
  const positions = []
  for (let reel = 0; reel < grid.length; reel++) {
    for (let row = 0; row < grid[reel].length; row++) {
      if (grid[reel][row] === AEGIS) positions.push({ reel, row })
    }
  }
  return { count: positions.length, positions }
}

export function scatterPay(count, totalBet) {
  return (SCATTER[count] || 0) * totalBet
}

// Number of reels (columns) that contain `sym` in any row.
export function countReelsContaining(grid, sym) {
  let n = 0
  for (let reel = 0; reel < grid.length; reel++) {
    if (grid[reel].includes(sym)) n++
  }
  return n
}

export function pickSpecial() {
  return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)].key
}

// Resolve an ENTIRE free-spins round server-side. Returns the per-spin sequence
// the client animates plus the total bonus payout. The expanding symbol fills
// its reels and pays full-screen (mult × lineStake × LINES) even on
// non-adjacent reels — the Book of Ra special-symbol rule.
export function resolveBonus(totalBet, lineStake, special = pickSpecial()) {
  let remaining = FREE_SPINS
  let bonusTotal = 0
  const spins = []
  let guard = 0
  while (remaining > 0 && guard < MAX_FREE_SPINS) {
    guard++
    remaining--
    const grid = rollGrid()
    const sc = countScatter(grid)
    const reels = countReelsContaining(grid, special)
    const expanded = reels >= minCount(special)
    const expandedPay = expanded ? (PAYTABLE[special][reels] || 0) * lineStake * LINES : 0
    const lineRes = evaluateAllLines(grid, lineStake, expanded ? special : null)
    const scPay = scatterPay(sc.count, totalBet)
    const retrigger = sc.count >= 3
    if (retrigger) remaining += FREE_SPINS
    const spinPay = lineRes.lineTotal + expandedPay + scPay
    bonusTotal += spinPay
    spins.push({
      grid,
      lineWins: lineRes.lineWins,
      scatter: sc,
      expanded,
      expandedReels: reels,
      expandedPay,
      scatterPay: scPay,
      retrigger,
      spinPay,
    })
  }
  return { specialSymbol: special, spins, totalBonusPayout: bonusTotal }
}
