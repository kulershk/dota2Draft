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
    ['twitch_username', 'TEXT DEFAULT NULL'],
    ['twitch_id', 'TEXT DEFAULT NULL'],
    ['discord_username', 'TEXT DEFAULT NULL'],
    ['discord_id', 'TEXT DEFAULT NULL'],
    ['last_online', 'TIMESTAMP DEFAULT NULL'],
    ['steam_synced_at', 'TIMESTAMP DEFAULT NULL'],
    ['display_name', 'TEXT DEFAULT NULL'],
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
    const hasBanner = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'captains' AND column_name = 'banner_url'`
    )
    if (!hasBanner) {
      await execute('ALTER TABLE captains ADD COLUMN banner_url TEXT DEFAULT NULL')
    }
    const hasDotaTeamId = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'captains' AND column_name = 'dota_team_id'`
    )
    if (!hasDotaTeamId) {
      await execute('ALTER TABLE captains ADD COLUMN dota_team_id INTEGER DEFAULT NULL')
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
    ['is_public', 'BOOLEAN NOT NULL DEFAULT FALSE'],
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

  // ─── Permission Groups ───────────────────────────────────
  await execute(`
    CREATE TABLE IF NOT EXISTS permission_groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      permissions JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS player_permission_groups (
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES permission_groups(id) ON DELETE CASCADE,
      PRIMARY KEY (player_id, group_id)
    );
  `)

  // ─── Tournament tables ─────────────────────────────────
  // Add tournament_state column to competitions
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'competitions' AND column_name = 'tournament_state'`
    )
    if (!has) await execute(`ALTER TABLE competitions ADD COLUMN tournament_state JSONB NOT NULL DEFAULT '{}'`)
  }

  await execute(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      stage INTEGER NOT NULL DEFAULT 1,
      round INTEGER NOT NULL DEFAULT 1,
      match_order INTEGER NOT NULL DEFAULT 0,
      group_name TEXT DEFAULT NULL,
      team1_captain_id INTEGER REFERENCES captains(id) ON DELETE SET NULL,
      team2_captain_id INTEGER REFERENCES captains(id) ON DELETE SET NULL,
      score1 INTEGER DEFAULT NULL,
      score2 INTEGER DEFAULT NULL,
      best_of INTEGER NOT NULL DEFAULT 3,
      winner_captain_id INTEGER REFERENCES captains(id) ON DELETE SET NULL,
      next_match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL,
      next_match_slot INTEGER DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_at TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS match_games (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      game_number INTEGER NOT NULL,
      winner_captain_id INTEGER REFERENCES captains(id) ON DELETE SET NULL,
      dotabuff_id TEXT DEFAULT NULL,
      duration_minutes INTEGER DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(match_id, game_number)
    );
  `)

  // Matches table migration: add stage column
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'matches' AND column_name = 'stage'`
    )
    if (!has) {
      const matchesExist = await queryOne(`SELECT 1 FROM information_schema.tables WHERE table_name = 'matches'`)
      if (matchesExist) await execute('ALTER TABLE matches ADD COLUMN stage INTEGER NOT NULL DEFAULT 1')
    }
  }

  // Matches table migration: add bracket + loser advancement columns for double elimination
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'matches' AND column_name = 'bracket'`
    )
    if (!has) {
      const matchesExist = await queryOne(`SELECT 1 FROM information_schema.tables WHERE table_name = 'matches'`)
      if (matchesExist) {
        await execute("ALTER TABLE matches ADD COLUMN bracket TEXT DEFAULT NULL")
        await execute("ALTER TABLE matches ADD COLUMN loser_next_match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL DEFAULT NULL")
        await execute("ALTER TABLE matches ADD COLUMN loser_next_match_slot INTEGER DEFAULT NULL")
      }
    }
  }

  // Competition streams
  await execute(`
    CREATE TABLE IF NOT EXISTS competition_streams (
      id SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      twitch_username TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Competition streams migration: add profile_image_url
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'competition_streams' AND column_name = 'profile_image_url'`
    )
    if (!has) {
      const tableExists = await queryOne(`SELECT 1 FROM information_schema.tables WHERE table_name = 'competition_streams'`)
      if (tableExists) await execute('ALTER TABLE competition_streams ADD COLUMN profile_image_url TEXT DEFAULT NULL')
    }
  }

  // Matches migration: add hidden column
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'matches' AND column_name = 'hidden'`
    )
    if (!has) {
      const tableExists = await queryOne(`SELECT 1 FROM information_schema.tables WHERE table_name = 'matches'`)
      if (tableExists) await execute('ALTER TABLE matches ADD COLUMN hidden BOOLEAN DEFAULT FALSE')
    }
  }

  // Match game player stats (OpenDota parsed data)
  await execute(`
    CREATE TABLE IF NOT EXISTS match_game_player_stats (
      id SERIAL PRIMARY KEY,
      match_game_id INTEGER NOT NULL REFERENCES match_games(id) ON DELETE CASCADE,
      account_id BIGINT NOT NULL,
      player_name TEXT DEFAULT '',
      hero_id INTEGER DEFAULT 0,
      kills INTEGER DEFAULT 0,
      deaths INTEGER DEFAULT 0,
      assists INTEGER DEFAULT 0,
      last_hits INTEGER DEFAULT 0,
      denies INTEGER DEFAULT 0,
      gpm INTEGER DEFAULT 0,
      xpm INTEGER DEFAULT 0,
      hero_damage INTEGER DEFAULT 0,
      tower_damage INTEGER DEFAULT 0,
      hero_healing INTEGER DEFAULT 0,
      net_worth INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0,
      multi_kills JSONB DEFAULT '{}',
      kill_streaks JSONB DEFAULT '{}',
      obs_placed INTEGER DEFAULT 0,
      sen_placed INTEGER DEFAULT 0,
      observer_kills INTEGER DEFAULT 0,
      sentry_kills INTEGER DEFAULT 0,
      camps_stacked INTEGER DEFAULT 0,
      stuns REAL DEFAULT 0,
      teamfight_participation REAL DEFAULT 0,
      towers_killed INTEGER DEFAULT 0,
      roshans_killed INTEGER DEFAULT 0,
      firstblood_claimed INTEGER DEFAULT 0,
      rune_pickups INTEGER DEFAULT 0,
      courier_kills INTEGER DEFAULT 0,
      win INTEGER DEFAULT 0,
      is_radiant BOOLEAN DEFAULT FALSE,
      duration_seconds INTEGER DEFAULT 0,
      UNIQUE(match_game_id, account_id)
    )
  `)

  // Fantasy league tables
  await execute(`
    CREATE TABLE IF NOT EXISTS fantasy_stages (
      id SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      stage_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await execute(`
    CREATE TABLE IF NOT EXISTS fantasy_stage_matches (
      fantasy_stage_id INTEGER NOT NULL REFERENCES fantasy_stages(id) ON DELETE CASCADE,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      PRIMARY KEY (fantasy_stage_id, match_id)
    )
  `)

  await execute(`
    CREATE TABLE IF NOT EXISTS fantasy_picks (
      id SERIAL PRIMARY KEY,
      fantasy_stage_id INTEGER NOT NULL REFERENCES fantasy_stages(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      pick_player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      UNIQUE(fantasy_stage_id, player_id, role)
    )
  `)

  // Lobby bot pool
  await execute(`
    CREATE TABLE IF NOT EXISTS lobby_bots (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      refresh_token TEXT DEFAULT NULL,
      sentry_hash TEXT DEFAULT NULL,
      login_key TEXT DEFAULT NULL,
      display_name TEXT DEFAULT '',
      steam_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'offline',
      error_message TEXT DEFAULT NULL,
      last_used_at TIMESTAMP DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await execute(`
    CREATE TABLE IF NOT EXISTS match_lobbies (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      game_number INTEGER NOT NULL DEFAULT 1,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      bot_id INTEGER REFERENCES lobby_bots(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'creating',
      server_region INTEGER DEFAULT 3,
      game_name TEXT DEFAULT '',
      password TEXT DEFAULT '',
      players_joined JSONB DEFAULT '[]',
      players_expected JSONB DEFAULT '[]',
      error_message TEXT DEFAULT NULL,
      dota_match_id TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(match_id, game_number)
    )
  `)

  // lobby_bots migration: add sentry_hash and login_key
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'lobby_bots' AND column_name = 'sentry_hash'`
    )
    if (!has) {
      const tableExists = await queryOne(`SELECT 1 FROM information_schema.tables WHERE table_name = 'lobby_bots'`)
      if (tableExists) await execute('ALTER TABLE lobby_bots ADD COLUMN sentry_hash TEXT DEFAULT NULL')
    }
  }
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'lobby_bots' AND column_name = 'login_key'`
    )
    if (!has) {
      const tableExists = await queryOne(`SELECT 1 FROM information_schema.tables WHERE table_name = 'lobby_bots'`)
      if (tableExists) await execute('ALTER TABLE lobby_bots ADD COLUMN login_key TEXT DEFAULT NULL')
    }
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
      banner_url TEXT DEFAULT NULL,
      dota_team_id INTEGER DEFAULT NULL,
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
