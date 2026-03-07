import pg from 'pg'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/draft'
})

// Helpers
export async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params)
  return rows
}

export async function queryOne(sql, params = []) {
  const { rows } = await pool.query(sql, params)
  return rows[0] || null
}

export async function execute(sql, params = []) {
  return await pool.query(sql, params)
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS captains (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      team TEXT NOT NULL,
      budget INTEGER NOT NULL DEFAULT 1000,
      status TEXT NOT NULL DEFAULT 'Waiting',
      password TEXT DEFAULT '',
      mmr INTEGER NOT NULL DEFAULT 0,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      roles TEXT NOT NULL DEFAULT '[]',
      mmr INTEGER NOT NULL DEFAULT 0,
      info TEXT DEFAULT '',
      drafted INTEGER NOT NULL DEFAULT 0,
      drafted_by INTEGER DEFAULT NULL REFERENCES captains(id) ON DELETE SET NULL,
      draft_price INTEGER DEFAULT NULL,
      draft_round INTEGER DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auction_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS auction_log (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bid_history (
      id SERIAL PRIMARY KEY,
      round INTEGER NOT NULL,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
      captain_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `)

  // Seed default settings if empty
  const settingsCount = await queryOne('SELECT COUNT(*) as count FROM settings')
  if (parseInt(settingsCount.count) === 0) {
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
      allowSteamRegistration: 'true',
      adminPassword: 'admin',
    }
    for (const [key, value] of Object.entries(defaults)) {
      await execute('INSERT INTO settings (key, value) VALUES ($1, $2)', [key, value])
    }
  }

  // Ensure adminPassword exists
  const hasAdminPw = await queryOne("SELECT 1 FROM settings WHERE key = 'adminPassword'")
  if (!hasAdminPw) {
    await execute("INSERT INTO settings (key, value) VALUES ('adminPassword', 'admin')")
  }

  // Seed auction state if empty
  const auctionCount = await queryOne('SELECT COUNT(*) as count FROM auction_state')
  if (parseInt(auctionCount.count) === 0) {
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
      await execute('INSERT INTO auction_state (key, value) VALUES ($1, $2)', [key, value])
    }
  }

  // Migration: add steam_id and avatar_url to players
  const hasSteamId = await queryOne(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'players' AND column_name = 'steam_id'
  `)
  if (!hasSteamId) {
    await execute('ALTER TABLE players ADD COLUMN steam_id TEXT DEFAULT NULL')
    await execute('ALTER TABLE players ADD COLUMN avatar_url TEXT DEFAULT NULL')
    await execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_players_steam_id ON players (steam_id) WHERE steam_id IS NOT NULL')
  }

  // Migration: add is_admin to players
  const hasIsAdmin = await queryOne(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'players' AND column_name = 'is_admin'
  `)
  if (!hasIsAdmin) {
    await execute('ALTER TABLE players ADD COLUMN is_admin BOOLEAN DEFAULT FALSE')
  }

  // Migration: add player_id to captains
  const hasPlayerId = await queryOne(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'captains' AND column_name = 'player_id'
  `)
  if (!hasPlayerId) {
    await execute('ALTER TABLE captains ADD COLUMN player_id INTEGER REFERENCES players(id) ON DELETE SET NULL')
  }

  // Migration: rename registered → in_pool (or add in_pool)
  const hasInPool = await queryOne(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'players' AND column_name = 'in_pool'
  `)
  if (!hasInPool) {
    const hasRegistered = await queryOne(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'players' AND column_name = 'registered'
    `)
    if (hasRegistered) {
      await execute('ALTER TABLE players RENAME COLUMN registered TO in_pool')
    } else {
      await execute('ALTER TABLE players ADD COLUMN in_pool BOOLEAN DEFAULT FALSE')
    }
  }

  // Backfill draft_round from bid_history for already-drafted players missing it
  await execute(`
    UPDATE players SET draft_round = sub.round
    FROM (
      SELECT DISTINCT ON (player_id) player_id, round
      FROM bid_history ORDER BY player_id, id DESC
    ) sub
    WHERE players.id = sub.player_id AND players.drafted = 1 AND players.draft_round IS NULL
  `)
}

export default pool
