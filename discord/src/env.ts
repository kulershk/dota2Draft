import { config as loadEnv } from 'dotenv'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

for (const candidate of ['.env', '../.env']) {
  const p = resolve(process.cwd(), candidate)
  if (existsSync(p)) {
    loadEnv({ path: p })
    break
  }
}

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

export const env = {
  DISCORD_BOT_TOKEN: required('DISCORD_BOT_TOKEN'),
  DISCORD_CLIENT_ID: required('DISCORD_CLIENT_ID'),
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID ?? '',
  API_BASE_URL: process.env.API_BASE_URL ?? 'http://draft:3001',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://draft:draft@draft-dev-db:5432/draft',
  // Internal HTTP server — exposes /internal/roles + /internal/channels for
  // the admin UI. Bearer token shared with the draft server.
  INTERNAL_PORT: Number(process.env.INTERNAL_PORT ?? 3030),
  INTERNAL_TOKEN: process.env.INTERNAL_TOKEN ?? '',
  // Privileged intents must be flipped on at https://discord.com/developers
  // before Discord will allow the gateway connection. Set to "true" once the
  // SERVER MEMBERS INTENT is enabled in the portal — until then the auto-
  // verify plugin's onGuildMemberAdd hook stays silent.
  ENABLE_GUILD_MEMBERS_INTENT: (process.env.ENABLE_GUILD_MEMBERS_INTENT ?? 'false') === 'true',
  // Optional role IDs (env-based fallback if DB-backed settings are empty).
  ROLE_ID_VERIFIED: process.env.ROLE_ID_VERIFIED ?? '',
  ROLE_ID_CASTER: process.env.ROLE_ID_CASTER ?? '',
}
