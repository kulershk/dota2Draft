import type { Guild, GuildMember, Role } from 'discord.js'
import { env } from '../env.js'
import { Settings } from './settings.js'

// Canonical role keys the bot writes to. Each maps to a configured Discord
// role ID, looked up in this order:
//   1. DB setting `discord_role_id_<key>` (managed via /admin/discord)
//   2. Env var ROLE_ID_<KEY> (bootstrap fallback)
//   3. Role name match (last-resort fallback for fresh installs)
export const ROLE_KEYS = {
  Verified: 'Verified',
  Caster: 'Caster',
} as const

export type RoleKey = (typeof ROLE_KEYS)[keyof typeof ROLE_KEYS]

const ENV_FALLBACK: Record<RoleKey, string> = {
  Verified: env.ROLE_ID_VERIFIED,
  Caster: env.ROLE_ID_CASTER,
}

const NAME_FALLBACK: Record<RoleKey, string> = {
  Verified: 'Verified',
  Caster: 'Caster',
}

function configuredId(key: RoleKey): string {
  return Settings.get(`role_id_${key.toLowerCase()}`, ENV_FALLBACK[key])
}

export function findRole(guild: Guild, key: RoleKey): Role | null {
  const id = configuredId(key)
  if (id) {
    const byId = guild.roles.cache.get(id)
    if (byId) return byId
  }
  return guild.roles.cache.find((r) => r.name === NAME_FALLBACK[key]) ?? null
}

export async function ensureRole(member: GuildMember, key: RoleKey): Promise<{ added: boolean; role: Role | null }> {
  const role = findRole(member.guild, key)
  if (!role) return { added: false, role: null }
  if (member.roles.cache.has(role.id)) return { added: false, role }
  await member.roles.add(role, `Auto-grant: ${key}`)
  return { added: true, role }
}

export async function removeRole(member: GuildMember, key: RoleKey): Promise<boolean> {
  const role = findRole(member.guild, key)
  if (!role || !member.roles.cache.has(role.id)) return false
  await member.roles.remove(role, `Removed: ${key}`)
  return true
}
