import { query, queryOne, execute } from './db.js'

export interface PlayerRow {
  id: number
  name: string
  display_name: string | null
  steam_id: string | null
  avatar_url: string | null
  is_admin: boolean
  is_banned: boolean
  in_pool: boolean
  mmr: number | null
  roles: unknown
  info: string | null
  discord_id: string | null
  discord_username: string | null
  twitch_id: string | null
  twitch_username: string | null
  total_xp: number | null
  daily_streak: number | null
  daily_last_claimed: string | null
  last_online: string | null
  created_at: string
}

export class User {
  constructor(private readonly row: PlayerRow) {}
  get id(): number { return this.row.id }
  get steamId(): string | null { return this.row.steam_id }
  get discordId(): string | null { return this.row.discord_id }
  get discordUsername(): string | null { return this.row.discord_username }
  get displayName(): string { return this.row.display_name ?? this.row.name }
  get avatarUrl(): string | null { return this.row.avatar_url }
  get mmr(): number | null { return this.row.mmr }
  get totalXp(): number { return this.row.total_xp ?? 0 }
  get dailyStreak(): number { return this.row.daily_streak ?? 0 }
  get isAdmin(): boolean { return this.row.is_admin }
  get isBanned(): boolean { return this.row.is_banned }
  get raw(): PlayerRow { return this.row }
}

const SELECT_COLUMNS = `
  id, name, display_name, steam_id, avatar_url, is_admin, is_banned, in_pool,
  mmr, roles, info, discord_id, discord_username, twitch_id, twitch_username,
  total_xp, daily_streak, daily_last_claimed, last_online, created_at
`

export class UserRepository {
  static async byDiscordId(discordId: string): Promise<User | null> {
    const row = await queryOne<PlayerRow>(
      `SELECT ${SELECT_COLUMNS} FROM players WHERE discord_id = $1 LIMIT 1`,
      [discordId],
    )
    return row ? new User(row) : null
  }

  static async bySteamId(steamId: string): Promise<User | null> {
    const row = await queryOne<PlayerRow>(
      `SELECT ${SELECT_COLUMNS} FROM players WHERE steam_id = $1 LIMIT 1`,
      [steamId],
    )
    return row ? new User(row) : null
  }

  static async byId(id: number): Promise<User | null> {
    const row = await queryOne<PlayerRow>(
      `SELECT ${SELECT_COLUMNS} FROM players WHERE id = $1 LIMIT 1`,
      [id],
    )
    return row ? new User(row) : null
  }

  static async topByXp(limit = 10): Promise<User[]> {
    const rows = await query<PlayerRow>(
      `SELECT ${SELECT_COLUMNS} FROM players WHERE COALESCE(total_xp, 0) > 0 AND is_banned = FALSE ORDER BY total_xp DESC LIMIT $1`,
      [limit],
    )
    return rows.map((r) => new User(r))
  }

  static async setDiscordUsername(discordId: string, username: string): Promise<void> {
    await execute(
      `UPDATE players SET discord_username = $2 WHERE discord_id = $1`,
      [discordId, username],
    )
  }
}
