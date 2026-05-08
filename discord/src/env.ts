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
}
