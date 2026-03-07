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

  // Seed default captains if empty
  const captainCount = await queryOne('SELECT COUNT(*) as count FROM captains')
  if (parseInt(captainCount.count) === 0) {
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
    for (const [name, team, budget, status, password] of defaultCaptains) {
      await execute(
        'INSERT INTO captains (name, team, budget, status, password) VALUES ($1, $2, $3, $4, $5)',
        [name, team, budget, status, password]
      )
    }
  }

  // Seed default players if empty
  const playerCount = await queryOne('SELECT COUNT(*) as count FROM players')
  if (parseInt(playerCount.count) === 0) {
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
    for (const [name, roles, mmr, info] of defaultPlayers) {
      await execute(
        'INSERT INTO players (name, roles, mmr, info) VALUES ($1, $2, $3, $4)',
        [name, roles, mmr, info]
      )
    }
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
