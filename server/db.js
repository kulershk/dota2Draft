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
  // ─── Core tables ───────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      roles TEXT NOT NULL DEFAULT '[]',
      mmr INTEGER NOT NULL DEFAULT 0,
      info TEXT DEFAULT '',
      steam_id TEXT DEFAULT NULL,
      avatar_url TEXT DEFAULT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_players_steam_id ON players (steam_id) WHERE steam_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `)

  // Ensure global settings
  const hasAdminPw = await queryOne("SELECT 1 FROM settings WHERE key = 'adminPassword'")
  if (!hasAdminPw) {
    await execute("INSERT INTO settings (key, value) VALUES ('adminPassword', 'admin') ON CONFLICT (key) DO NOTHING")
  }

  // ─── Players table migrations (for existing DBs) ──────
  for (const [col, def] of [
    ['steam_id', 'TEXT DEFAULT NULL'],
    ['avatar_url', 'TEXT DEFAULT NULL'],
    ['is_admin', 'BOOLEAN DEFAULT FALSE'],
    ['is_banned', 'BOOLEAN DEFAULT FALSE'],
    ['in_pool', 'BOOLEAN DEFAULT FALSE'],
  ]) {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'players' AND column_name = $1`, [col]
    )
    if (!has) await execute(`ALTER TABLE players ADD COLUMN ${col} ${def}`)
  }

  // Handle old 'registered' → 'in_pool' rename
  const hasRegistered = await queryOne(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'players' AND column_name = 'registered'`
  )
  if (hasRegistered) {
    const hasInPool = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'players' AND column_name = 'in_pool'`
    )
    if (!hasInPool) {
      await execute('ALTER TABLE players RENAME COLUMN registered TO in_pool')
    }
  }

  // Ensure player_id on captains (old migration)
  const captainsExist = await queryOne(`SELECT 1 FROM information_schema.tables WHERE table_name = 'captains'`)
  if (captainsExist) {
    const hasPlayerId = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'captains' AND column_name = 'player_id'`
    )
    if (!hasPlayerId) {
      await execute('ALTER TABLE captains ADD COLUMN player_id INTEGER REFERENCES players(id) ON DELETE SET NULL')
    }
  }

  // ─── Competitions system ───────────────────────────────
  await execute(`
    CREATE TABLE IF NOT EXISTS competitions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      starts_at TIMESTAMP DEFAULT NULL,
      registration_start TIMESTAMP DEFAULT NULL,
      registration_end TIMESTAMP DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      settings JSONB NOT NULL DEFAULT '{}',
      auction_state JSONB NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // ─── Competitions table migrations ─────────────────────
  for (const [col, def] of [
    ['registration_start', 'TIMESTAMP DEFAULT NULL'],
    ['registration_end', 'TIMESTAMP DEFAULT NULL'],
    ['created_by', 'INTEGER REFERENCES players(id) ON DELETE SET NULL'],
  ]) {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'competitions' AND column_name = $1`, [col]
    )
    if (!has) await execute(`ALTER TABLE competitions ADD COLUMN ${col} ${def}`)
  }

  // ─── News comments ────────────────────────────────────
  await execute(`
    CREATE TABLE IF NOT EXISTS news_comments (
      id SERIAL PRIMARY KEY,
      news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // ─── News table migrations ────────────────────────────
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'news' AND column_name = 'created_by'`
    )
    if (!has) await execute('ALTER TABLE news ADD COLUMN created_by INTEGER REFERENCES players(id) ON DELETE SET NULL')
  }

  // Check if captains already have competition_id (new schema)
  const captainsHasCompId = await queryOne(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'captains' AND column_name = 'competition_id'
  `)

  if (!captainsHasCompId && captainsExist) {
    await migrateToCompetitions()
  } else if (!captainsExist) {
    // Fresh DB: create all tables with new schema
    await createFreshCompetitionTables()
  }

  // Ensure competition_players exists (might already from migration)
  await execute(`
    CREATE TABLE IF NOT EXISTS competition_players (
      id SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      roles TEXT NOT NULL DEFAULT '[]',
      mmr INTEGER NOT NULL DEFAULT 0,
      info TEXT DEFAULT '',
      in_pool BOOLEAN DEFAULT TRUE,
      drafted INTEGER NOT NULL DEFAULT 0,
      drafted_by INTEGER DEFAULT NULL REFERENCES captains(id) ON DELETE SET NULL,
      draft_price INTEGER DEFAULT NULL,
      draft_round INTEGER DEFAULT NULL,
      UNIQUE(competition_id, player_id)
    )
  `)
}

async function createFreshCompetitionTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS captains (
      id SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      team TEXT NOT NULL,
      budget INTEGER NOT NULL DEFAULT 1000,
      status TEXT NOT NULL DEFAULT 'Waiting',
      mmr INTEGER NOT NULL DEFAULT 0,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS competition_players (
      id SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      roles TEXT NOT NULL DEFAULT '[]',
      mmr INTEGER NOT NULL DEFAULT 0,
      info TEXT DEFAULT '',
      in_pool BOOLEAN DEFAULT TRUE,
      drafted INTEGER NOT NULL DEFAULT 0,
      drafted_by INTEGER DEFAULT NULL REFERENCES captains(id) ON DELETE SET NULL,
      draft_price INTEGER DEFAULT NULL,
      draft_round INTEGER DEFAULT NULL,
      UNIQUE(competition_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS auction_log (
      id SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bid_history (
      id SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      player_id INTEGER NOT NULL,
      captain_id INTEGER NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
      captain_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `)
}

async function migrateToCompetitions() {
  console.log('Migrating to competition-based schema...')

  // Read old settings
  const settingsRows = await query('SELECT key, value FROM settings')
  const oldSettings = {}
  for (const r of settingsRows) oldSettings[r.key] = r.value

  // Read old auction state
  let oldAuctionState = {}
  try {
    const auctionRows = await query('SELECT key, value FROM auction_state')
    for (const r of auctionRows) oldAuctionState[r.key] = r.value
  } catch {}

  const compSettings = {
    playersPerTeam: Number(oldSettings.playersPerTeam) || 5,
    bidTimer: Number(oldSettings.bidTimer) || 30,
    startingBudget: Number(oldSettings.startingBudget) || 1000,
    minimumBid: Number(oldSettings.minimumBid) || 10,
    bidIncrement: Number(oldSettings.bidIncrement) || 5,
    maxBid: Number(oldSettings.maxBid) || 0,
    nominationOrder: oldSettings.nominationOrder || 'normal',
    requireAllOnline: oldSettings.requireAllOnline !== 'false',
    allowSteamRegistration: oldSettings.allowSteamRegistration === 'true',
  }

  // Create default competition
  const comp = await queryOne(`
    INSERT INTO competitions (name, description, status, settings, auction_state)
    VALUES ('Default Competition', 'Migrated from initial setup', 'draft', $1, $2)
    RETURNING id
  `, [JSON.stringify(compSettings), JSON.stringify(oldAuctionState)])
  const compId = comp.id

  // Add competition_id to captains
  await execute('ALTER TABLE captains ADD COLUMN competition_id INTEGER REFERENCES competitions(id) ON DELETE CASCADE')
  await execute('UPDATE captains SET competition_id = $1', [compId])

  // Add competition_id to auction_log
  try {
    const logHasCompId = await queryOne(`SELECT 1 FROM information_schema.columns WHERE table_name = 'auction_log' AND column_name = 'competition_id'`)
    if (!logHasCompId) {
      await execute('ALTER TABLE auction_log ADD COLUMN competition_id INTEGER REFERENCES competitions(id) ON DELETE CASCADE')
      await execute('UPDATE auction_log SET competition_id = $1', [compId])
    }
  } catch {}

  // Add competition_id to bid_history
  try {
    const bhHasCompId = await queryOne(`SELECT 1 FROM information_schema.columns WHERE table_name = 'bid_history' AND column_name = 'competition_id'`)
    if (!bhHasCompId) {
      await execute('ALTER TABLE bid_history ADD COLUMN competition_id INTEGER REFERENCES competitions(id) ON DELETE CASCADE')
      await execute('UPDATE bid_history SET competition_id = $1', [compId])
    }
  } catch {}

  // Create competition_players table
  await execute(`
    CREATE TABLE IF NOT EXISTS competition_players (
      id SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      roles TEXT NOT NULL DEFAULT '[]',
      mmr INTEGER NOT NULL DEFAULT 0,
      info TEXT DEFAULT '',
      in_pool BOOLEAN DEFAULT TRUE,
      drafted INTEGER NOT NULL DEFAULT 0,
      drafted_by INTEGER DEFAULT NULL REFERENCES captains(id) ON DELETE SET NULL,
      draft_price INTEGER DEFAULT NULL,
      draft_round INTEGER DEFAULT NULL,
      UNIQUE(competition_id, player_id)
    )
  `)

  // Migrate pool players and drafted players
  try {
    const poolPlayers = await query('SELECT * FROM players WHERE in_pool = true OR drafted = 1')
    for (const p of poolPlayers) {
      await execute(`
        INSERT INTO competition_players (competition_id, player_id, roles, mmr, info, in_pool, drafted, drafted_by, draft_price, draft_round)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (competition_id, player_id) DO NOTHING
      `, [compId, p.id, p.roles || '[]', p.mmr || 0, p.info || '', !!p.in_pool, p.drafted || 0, p.drafted_by, p.draft_price, p.draft_round])
    }
  } catch {}

  // Ensure captains' linked players are in competition_players
  try {
    const captainPlayers = await query('SELECT player_id FROM captains WHERE player_id IS NOT NULL')
    for (const { player_id } of captainPlayers) {
      const p = await queryOne('SELECT * FROM players WHERE id = $1', [player_id])
      if (p) {
        await execute(`
          INSERT INTO competition_players (competition_id, player_id, roles, mmr, info, in_pool)
          VALUES ($1, $2, $3, $4, $5, false)
          ON CONFLICT (competition_id, player_id) DO NOTHING
        `, [compId, p.id, p.roles || '[]', p.mmr || 0, p.info || ''])
      }
    }
  } catch {}

  console.log(`Migration complete. Default competition id=${compId}`)
}

export default pool
