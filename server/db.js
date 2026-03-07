import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.NODE_ENV === 'production'
  ? join(__dirname, '..', 'data', 'draft.db')
  : join(__dirname, 'draft.db')
const db = new Database(dbPath)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS captains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    team TEXT NOT NULL,
    budget INTEGER NOT NULL DEFAULT 1000,
    status TEXT NOT NULL DEFAULT 'Waiting',
    password TEXT DEFAULT '',
    mmr INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    roles TEXT NOT NULL DEFAULT '[]',
    mmr INTEGER NOT NULL DEFAULT 0,
    info TEXT DEFAULT '',
    drafted INTEGER NOT NULL DEFAULT 0,
    drafted_by INTEGER DEFAULT NULL,
    draft_price INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (drafted_by) REFERENCES captains(id)
  );

  CREATE TABLE IF NOT EXISTS auction_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auction_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bid_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    captain_id INTEGER NOT NULL,
    captain_name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES players(id),
    FOREIGN KEY (captain_id) REFERENCES captains(id)
  );
`)

// Seed default settings if empty
const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get()
if (settingsCount.count === 0) {
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
  const defaults = {
    numberOfTeams: '8',
    playersPerTeam: '5',
    nominationTime: '180',
    bidTimer: '30',
    startingBudget: '1000',
    minimumBid: '10',
    bidIncrement: '5',
    maxBid: '0',
    nominationOrder: 'normal',
    requireAllOnline: 'true',
    adminPassword: 'admin',
  }
  for (const [key, value] of Object.entries(defaults)) {
    insertSetting.run(key, value)
  }
}

// Ensure adminPassword exists for existing databases
const hasAdminPw = db.prepare("SELECT 1 FROM settings WHERE key = 'adminPassword'").get()
if (!hasAdminPw) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('adminPassword', 'admin')").run()
}

// Ensure mmr column exists on captains for existing databases
try {
  db.prepare('SELECT mmr FROM captains LIMIT 1').get()
} catch {
  db.prepare('ALTER TABLE captains ADD COLUMN mmr INTEGER NOT NULL DEFAULT 0').run()
}

// Ensure draft_round column exists on players for existing databases
try {
  db.prepare('SELECT draft_round FROM players LIMIT 1').get()
} catch {
  db.prepare('ALTER TABLE players ADD COLUMN draft_round INTEGER DEFAULT NULL').run()
}

// Backfill draft_round from bid_history for already-drafted players missing it
db.prepare(`
  UPDATE players SET draft_round = (
    SELECT bh.round FROM bid_history bh
    WHERE bh.player_id = players.id
    ORDER BY bh.id DESC LIMIT 1
  )
  WHERE drafted = 1 AND draft_round IS NULL
`).run()

// Ensure is_admin column exists on captains for existing databases
try {
  db.prepare('SELECT is_admin FROM captains LIMIT 1').get()
} catch {
  db.prepare('ALTER TABLE captains ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0').run()
}

// Seed default captains if empty
const captainCount = db.prepare('SELECT COUNT(*) as count FROM captains').get()
if (captainCount.count === 0) {
  const insertCaptain = db.prepare('INSERT INTO captains (name, team, budget, status, password) VALUES (?, ?, ?, ?, ?)')
  const defaultCaptains = [
    ['Puppey', 'Team Secret', 1000, 'Ready', 'puppey123'],
    ['KuroKy', 'Nigma Galaxy', 1000, 'Ready', 'kuroky123'],
    ['N0tail', 'OG Esports', 1000, 'Ready', 'n0tail123'],
    ['Fly', 'Talon Esports', 1000, 'Ready', 'fly123'],
    ['Cr1t-', 'Team Liquid', 1000, 'Ready', 'crit123'],
    ['Misha', 'Team Spirit', 1000, 'Waiting', 'misha123'],
    ['xNova', 'Xtreme Gaming', 1000, 'Waiting', 'xnova123'],
    ['zai', 'Falcons Esports', 1000, 'Waiting', 'zai123'],
  ]
  for (const c of defaultCaptains) {
    insertCaptain.run(...c)
  }
}

// Seed default players if empty
const playerCount = db.prepare('SELECT COUNT(*) as count FROM players').get()
if (playerCount.count === 0) {
  const insertPlayer = db.prepare('INSERT INTO players (name, roles, mmr, info) VALUES (?, ?, ?, ?)')
  const defaultPlayers = [
    ['Miracle-', '["Carry","Mid"]', 11400, 'TI winner, versatile carry player'],
    ['Topson', '["Mid"]', 10800, '2x TI champion, aggressive mid'],
    ['Collapse', '["Offlane"]', 11100, 'TI winner, Mars specialist'],
    ['Yatoro', '["Carry"]', 11500, 'TI champion, ultra versatile'],
    ['Nisha', '["Mid"]', 10900, 'Consistent mid, Ember Spirit player'],
    ['Arteezy', '["Carry","Mid"]', 11200, 'Fan favorite, farming machine'],
    ['Faith_bian', '["Offlane"]', 10600, 'TI champion, clutch player'],
    ['Saksa', '["Support"]', 10200, 'Versatile pos 4 support'],
    ['Miposhka', '["Support"]', 10400, 'TI winner, pos 5 captain'],
    ['Ame', '["Carry"]', 11300, 'Top-tier carry, Spectre legend'],
  ]
  for (const p of defaultPlayers) {
    insertPlayer.run(...p)
  }
}

// Seed auction state if empty
const auctionCount = db.prepare('SELECT COUNT(*) as count FROM auction_state').get()
if (auctionCount.count === 0) {
  const insertState = db.prepare('INSERT INTO auction_state (key, value) VALUES (?, ?)')
  const defaults = {
    status: 'idle',
    currentRound: '0',
    totalRounds: '5',
    nominatorId: '',
    nominatedPlayerId: '',
    currentBid: '0',
    currentBidderId: '',
    bidTimerEnd: '0',
  }
  for (const [key, value] of Object.entries(defaults)) {
    insertState.run(key, value)
  }
}

export default db
