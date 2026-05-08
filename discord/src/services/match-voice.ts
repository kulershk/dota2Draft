import {
  ChannelType,
  type CategoryChannel,
  type Client,
  type Guild,
  type GuildMember,
  type VoiceChannel,
} from 'discord.js'
import { PermissionFlagsBits } from 'discord.js'
import { Logger } from './logger.js'
import { Settings } from './settings.js'
import { findRole, ROLE_KEYS } from './roles.js'
import { env } from '../env.js'
import { query } from './db.js'

interface TeamSpec {
  side: 'radiant' | 'dire'
  playerIds: number[]
}

interface StartMatchPayload {
  matchId: number
  queueMatchId?: number | null
  team1: TeamSpec
  team2: TeamSpec
}

const TEAM_NAMES: Record<TeamSpec['side'], string> = {
  radiant: '🟢 Radiant',
  dire: '🔴 Dire',
}

// matchId -> { radiantChannelId, direChannelId, cleanupTimer }
const liveMatches = new Map<
  number,
  { radiantChannelId: string; direChannelId: string; cleanupTimer: NodeJS.Timeout | null }
>()

function resolveGuildId(): string {
  return Settings.get('guild_id', env.DISCORD_GUILD_ID)
}

async function fetchGuild(client: Client): Promise<Guild | null> {
  const id = resolveGuildId()
  if (!id) return null
  try {
    return await client.guilds.fetch(id)
  } catch (err) {
    Logger.error('match-voice: failed to fetch guild', err)
    return null
  }
}

async function discordIdsForPlayers(playerIds: number[]): Promise<Map<number, string>> {
  if (!playerIds.length) return new Map()
  const rows = await query<{ id: number; discord_id: string | null }>(
    `SELECT id, discord_id FROM players WHERE id = ANY($1::int[]) AND discord_id IS NOT NULL`,
    [playerIds],
  )
  return new Map(rows.filter((r) => r.discord_id).map((r) => [r.id, r.discord_id as string]))
}

async function createTeamVoiceChannel(
  guild: Guild,
  matchId: number,
  team: TeamSpec,
  discordIds: string[],
  category: CategoryChannel | null,
): Promise<VoiceChannel> {
  const casterRole = findRole(guild, ROLE_KEYS.Caster)
  const everyoneId = guild.roles.everyone.id

  const overwrites: Array<{
    id: string
    allow?: bigint[]
    deny?: bigint[]
  }> = [
    {
      id: everyoneId,
      deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak],
    },
    ...discordIds.map((id) => ({
      id,
      allow: [
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.UseVAD,
      ],
    })),
  ]
  if (casterRole) {
    overwrites.push({
      id: casterRole.id,
      allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Speak],
    })
  }

  return guild.channels.create({
    name: `${TEAM_NAMES[team.side]} — Match #${matchId}`,
    type: ChannelType.GuildVoice,
    parent: category?.id ?? undefined,
    permissionOverwrites: overwrites,
    reason: `Queue match #${matchId} ${team.side}`,
  })
}

async function moveFromInHouseToTeams(
  guild: Guild,
  inhouseChannelId: string,
  team1Spec: { side: TeamSpec['side']; discordIds: string[]; channel: VoiceChannel },
  team2Spec: { side: TeamSpec['side']; discordIds: string[]; channel: VoiceChannel },
): Promise<{ moved: number; absent: number }> {
  const inhouse = guild.channels.cache.get(inhouseChannelId)
  if (!inhouse || inhouse.type !== ChannelType.GuildVoice) {
    Logger.warn(`match-voice: in-house channel ${inhouseChannelId} not found or not voice`)
    return { moved: 0, absent: team1Spec.discordIds.length + team2Spec.discordIds.length }
  }
  const presentMembers = (inhouse as VoiceChannel).members
  let moved = 0
  let absent = 0

  for (const spec of [team1Spec, team2Spec]) {
    for (const did of spec.discordIds) {
      const member = presentMembers.get(did)
      if (!member || !member.voice?.channelId) {
        absent++
        continue
      }
      try {
        await member.voice.setChannel(spec.channel.id, `Auto-move to ${spec.side}`)
        moved++
      } catch (err) {
        Logger.warn(`match-voice: failed to move ${member.user.tag}: ${(err as Error).message}`)
        absent++
      }
    }
  }
  return { moved, absent }
}

