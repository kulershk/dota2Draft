import {
  ChannelType,
  type CategoryChannel,
  type Client,
  type Guild,
  type VoiceChannel,
} from 'discord.js'
import { Logger } from './logger.js'
import { Settings } from './settings.js'
import { env } from '../env.js'
import { query, execute } from './db.js'

interface TeamSpec {
  side: 'radiant' | 'dire'
  captainName?: string
  playerIds: number[]
}

interface StartMatchPayload {
  matchId: number
  queueMatchId?: number | null
  team1: TeamSpec
  team2: TeamSpec
}

function teamChannelName(team: TeamSpec, matchId: number): string {
  const base = team.captainName?.trim() || (team.side === 'radiant' ? 'Radiant' : 'Dire')
  // Discord caps channel names at 100 chars.
  const name = base.slice(0, 80)
  return team.side === 'radiant' ? `🟢 ${name}` : `🔴 ${name}`
}

// matchId -> { radiantChannelId, direChannelId, cleanupTimer }
// Mirrored to the discord_match_voice table so a bot restart can rebuild
// the in-memory entries (and reschedule any pending cleanups) instead of
// orphaning the team channels forever.
const liveMatches = new Map<
  number,
  { radiantChannelId: string; direChannelId: string; cleanupTimer: NodeJS.Timeout | null }
>()

async function persistLive(matchId: number, radiantId: string, direId: string): Promise<void> {
  try {
    await execute(
      `INSERT INTO discord_match_voice (match_id, radiant_channel_id, dire_channel_id, cleanup_at)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (match_id) DO UPDATE
         SET radiant_channel_id = EXCLUDED.radiant_channel_id,
             dire_channel_id    = EXCLUDED.dire_channel_id,
             cleanup_at         = NULL`,
      [matchId, radiantId, direId],
    )
  } catch (err) {
    Logger.warn(`match-voice: persistLive(${matchId}) failed: ${(err as Error).message}`)
  }
}

async function persistCleanupAt(matchId: number, cleanupAt: Date | null): Promise<void> {
  try {
    await execute(
      `UPDATE discord_match_voice SET cleanup_at = $2 WHERE match_id = $1`,
      [matchId, cleanupAt],
    )
  } catch (err) {
    Logger.warn(`match-voice: persistCleanupAt(${matchId}) failed: ${(err as Error).message}`)
  }
}

