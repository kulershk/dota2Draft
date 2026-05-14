import pg from 'pg'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/draft'
})

// Without this listener, an error on an idle pooled client (e.g. the DB
// container restarting and severing connections — Postgres 57P01) becomes
// an unhandled 'error' event and Node terminates the whole Node process.
// Log it instead; pg.Pool will discard the broken client and reconnect on
// the next query.
pool.on('error', (err, _client) => {
  console.error('[pg.Pool] idle client error:', err.code || '', err.message)
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

    CREATE TABLE IF NOT EXISTS leagues (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      dota_league_id INTEGER NOT NULL UNIQUE,
      public BOOLEAN NOT NULL DEFAULT FALSE,
      created_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `)
  // leagues migration: add public column for existing DBs
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'leagues' AND column_name = 'public'`
    )
    if (!has) await execute('ALTER TABLE leagues ADD COLUMN public BOOLEAN NOT NULL DEFAULT FALSE')
  }
  // Enforce one row per Valve dota_league_id so users can't impersonate
  // someone else's league by registering the same id under a different name.
  // Skip if existing data has duplicates — log a warning and let the operator
  // dedupe manually rather than silently failing the boot.
  try {
    await execute('CREATE UNIQUE INDEX IF NOT EXISTS leagues_dota_league_id_unique ON leagues (dota_league_id)')
  } catch (e) {
    console.warn('[db] Could not add unique index on leagues.dota_league_id (likely duplicate rows). Resolve manually:', e.message)
  }

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
    ['total_xp', 'INTEGER NOT NULL DEFAULT 0'],
    ['daily_last_claimed', 'DATE DEFAULT NULL'],
    ['daily_streak', 'INTEGER NOT NULL DEFAULT 0'],
    ['banned_at', 'TIMESTAMP DEFAULT NULL'],
    ['banned_by', 'INTEGER DEFAULT NULL REFERENCES players(id) ON DELETE SET NULL'],
    ['banned_reason', 'TEXT DEFAULT NULL'],
    ['shadow_pool', 'SMALLINT NOT NULL DEFAULT 0 CHECK (shadow_pool IN (0, 1, 2))'],
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
    ['rules_title', 'TEXT DEFAULT \'\''],
    ['rules_content', 'TEXT DEFAULT \'\''],
    ['competition_type', 'TEXT DEFAULT \'\''],
    ['is_featured', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['deleted_at', 'TIMESTAMP NULL'],
    ['discord_announced_at', 'TIMESTAMP NULL'],
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

  // ─── News comment votes ──────────────────────────────
  await execute(`
    CREATE TABLE IF NOT EXISTS news_comment_votes (
      id SERIAL PRIMARY KEY,
      comment_id INTEGER NOT NULL REFERENCES news_comments(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      vote SMALLINT NOT NULL CHECK (vote IN (-1, 1)),
      UNIQUE(comment_id, player_id)
    )
  `)

  // ─── News table migrations ────────────────────────────
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'news' AND column_name = 'created_by'`
    )
    if (!has) await execute('ALTER TABLE news ADD COLUMN created_by INTEGER REFERENCES players(id) ON DELETE SET NULL')
  }
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'news' AND column_name = 'image_url'`
    )
    if (!has) await execute('ALTER TABLE news ADD COLUMN image_url TEXT')
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
      parsed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(match_id, game_number)
    );
  `)

  // Add parsed column to match_games if missing (existing databases)
  try { await execute('ALTER TABLE match_games ADD COLUMN parsed BOOLEAN DEFAULT FALSE') } catch {}
  // Add start_time (Unix epoch from OpenDota)
  try { await execute('ALTER TABLE match_games ADD COLUMN start_time BIGINT DEFAULT NULL') } catch {}
  // Add picks_bans JSONB column to match_games (stores draft picks and bans from OpenDota)
  try { await execute("ALTER TABLE match_games ADD COLUMN picks_bans JSONB DEFAULT '[]'") } catch {}

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

  // Match standins
  await execute(`
    CREATE TABLE IF NOT EXISTS match_standins (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      original_player_id INTEGER NOT NULL REFERENCES players(id),
      standin_player_id INTEGER NOT NULL REFERENCES players(id),
      captain_id INTEGER NOT NULL REFERENCES captains(id),
      match_game_id INTEGER REFERENCES match_games(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Add match_game_id column and migrate unique constraint for per-game standins
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'match_standins' AND column_name = 'match_game_id'`
    )
    if (!has) {
      await execute('ALTER TABLE match_standins ADD COLUMN match_game_id INTEGER REFERENCES match_games(id) ON DELETE CASCADE')
    }
    try { await execute('ALTER TABLE match_standins DROP CONSTRAINT IF EXISTS match_standins_match_id_original_player_id_key') } catch {}
    await execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS match_standins_unique_per_game
      ON match_standins (match_id, original_player_id, COALESCE(match_game_id, 0))
    `)
  }

  // Favorite position (cached, recalculated after each game)
  try { await execute("ALTER TABLE players ADD COLUMN favorite_position JSONB DEFAULT NULL") } catch {}

  // Per-match penalty overrides
  try { await execute('ALTER TABLE matches ADD COLUMN penalty_radiant INTEGER DEFAULT NULL') } catch {}
  try { await execute('ALTER TABLE matches ADD COLUMN penalty_dire INTEGER DEFAULT NULL') } catch {}
  // Optional per-match label for custom brackets (e.g. "Play-in", "Upper Finals")
  try { await execute('ALTER TABLE matches ADD COLUMN label TEXT DEFAULT NULL') } catch {}

  // Competition templates
  await execute(`
    CREATE TABLE IF NOT EXISTS competition_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      settings JSONB NOT NULL DEFAULT '{}',
      created_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

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
      lane_role INTEGER DEFAULT NULL,
      item_0 INTEGER DEFAULT 0,
      item_1 INTEGER DEFAULT 0,
      item_2 INTEGER DEFAULT 0,
      item_3 INTEGER DEFAULT 0,
      item_4 INTEGER DEFAULT 0,
      item_5 INTEGER DEFAULT 0,
      backpack_0 INTEGER DEFAULT 0,
      backpack_1 INTEGER DEFAULT 0,
      backpack_2 INTEGER DEFAULT 0,
      item_neutral INTEGER DEFAULT 0,
      UNIQUE(match_game_id, account_id)
    )
  `)

  // Add lane_role column if missing (existing databases)
  try { await execute('ALTER TABLE match_game_player_stats ADD COLUMN lane_role INTEGER DEFAULT NULL') } catch {}

  // Add item columns if missing (existing databases)
  const itemCols = ['item_0','item_1','item_2','item_3','item_4','item_5','backpack_0','backpack_1','backpack_2','item_neutral']
  for (const col of itemCols) {
    try { await execute(`ALTER TABLE match_game_player_stats ADD COLUMN ${col} INTEGER DEFAULT 0`) } catch {}
  }

  // Backfill: mark games as parsed if they already have detailed stats (items or wards)
  await execute(`
    UPDATE match_games SET parsed = true
    WHERE parsed = false AND id IN (
      SELECT DISTINCT match_game_id FROM match_game_player_stats
      WHERE item_0 > 0 OR obs_placed > 0 OR sen_placed > 0
    )
  `)

  // Fantasy league tables
  await execute(`
    CREATE TABLE IF NOT EXISTS fantasy_stages (
      id SERIAL PRIMARY KEY,
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'upcoming',
      stage_order INTEGER NOT NULL DEFAULT 0,
      allowed_captain_ids JSONB DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Add allowed_captain_ids column if missing (existing databases)
  try { await execute('ALTER TABLE fantasy_stages ADD COLUMN allowed_captain_ids JSONB DEFAULT NULL') } catch {}

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

  // ─── XP / Leveling system ──────────────────────────────
  await execute(`
    CREATE TABLE IF NOT EXISTS xp_log (
      id SERIAL PRIMARY KEY,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref_type TEXT DEFAULT NULL,
      ref_id TEXT DEFAULT NULL,
      competition_id INTEGER DEFAULT NULL,
      competition_name TEXT DEFAULT NULL,
      detail TEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_xp_log_player ON xp_log(player_id);
    CREATE INDEX IF NOT EXISTS idx_xp_log_competition ON xp_log(competition_id);
  `)
  // Idempotency index (separate because CREATE UNIQUE INDEX IF NOT EXISTS may not be in the same block)
  try { await execute('CREATE UNIQUE INDEX idx_xp_log_idempotent ON xp_log(player_id, reason, ref_type, ref_id)') } catch {}

  // Backfill XP for existing Twitch/Discord links and bios (idempotent via ON CONFLICT)
  await execute(`
    INSERT INTO xp_log (player_id, amount, reason, ref_type, ref_id)
    SELECT id, 50, 'link_twitch', 'profile', CAST(id AS TEXT) FROM players WHERE twitch_id IS NOT NULL
    ON CONFLICT (player_id, reason, ref_type, ref_id) DO NOTHING
  `)
  await execute(`
    INSERT INTO xp_log (player_id, amount, reason, ref_type, ref_id)
    SELECT id, 50, 'link_discord', 'profile', CAST(id AS TEXT) FROM players WHERE discord_id IS NOT NULL
    ON CONFLICT (player_id, reason, ref_type, ref_id) DO NOTHING
  `)
  await execute(`
    INSERT INTO xp_log (player_id, amount, reason, ref_type, ref_id)
    SELECT id, 25, 'set_bio', 'profile', CAST(id AS TEXT) FROM players WHERE info IS NOT NULL AND info != ''
    ON CONFLICT (player_id, reason, ref_type, ref_id) DO NOTHING
  `)
  // Sync total_xp from xp_log for all players who have entries
  await execute(`
    UPDATE players SET total_xp = sub.total FROM (
      SELECT player_id, COALESCE(SUM(amount), 0) AS total FROM xp_log GROUP BY player_id
    ) sub WHERE players.id = sub.player_id AND players.total_xp != sub.total
  `)

  // Background jobs (Postgres-backed queue for visibility/retry)
  await execute(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB DEFAULT NULL,
      error TEXT DEFAULT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      started_at TIMESTAMP DEFAULT NULL,
      completed_at TIMESTAMP DEFAULT NULL,
      created_by INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at ON jobs(status, run_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
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
      auto_connect BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  // Migration: add auto_connect column
  const hasAutoConnect = await queryOne(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'lobby_bots' AND column_name = 'auto_connect'`
  )
  if (!hasAutoConnect) {
    await execute('ALTER TABLE lobby_bots ADD COLUMN auto_connect BOOLEAN NOT NULL DEFAULT false')
  }

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

  // match_lobbies migration: server_steam_id (used by liveMatchPoller for both
  // queue matches and tournament matches — the bot reports it on game_started)
  try { await execute('ALTER TABLE match_lobbies ADD COLUMN server_steam_id TEXT DEFAULT NULL') } catch {}

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

  // Bot status timeline: every status transition on lobby_bots is recorded by
  // a trigger, so it captures changes from any call site (manual connect,
  // auto-connect, lobby lifecycle, the Go bot service, etc).
  await execute(`
    CREATE TABLE IF NOT EXISTS bot_status_history (
      id SERIAL PRIMARY KEY,
      bot_id INTEGER NOT NULL REFERENCES lobby_bots(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      error_message TEXT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `)
  await execute(`CREATE INDEX IF NOT EXISTS idx_bot_status_history_bot ON bot_status_history(bot_id, id DESC)`)
  await execute(`
    CREATE OR REPLACE FUNCTION log_bot_status_change() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO bot_status_history (bot_id, status, error_message)
        VALUES (NEW.id, NEW.status, NEW.error_message);
        DELETE FROM bot_status_history
         WHERE bot_id = NEW.id
           AND id NOT IN (
             SELECT id FROM bot_status_history WHERE bot_id = NEW.id ORDER BY id DESC LIMIT 200
           );
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)
  await execute(`DROP TRIGGER IF EXISTS trg_bot_status_change ON lobby_bots`)
  await execute(`
    CREATE TRIGGER trg_bot_status_change
      AFTER INSERT OR UPDATE OF status ON lobby_bots
      FOR EACH ROW EXECUTE FUNCTION log_bot_status_change()
  `)

  // ─── Competition helpers ──────────────────────────────────────────────
  // Per-competition collaborators. A user listed here is treated by
  // requireCompPermission as if they were the competition's creator —
  // grants the same scoped management rights without a global perm.
  await execute(`
    CREATE TABLE IF NOT EXISTS competition_helpers (
      competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      added_by INTEGER REFERENCES players(id) ON DELETE SET NULL,
      added_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (competition_id, player_id)
    )
  `)

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
      playing_role INTEGER DEFAULT NULL,
      UNIQUE(competition_id, player_id)
    )
  `)

  // Add playing_role column if missing (existing databases)
  try { await execute('ALTER TABLE competition_players ADD COLUMN playing_role INTEGER DEFAULT NULL') } catch {}
  // Add created_at column to competition_players (join timestamp)
  try { await execute('ALTER TABLE competition_players ADD COLUMN created_at TIMESTAMP DEFAULT NOW()') } catch {}

  // Add team_ids JSONB column to match_lobbies (stores radiant/dire team IDs + names)
  {
    const has = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'match_lobbies' AND column_name = 'team_ids'`
    )
    if (!has) {
      await execute("ALTER TABLE match_lobbies ADD COLUMN team_ids JSONB DEFAULT NULL")
    }
  }

  // ─── Queue matchmaking tables ─────────────────────────────
  await execute(`
    CREATE TABLE IF NOT EXISTS queue_pools (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      min_mmr INTEGER DEFAULT 0,
      max_mmr INTEGER DEFAULT 0,
      pick_timer INTEGER DEFAULT 30,
      best_of INTEGER DEFAULT 1,
      lobby_server_region INTEGER DEFAULT 3,
      lobby_game_mode INTEGER DEFAULT 2,
      lobby_league_id INTEGER DEFAULT 0,
      lobby_dotv_delay INTEGER DEFAULT 1,
      lobby_cheats BOOLEAN DEFAULT FALSE,
      lobby_allow_spectating BOOLEAN DEFAULT TRUE,
      lobby_pause_setting INTEGER DEFAULT 0,
      lobby_selection_priority INTEGER DEFAULT 0,
      lobby_cm_pick INTEGER DEFAULT 0,
      lobby_auto_assign_teams BOOLEAN DEFAULT TRUE,
      lobby_penalty_radiant INTEGER DEFAULT 0,
      lobby_penalty_dire INTEGER DEFAULT 0,
      lobby_series_type INTEGER DEFAULT 0,
      lobby_timeout_minutes INTEGER DEFAULT 10,
      team_size INTEGER DEFAULT 5,
      xp_win INTEGER DEFAULT 15,
      xp_participate INTEGER DEFAULT 5,
      accept_timer INTEGER DEFAULT 20,
      decline_ban_minutes INTEGER DEFAULT 5,
      created_by INTEGER NULL REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)

  // Add columns to queue_pools if missing (existing databases)
  try { await execute('ALTER TABLE queue_pools ADD COLUMN team_size INTEGER DEFAULT 5') } catch {}
  try { await execute('ALTER TABLE queue_pools ADD COLUMN xp_win INTEGER DEFAULT 15') } catch {}
  try { await execute('ALTER TABLE queue_pools ADD COLUMN xp_participate INTEGER DEFAULT 5') } catch {}
  try { await execute('ALTER TABLE queue_pools ADD COLUMN lobby_auto_assign_teams BOOLEAN DEFAULT TRUE') } catch {}
  try { await execute('ALTER TABLE queue_pools ADD COLUMN lobby_penalty_radiant INTEGER DEFAULT 0') } catch {}
  try { await execute('ALTER TABLE queue_pools ADD COLUMN lobby_penalty_dire INTEGER DEFAULT 0') } catch {}
  try { await execute('ALTER TABLE queue_pools ADD COLUMN accept_timer INTEGER DEFAULT 20') } catch {}
  try { await execute('ALTER TABLE queue_pools ADD COLUMN decline_ban_minutes INTEGER DEFAULT 5') } catch {}
  try { await execute('ALTER TABLE queue_pools ADD COLUMN created_by INTEGER NULL REFERENCES players(id) ON DELETE SET NULL') } catch {}
  try { await execute('ALTER TABLE queue_pools ADD COLUMN captain_eligibility_threshold INTEGER NOT NULL DEFAULT 1500') } catch {}
  try { await execute(`ALTER TABLE queue_pools ADD COLUMN rules_title TEXT DEFAULT ''`) } catch {}
  try { await execute(`ALTER TABLE queue_pools ADD COLUMN rules_content TEXT DEFAULT ''`) } catch {}

  // ─── Discord match-voice state ────────────────────────────────────────
  // The discord bot mirrors its in-memory liveMatches Map here so a bot
  // restart can rebuild the cleanup schedule and not orphan the team
  // channels. Written by the bot (NOT by the server). cleanup_at NULL =
  // match still live; non-null = cleanup deadline (delete channels at this
  // time). Rows are deleted by the bot once channels are gone.
  await execute(`
    CREATE TABLE IF NOT EXISTS discord_match_voice (
      match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
      radiant_channel_id TEXT NOT NULL,
      dire_channel_id TEXT NOT NULL,
      cleanup_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `)

  // Drop FK constraints on winner_captain_id so queue matches can store player IDs
  try { await execute('ALTER TABLE match_games DROP CONSTRAINT IF EXISTS match_games_winner_captain_id_fkey') } catch {}
  try { await execute('ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_winner_captain_id_fkey') } catch {}

  // Make matches.competition_id nullable for queue matches
  try { await execute(`ALTER TABLE matches ALTER COLUMN competition_id DROP NOT NULL`) } catch {}
  // Make match_lobbies.competition_id nullable for queue matches
  try { await execute(`ALTER TABLE match_lobbies ALTER COLUMN competition_id DROP NOT NULL`) } catch {}

  // Replace the plain UNIQUE(match_id, game_number) with a partial unique
  // index that only enforces uniqueness for non-terminal lobby rows. This
  // lets retry attempts leave errored/cancelled/completed rows behind for
  // history while still guaranteeing at most one active lobby per game.
  try {
    const hasOldConstraint = await queryOne(
      `SELECT 1 FROM pg_constraint WHERE conname = 'match_lobbies_match_id_game_number_key'`
    )
    if (hasOldConstraint) {
      await execute(`ALTER TABLE match_lobbies DROP CONSTRAINT match_lobbies_match_id_game_number_key`)
    }
    await execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS match_lobbies_active_unique
        ON match_lobbies(match_id, game_number)
        WHERE status NOT IN ('completed', 'cancelled', 'error')
    `)
  } catch (e) {
    console.error('[db] Failed to migrate match_lobbies unique constraint:', e.message)
  }

  await execute(`
    CREATE TABLE IF NOT EXISTS queue_matches (
      id SERIAL PRIMARY KEY,
      pool_id INTEGER NOT NULL REFERENCES queue_pools(id) ON DELETE CASCADE,
      match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL,
      captain1_player_id INTEGER REFERENCES players(id),
      captain2_player_id INTEGER REFERENCES players(id),
      team1_players JSONB DEFAULT '[]',
      team2_players JSONB DEFAULT '[]',
      all_player_ids JSONB DEFAULT '[]',
      role_preferences JSONB DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'picking',
      created_at TIMESTAMP DEFAULT NOW(),
      completed_at TIMESTAMP DEFAULT NULL
    )
  `)
  try { await execute(`ALTER TABLE queue_matches ADD COLUMN role_preferences JSONB DEFAULT '{}'`) } catch {}

  // Cancel any queue matches that were in picking state when server restarted
  try { await execute(`UPDATE queue_matches SET status = 'cancelled' WHERE status = 'picking'`) } catch {}

  // Queue bans — admin can kick or temporarily ban players from joining queue.
  // banned_until IS NULL means permanent until an admin unbans.
  // pool_id IS NULL means the ban applies to every pool ("global"); a non-null
  // pool_id scopes the ban to that one pool. A player can have multiple rows
  // (one global + several per-pool, or several per-pool).
  await execute(`
    CREATE TABLE IF NOT EXISTS queue_bans (
      id SERIAL PRIMARY KEY,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      pool_id INTEGER NULL REFERENCES queue_pools(id) ON DELETE CASCADE,
      banned_until TIMESTAMP NULL,
      reason TEXT NULL,
      banned_by INTEGER NULL REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  // Migration for existing DBs that still have the old (player_id PK, no pool_id) shape:
  {
    const hasId = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'queue_bans' AND column_name = 'id'`
    )
    if (!hasId) {
      // 1) Drop the player_id-as-PK constraint so we can replace it.
      try { await execute('ALTER TABLE queue_bans DROP CONSTRAINT IF EXISTS queue_bans_pkey') } catch {}
      // 2) Add surrogate id and promote it to PK.
      await execute('ALTER TABLE queue_bans ADD COLUMN id SERIAL')
      await execute('ALTER TABLE queue_bans ADD PRIMARY KEY (id)')
    }
    const hasPoolId = await queryOne(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'queue_bans' AND column_name = 'pool_id'`
    )
    if (!hasPoolId) {
      await execute('ALTER TABLE queue_bans ADD COLUMN pool_id INTEGER NULL REFERENCES queue_pools(id) ON DELETE CASCADE')
    }
  }
  // At most one global ban per player; at most one ban per (player, pool).
  await execute(`CREATE UNIQUE INDEX IF NOT EXISTS queue_bans_player_global ON queue_bans (player_id) WHERE pool_id IS NULL`)
  await execute(`CREATE UNIQUE INDEX IF NOT EXISTS queue_bans_player_pool ON queue_bans (player_id, pool_id) WHERE pool_id IS NOT NULL`)

  // ─── Seasons ─────────────────────────────────────────────
  // Independent ELO ladders. Each queue_pool may be assigned to a season.
  // When a queue_match completes with a winner, the rating engine adjusts
  // every participating player's points on the pool's season.
  await execute(`
    CREATE TABLE IF NOT EXISTS seasons (
      id                 SERIAL PRIMARY KEY,
      name               TEXT NOT NULL,
      slug               TEXT UNIQUE NOT NULL,
      description        TEXT DEFAULT '',
      starts_at          TIMESTAMP NULL,
      ends_at            TIMESTAMP NULL,
      is_active          BOOLEAN DEFAULT TRUE,
      verified_mmr_only  BOOLEAN NOT NULL DEFAULT FALSE,
      settings           JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by         INTEGER NULL REFERENCES players(id) ON DELETE SET NULL,
      created_at         TIMESTAMP DEFAULT NOW()
    )
  `)
  // Migration for existing DBs.
  try { await execute('ALTER TABLE seasons ADD COLUMN verified_mmr_only BOOLEAN NOT NULL DEFAULT FALSE') } catch {}

  await execute(`
    CREATE TABLE IF NOT EXISTS season_rankings (
      season_id     INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      points        REAL NOT NULL,
      peak_points   REAL NOT NULL,
      games_played  INTEGER NOT NULL DEFAULT 0,
      wins          INTEGER NOT NULL DEFAULT 0,
      losses        INTEGER NOT NULL DEFAULT 0,
      last_match_at TIMESTAMP NULL,
      PRIMARY KEY (season_id, player_id)
    )
  `)
  try { await execute(`CREATE INDEX IF NOT EXISTS season_rankings_leaderboard_idx ON season_rankings (season_id, points DESC)`) } catch {}

  // queue_match_id is NULL for manual admin adjustments.
  await execute(`
    CREATE TABLE IF NOT EXISTS season_match_log (
      id               SERIAL PRIMARY KEY,
      season_id        INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      queue_match_id   INTEGER NULL REFERENCES queue_matches(id) ON DELETE CASCADE,
      player_id        INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      team             SMALLINT NULL,
      won              BOOLEAN NULL,
      points_before    REAL NOT NULL,
      points_after     REAL NOT NULL,
      delta            REAL NOT NULL,
      team_avg_mmr     INTEGER NULL,
      opponent_avg_mmr INTEGER NULL,
      expected_win     REAL NULL,
      k_used           REAL NULL,
      reason           TEXT NULL,
      created_by       INTEGER NULL REFERENCES players(id) ON DELETE SET NULL,
      created_at       TIMESTAMP DEFAULT NOW()
    )
  `)
  try { await execute(`CREATE INDEX IF NOT EXISTS season_match_log_season_player_idx ON season_match_log (season_id, player_id, created_at DESC)`) } catch {}
  try { await execute(`CREATE INDEX IF NOT EXISTS season_match_log_match_idx ON season_match_log (queue_match_id)`) } catch {}

  // Wire seasons to queue pools and (snapshot) to queue matches.
  try { await execute(`ALTER TABLE queue_pools   ADD COLUMN season_id INTEGER NULL REFERENCES seasons(id) ON DELETE SET NULL`) } catch {}
  // No FK on queue_matches.season_id so deleting a season doesn't lose match history.
  try { await execute(`ALTER TABLE queue_matches ADD COLUMN season_id INTEGER NULL`) } catch {}
  // Steam server steam_id captured once a player is in-game — used to query
  // GetRealtimeStats for live score / time updates while the match runs.
  try { await execute(`ALTER TABLE queue_matches ADD COLUMN server_steam_id BIGINT NULL`) } catch {}

  // Persistent role preferences carried from one queue match to the next so
  // players don't have to re-pick their preferred role every time. Updated
  // whenever the player saves preferences during a draft phase.
  try { await execute(`ALTER TABLE players ADD COLUMN preferred_roles JSONB NOT NULL DEFAULT '[]'::jsonb`) } catch {}

  // ─── MMR verifications ───────────────────────────────────
  // Players submit a screenshot + MMR; admins approve to update players.mmr.
  // Self-edit of MMR is locked once this flow is in place — only approval
  // bumps the canonical value.
  await execute(`
    CREATE TABLE IF NOT EXISTS mmr_verifications (
      id              SERIAL PRIMARY KEY,
      player_id       INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      submitted_mmr   INTEGER NOT NULL,
      screenshot_url  TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      submitted_at    TIMESTAMP DEFAULT NOW(),
      reviewed_by     INTEGER NULL REFERENCES players(id) ON DELETE SET NULL,
      reviewed_at     TIMESTAMP NULL,
      review_note     TEXT NULL
    )
  `)
  try { await execute(`CREATE INDEX IF NOT EXISTS mmr_verifications_status_idx ON mmr_verifications (status, submitted_at DESC)`) } catch {}
  try { await execute(`CREATE INDEX IF NOT EXISTS mmr_verifications_player_idx ON mmr_verifications (player_id, submitted_at DESC)`) } catch {}

  // Verified-MMR badge timestamp. Set on first admin approval and never
  // unset — players who go through the verification process keep the badge
  // even if their MMR is later edited directly by an admin.
  try { await execute(`ALTER TABLE players ADD COLUMN mmr_verified_at TIMESTAMP NULL`) } catch {}
  // One-time backfill: any player with an existing approved row gets a
  // verified-at timestamp from their earliest approval. Idempotent because
  // it only writes when mmr_verified_at IS NULL.
  await execute(`
    UPDATE players p SET mmr_verified_at = sub.first_approved
    FROM (
      SELECT player_id, MIN(reviewed_at) AS first_approved
      FROM mmr_verifications
      WHERE status = 'approved' AND reviewed_at IS NOT NULL
      GROUP BY player_id
    ) sub
    WHERE p.id = sub.player_id AND p.mmr_verified_at IS NULL
  `)

  // ─── Request logs (admin observability) ──────────────────
  await execute(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL DEFAULT NOW(),
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER,
      user_id INTEGER,
      ip TEXT,
      user_agent TEXT
    )
  `)
  try { await execute(`CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs (ts DESC)`) } catch {}
  try { await execute(`CREATE INDEX IF NOT EXISTS idx_request_logs_path_ts ON request_logs (path, ts DESC)`) } catch {}
  try { await execute(`CREATE INDEX IF NOT EXISTS idx_request_logs_user_ts ON request_logs (user_id, ts DESC)`) } catch {}
  try { await execute(`CREATE INDEX IF NOT EXISTS idx_request_logs_ip_ts ON request_logs (ip, ts DESC) WHERE ip IS NOT NULL`) } catch {}

  await execute(`
    CREATE TABLE IF NOT EXISTS socket_event_logs (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMP NOT NULL DEFAULT NOW(),
      event TEXT NOT NULL,
      user_id INTEGER,
      competition_id INTEGER
    )
  `)
  try { await execute(`ALTER TABLE socket_event_logs ADD COLUMN path TEXT`) } catch {}
  try { await execute(`CREATE INDEX IF NOT EXISTS idx_socket_event_logs_ts ON socket_event_logs (ts DESC)`) } catch {}
  try { await execute(`CREATE INDEX IF NOT EXISTS idx_socket_event_logs_event_ts ON socket_event_logs (event, ts DESC)`) } catch {}
  try { await execute(`CREATE INDEX IF NOT EXISTS idx_socket_event_logs_path_ts ON socket_event_logs (path, ts DESC) WHERE path IS NOT NULL`) } catch {}

  // ─── Customizable navigation menu ───────────────────────
  await execute(`
    CREATE TABLE IF NOT EXISTS nav_items (
      id SERIAL PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0,
      label_key TEXT,
      labels JSONB,
      icon TEXT NOT NULL DEFAULT 'Circle',
      path TEXT NOT NULL,
      is_external BOOLEAN NOT NULL DEFAULT FALSE,
      is_visible BOOLEAN NOT NULL DEFAULT TRUE,
      active_match TEXT,
      requires_auth BOOLEAN NOT NULL DEFAULT FALSE,
      badge TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `)
  try { await execute(`ALTER TABLE nav_items ADD COLUMN parent_id INTEGER REFERENCES nav_items(id) ON DELETE SET NULL`) } catch {}
  try { await execute(`ALTER TABLE nav_items ADD COLUMN column_group TEXT`) } catch {}
  // Allow path to be NULL for dropdown-only parent items.
  try { await execute(`ALTER TABLE nav_items ALTER COLUMN path DROP NOT NULL`) } catch {}
  try { await execute(`CREATE INDEX IF NOT EXISTS idx_nav_items_sort ON nav_items (sort_order, id)`) } catch {}
  try { await execute(`CREATE INDEX IF NOT EXISTS idx_nav_items_parent ON nav_items (parent_id, sort_order)`) } catch {}

  // Seed default nav items if empty (matches the previous hardcoded menu)
  const navCount = await queryOne('SELECT COUNT(*)::int AS n FROM nav_items')
  if (!navCount || navCount.n === 0) {
    const seed = [
      { sort_order: 10, label_key: 'competitions',      icon: 'Swords',    path: '/competitions', active_match: '^/(competitions|c/)' },
      { sort_order: 20, label_key: 'navMatches',        icon: 'Calendar',  path: '/matches',      active_match: '^/matches', badge: 'my-matches' },
      { sort_order: 30, label_key: 'newsNav',           icon: 'Newspaper', path: '/news',         active_match: '^/news' },
      { sort_order: 40, label_key: 'leaderboard',       icon: 'Trophy',    path: '/leaderboard',  active_match: '^/leaderboard' },
      { sort_order: 50, label_key: 'seasonsNav',        icon: 'Medal',     path: '/seasons',      active_match: '^/seasons' },
      { sort_order: 60, label_key: 'queue',             icon: 'Swords',    path: '/queue',        active_match: '^/queue' },
    ]
    for (const it of seed) {
      await execute(
        `INSERT INTO nav_items (sort_order, label_key, icon, path, active_match, badge)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [it.sort_order, it.label_key, it.icon, it.path, it.active_match, it.badge || null]
      )
    }
  }

  // ─── Subscription plans ──────────────────────────────────
  // Tiered membership plans (e.g. Bronze / Silver / Gold). For now plans are
  // assigned manually in admin; later, payment provider webhooks (Lemon
  // Squeezy / Stripe / Patreon) will INSERT into user_subscriptions with
  // source != 'manual' and external_id set to the provider's subscription id.
  // perks JSONB is reserved for future per-perk config (e.g. badge color,
  // discord role id, custom emojis) — kept open so adding perks later is a
  // pure code change, no migration.
  await execute(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      slug         TEXT NOT NULL UNIQUE,
      description  TEXT NULL,
      price_cents  INTEGER NOT NULL DEFAULT 0,
      currency     TEXT NOT NULL DEFAULT 'EUR',
      perks        JSONB NOT NULL DEFAULT '{}'::jsonb,
      badge_url    TEXT NULL,
      is_active    BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `)
  // Migration for DBs that already have the table without badge_url.
  try { await execute(`ALTER TABLE subscription_plans ADD COLUMN badge_url TEXT NULL`) } catch {}

  // Persistent per-player flag for the auto_requeue perk. The match-end hook
  // reads this together with hasPerk('auto_requeue') and re-queues the player
  // into the same pool when both are true. Stored on players (not on a queue
  // match) so the preference survives across matches and server restarts.
  try { await execute(`ALTER TABLE players ADD COLUMN auto_requeue_enabled BOOLEAN NOT NULL DEFAULT false`) } catch {}

  await execute(`
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id            SERIAL PRIMARY KEY,
      player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      plan_id       INTEGER NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
      status        TEXT NOT NULL DEFAULT 'active',
      source        TEXT NOT NULL DEFAULT 'manual',
      external_id   TEXT NULL,
      started_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at    TIMESTAMP NULL,
      cancelled_at  TIMESTAMP NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `)
  // One active row per player (enforced by partial unique index, so cancelled
  // history rows can stack up freely).
  try {
    await execute(`CREATE UNIQUE INDEX IF NOT EXISTS user_subscriptions_one_active_per_player
                     ON user_subscriptions (player_id) WHERE status = 'active'`)
  } catch (e) {
    console.warn('[db] Could not add unique index on active user_subscriptions:', e.message)
  }
  try { await execute(`CREATE INDEX IF NOT EXISTS user_subscriptions_plan_idx ON user_subscriptions (plan_id)`) } catch {}
  try { await execute(`CREATE INDEX IF NOT EXISTS user_subscriptions_player_idx ON user_subscriptions (player_id)`) } catch {}
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
      playing_role INTEGER DEFAULT NULL,
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
      playing_role INTEGER DEFAULT NULL,
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