async function cleanupMatch(client: Client, matchId: number): Promise<void> {
  const state = liveMatches.get(matchId)
  if (!state) return
  liveMatches.delete(matchId)

  const guild = await fetchGuild(client)
  if (!guild) return

  const inhouseId = Settings.get('inhouse_voice_id')
  for (const channelId of [state.radiantChannelId, state.direChannelId]) {
    const ch = guild.channels.cache.get(channelId) as VoiceChannel | undefined
    if (!ch) continue

    if (inhouseId) {
      // Move any stragglers back to in-house before deleting.
      const members = [...ch.members.values()]
      for (const m of members) {
        try {
          await m.voice.setChannel(inhouseId, 'Match ended — return to In-House')
        } catch (err) {
          Logger.warn(`match-voice: failed to return ${m.user.tag} to in-house: ${(err as Error).message}`)
        }
      }
    }
    try {
      await ch.delete(`Match #${matchId} ended`)
      Logger.info(`match-voice: deleted ${ch.name}`)
    } catch (err) {
      Logger.warn(`match-voice: failed to delete ${ch.name}: ${(err as Error).message}`)
    }
  }
}

export async function startMatch(client: Client, payload: StartMatchPayload): Promise<{
  ok: boolean
  reason?: string
  radiantChannelId?: string
  direChannelId?: string
  movedCount?: number
}> {
  if (!Settings.getBool('match_voice_enabled', false)) {
    return { ok: false, reason: 'match_voice_enabled is off' }
  }
  const guild = await fetchGuild(client)
  if (!guild) return { ok: false, reason: 'no guild configured' }

  const inhouseId = Settings.get('inhouse_voice_id')
  if (!inhouseId) return { ok: false, reason: 'in-house channel not configured' }
  await guild.members.fetch().catch(() => {})
  await guild.channels.fetch().catch(() => {})

  if (liveMatches.has(payload.matchId)) {
    return { ok: false, reason: 'match already has voice channels' }
  }

  const allIds = [...payload.team1.playerIds, ...payload.team2.playerIds]
  const discordMap = await discordIdsForPlayers(allIds)
  const team1Discord = payload.team1.playerIds.map((id) => discordMap.get(id)).filter((x): x is string => Boolean(x))
  const team2Discord = payload.team2.playerIds.map((id) => discordMap.get(id)).filter((x): x is string => Boolean(x))

  const categoryId = Settings.get('match_category_id')
  const category = categoryId ? (guild.channels.cache.get(categoryId) as CategoryChannel | undefined) ?? null : null

  const radiantChannel = await createTeamVoiceChannel(guild, payload.matchId, payload.team1, team1Discord, category)
  const direChannel = await createTeamVoiceChannel(guild, payload.matchId, payload.team2, team2Discord, category)

  const { moved } = await moveFromInHouseToTeams(
    guild,
    inhouseId,
    { side: payload.team1.side, discordIds: team1Discord, channel: radiantChannel },
    { side: payload.team2.side, discordIds: team2Discord, channel: direChannel },
  )

  liveMatches.set(payload.matchId, {
    radiantChannelId: radiantChannel.id,
    direChannelId: direChannel.id,
    cleanupTimer: null,
  })

  Logger.info(
    `match-voice: match #${payload.matchId} → Radiant=${radiantChannel.id} Dire=${direChannel.id} moved=${moved}/${team1Discord.length + team2Discord.length}`,
  )
  return {
    ok: true,
    radiantChannelId: radiantChannel.id,
    direChannelId: direChannel.id,
    movedCount: moved,
  }
}

export function endMatch(client: Client, matchId: number, immediate = false): { ok: boolean; reason?: string } {
  const state = liveMatches.get(matchId)
  if (!state) return { ok: false, reason: 'no live voice channels for this match' }

  if (state.cleanupTimer) clearTimeout(state.cleanupTimer)

  const delayMin = Number(Settings.get('match_cleanup_delay_minutes', '10'))
  const delayMs = immediate ? 0 : Math.max(0, delayMin) * 60_000

  state.cleanupTimer = setTimeout(() => {
    cleanupMatch(client, matchId).catch((err) => Logger.error(`cleanupMatch ${matchId} failed`, err))
  }, delayMs)

  Logger.info(`match-voice: scheduled cleanup for match #${matchId} in ${delayMs}ms`)
  return { ok: true }
}

export function listLiveMatches(): Array<{ matchId: number; radiantChannelId: string; direChannelId: string }> {
  return [...liveMatches.entries()].map(([matchId, s]) => ({
    matchId,
    radiantChannelId: s.radiantChannelId,
    direChannelId: s.direChannelId,
  }))
}