async function deletePersisted(matchId: number): Promise<void> {
  try {
    await execute(`DELETE FROM discord_match_voice WHERE match_id = $1`, [matchId])
  } catch (err) {
    Logger.warn(`match-voice: deletePersisted(${matchId}) failed: ${(err as Error).message}`)
  }
}

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
  _discordIds: string[],
  category: CategoryChannel | null,
): Promise<VoiceChannel> {
  // Public, no slot cap, no permission overrides — channel inherits the
  // category / @everyone defaults so anyone in the server can join.
  return guild.channels.create({
    name: teamChannelName(team, matchId),
    type: ChannelType.GuildVoice,
    parent: category?.id ?? undefined,
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

async function moveTeamMembersToInHouse(
  guild: Guild,
  channelIds: string[],
  inhouseId: string,
): Promise<number> {
  let moved = 0
  for (const channelId of channelIds) {
    const ch = guild.channels.cache.get(channelId) as VoiceChannel | undefined
    if (!ch) continue
    const members = [...ch.members.values()]
    for (const m of members) {
      try {
        await m.voice.setChannel(inhouseId, 'Match ended — return to In-House')
        moved++
      } catch (err) {
        Logger.warn(`match-voice: failed to return ${m.user.tag} to in-house: ${(err as Error).message}`)
      }
    }
  }
  return moved
}

async function deleteMatchChannels(client: Client, matchId: number): Promise<void> {
  const state = liveMatches.get(matchId)
  if (!state) {
    // Nothing in memory — still try to drop any persisted row so we don't
    // hang on to stale state forever.
    await deletePersisted(matchId)
    return
  }
  liveMatches.delete(matchId)

  const guild = await fetchGuild(client)
  if (guild) {
    for (const channelId of [state.radiantChannelId, state.direChannelId]) {
      const ch = guild.channels.cache.get(channelId) as VoiceChannel | undefined
      if (!ch) continue
      try {
        await ch.delete(`Match #${matchId} ended`)
        Logger.info(`match-voice: deleted ${ch.name}`)
      } catch (err) {
        Logger.warn(`match-voice: failed to delete ${ch.name}: ${(err as Error).message}`)
      }
    }
  }
  await deletePersisted(matchId)
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
  await persistLive(payload.matchId, radiantChannel.id, direChannel.id)

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

export async function endMatch(
  client: Client,
  matchId: number,
  immediate = false,
): Promise<{ ok: boolean; reason?: string; movedBack?: number }> {
  const state = liveMatches.get(matchId)
  if (!state) return { ok: false, reason: 'no live voice channels for this match' }

  if (state.cleanupTimer) clearTimeout(state.cleanupTimer)

  // Step 1 (always immediate): pull every member from the team channels back
  // to In-House, so nobody is stuck in a half-empty room.
  let movedBack = 0
  const guild = await fetchGuild(client)
  const inhouseId = Settings.get('inhouse_voice_id')
  if (guild && inhouseId) {
    movedBack = await moveTeamMembersToInHouse(
      guild,
      [state.radiantChannelId, state.direChannelId],
      inhouseId,
    )
  }

  // Step 2 (delayed): delete the empty channels. Default is 0 → also instant;
  // bump match_cleanup_delay_minutes if you want to keep the rooms around for
  // post-game discussion (which won't have anyone in them anyway, so usually
  // skip this).
  const delayMin = Number(Settings.get('match_cleanup_delay_minutes', '0'))
  const delayMs = immediate ? 0 : Math.max(0, delayMin) * 60_000

  const cleanupAt = new Date(Date.now() + delayMs)
  state.cleanupTimer = setTimeout(() => {
    deleteMatchChannels(client, matchId).catch((err) =>
      Logger.error(`deleteMatchChannels ${matchId} failed`, err),
    )
  }, delayMs)
  // Persist the deadline so a crash before the timer fires can still
  // resume the cleanup on the next bot startup.
  void persistCleanupAt(matchId, cleanupAt)

  Logger.info(
    `match-voice: ended match #${matchId} — moved ${movedBack} back, channels delete in ${delayMs}ms`,
  )
  return { ok: true, movedBack }
}

/**
 * Re-hydrate the in-memory liveMatches Map from the discord_match_voice
 * table. Called on bot boot before /internal endpoints accept traffic so a
 * crash mid-match can resume cleanup. Rows whose cleanup_at is already in
 * the past are cleaned up immediately; rows with a future cleanup_at get
 * a fresh setTimeout for the remaining delta; rows with cleanup_at NULL
 * (match still ongoing at crash time) just rebuild the in-memory entry —
 * /internal/match/end will eventually arrive and schedule cleanup normally.
 */
export async function restoreLiveMatches(client: Client): Promise<void> {
  let rows: Array<{ match_id: number; radiant_channel_id: string; dire_channel_id: string; cleanup_at: string | null }> = []
  try {
    rows = await query(
      `SELECT match_id, radiant_channel_id, dire_channel_id, cleanup_at FROM discord_match_voice`,
    )
  } catch (err) {
    Logger.warn(`match-voice: restoreLiveMatches query failed: ${(err as Error).message}`)
    return
  }
  if (!rows.length) return
  Logger.info(`match-voice: restoring ${rows.length} live match(es) from DB`)
  for (const r of rows) {
    liveMatches.set(r.match_id, {
      radiantChannelId: r.radiant_channel_id,
      direChannelId: r.dire_channel_id,
      cleanupTimer: null,
    })
    if (r.cleanup_at) {
      const due = new Date(r.cleanup_at).getTime()
      const remaining = due - Date.now()
      if (remaining <= 0) {
        // Cleanup window already elapsed — run now.
        deleteMatchChannels(client, r.match_id).catch((err) =>
          Logger.error(`restore: deleteMatchChannels(${r.match_id}) failed`, err),
        )
      } else {
        const timer = setTimeout(() => {
          deleteMatchChannels(client, r.match_id).catch((err) =>
            Logger.error(`restore: deleteMatchChannels(${r.match_id}) failed`, err),
          )
        }, remaining)
        const state = liveMatches.get(r.match_id)
        if (state) state.cleanupTimer = timer
      }
    }
  }
}

export function listLiveMatches(): Array<{ matchId: number; radiantChannelId: string; direChannelId: string }> {
  return [...liveMatches.entries()].map(([matchId, s]) => ({
    matchId,
    radiantChannelId: s.radiantChannelId,
    direChannelId: s.direChannelId,
  }))
}
