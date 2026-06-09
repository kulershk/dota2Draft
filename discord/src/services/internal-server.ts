import express, { type NextFunction, type Request, type Response } from 'express'
import type { Client } from 'discord.js'
import { ChannelType } from 'discord.js'
import { env } from '../env.js'
import { Logger } from './logger.js'
import { Settings, loadSettings } from './settings.js'
import { startMatch, endMatch, listLiveMatches } from './match-voice.js'
import { PluginManager } from '../core/plugin-manager.js'
import { DRAFT_EVENTS } from '../core/draft-events.js'

interface RoleDto {
  id: string
  name: string
  color: number
  position: number
  managed: boolean
  hoist: boolean
  mentionable: boolean
}

interface ChannelDto {
  id: string
  name: string
  type: 'text' | 'voice' | 'category' | 'announcement' | 'forum' | 'stage' | 'other'
  parentId: string | null
  position: number
}

const TYPE_MAP: Record<number, ChannelDto['type']> = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildStageVoice]: 'stage',
}

// Roles/channels/members change rarely but the admin UI fetches several of
// them in parallel on every page load. Hitting Discord's REST API on every
// request burns the rate limit and surfaces as "Request failed" in the UI.
// This small TTL cache collapses bursts into a single upstream fetch, dedupes
// concurrent in-flight requests, and — crucially — serves the last good value
// if a refresh fails (e.g. a 429), so a transient outage degrades to slightly
// stale data instead of an error.
const CACHE_TTL_MS = 60_000

interface CacheEntry<T> {
  value: T | null
  expiresAt: number
  inflight: Promise<T> | null
}

const caches = new Map<string, CacheEntry<unknown>>()

async function cached<T>(key: string, producer: () => Promise<T>): Promise<T> {
  const now = Date.now()
  let entry = caches.get(key) as CacheEntry<T> | undefined
  if (!entry) {
    entry = { value: null, expiresAt: 0, inflight: null }
    caches.set(key, entry as CacheEntry<unknown>)
  }

  // Fresh enough — serve from cache.
  if (entry.value !== null && now < entry.expiresAt) return entry.value
  // A refresh is already running — piggyback on it instead of firing another.
  if (entry.inflight) return entry.inflight

  const refresh = (async () => {
    try {
      const value = await producer()
      entry!.value = value
      entry!.expiresAt = Date.now() + CACHE_TTL_MS
      return value
    } catch (err) {
      // Serve stale data if we have any — better than a hard failure when
      // Discord is rate-limiting us. Only throw if the cache is empty.
      if (entry!.value !== null) {
        Logger.warn(`cache refresh for "${key}" failed, serving stale value`, err)
        return entry!.value
      }
      throw err
    } finally {
      entry!.inflight = null
    }
  })()

  entry.inflight = refresh
  return refresh
}

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = env.INTERNAL_TOKEN
  if (!expected) {
    res.status(503).json({ error: 'INTERNAL_TOKEN not configured' })
    return
  }
  const header = req.header('Authorization') ?? ''
  const got = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (got !== expected) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  next()
}

function resolveGuildId(): string {
  return Settings.get('guild_id', env.DISCORD_GUILD_ID)
}

// `getClient` resolves the *current* gateway client. It returns null while the
// bot is still connecting (or retrying a failed login), so the HTTP server can
// start — and answer /internal/health — before Discord is reachable. This is
// what keeps the admin Discord page from getting a 502: the server is always
// up, it just reports `ready: false` until the bot connects.
export function startInternalServer(getClient: () => Client | null): void {
  const app = express()
  app.use(express.json())

  app.get('/internal/health', (_req, res) => {
    const client = getClient()
    res.json({
      ok: true,
      ready: client?.isReady() ?? false,
      bot: client?.user?.tag ?? null,
      settingsLoaded: Settings.isLoaded(),
    })
  })

  app.use('/internal', bearerAuth)

  // Routes below need a live gateway connection. While the bot is still
  // connecting the client is null / not ready — fail fast with 503 so the
  // admin UI shows "bot not ready" instead of the handler throwing a confusing
  // 500. Health + plugins (static metadata) stay reachable regardless, so the
  // page can always render the bot's status.
  const READY_REQUIRED = new Set([
    '/internal/roles',
    '/internal/channels',
    '/internal/members',
    '/internal/match/start',
    '/internal/match/end',
    '/internal/send-message',
    '/internal/event',
    '/internal/tournament/announce',
  ])
  app.use((req, res, next) => {
    if (READY_REQUIRED.has(req.path) && !getClient()?.isReady()) {
      res.status(503).json({ error: 'bot not ready' })
      return
    }
    next()
  })

  app.get('/internal/roles', async (_req, res) => {
    const client = getClient()!
    const guildId = resolveGuildId()
    if (!guildId) {
      res.status(400).json({ error: 'guild_id not configured' })
      return
    }
    try {
      const roles = await cached(`roles:${guildId}`, async () => {
        const guild = await client.guilds.fetch(guildId)
        await guild.roles.fetch()
        return guild.roles.cache
          .filter((r) => r.id !== guild.roles.everyone.id)
          .map(
            (r): RoleDto => ({
              id: r.id,
              name: r.name,
              color: r.color,
              position: r.position,
              managed: r.managed,
              hoist: r.hoist,
              mentionable: r.mentionable,
            }),
          )
          .sort((a, b) => b.position - a.position)
      })
      res.json({ guildId, roles })
    } catch (err) {
      Logger.error('GET /internal/roles failed', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/internal/channels', async (_req, res) => {
    const client = getClient()!
    const guildId = resolveGuildId()
    if (!guildId) {
      res.status(400).json({ error: 'guild_id not configured' })
      return
    }
    try {
      const channels = await cached(`channels:${guildId}`, async () => {
        const guild = await client.guilds.fetch(guildId)
        await guild.channels.fetch()
        return guild.channels.cache
          .map(
            (c): ChannelDto => ({
              id: c.id,
              name: c.name,
              type: TYPE_MAP[c.type] ?? 'other',
              parentId: 'parentId' in c ? (c.parentId ?? null) : null,
              position: 'position' in c ? (c.position ?? 0) : 0,
            }),
          )
          .sort((a, b) => a.position - b.position)
      })
      res.json({ guildId, channels })
    } catch (err) {
      Logger.error('GET /internal/channels failed', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/internal/reload-settings', async (_req, res) => {
    await loadSettings()
    res.json({ ok: true })
  })

  app.post('/internal/match/start', async (req, res) => {
    const client = getClient()!
    try {
      const { matchId, queueMatchId, team1, team2 } = req.body ?? {}
      if (!matchId || !team1?.playerIds || !team2?.playerIds) {
        res.status(400).json({ error: 'matchId, team1.playerIds, team2.playerIds required' })
        return
      }
      const normalizedPayload = {
        matchId,
        queueMatchId,
        team1: { side: team1.side ?? 'radiant', captainName: team1.captainName, playerIds: team1.playerIds },
        team2: { side: team2.side ?? 'dire', captainName: team2.captainName, playerIds: team2.playerIds },
      }
      const result = await startMatch(client, normalizedPayload)
      // Fan out to plugins after the inline match-voice work succeeds. A
      // failed startMatch should NOT fire matchStarted (otherwise plugins
      // see ghost matches with no voice channels).
      if (result?.ok !== false) {
        client.emit(DRAFT_EVENTS.MATCH_STARTED as any, normalizedPayload)
      }
      res.json(result)
    } catch (err) {
      Logger.error('POST /internal/match/start failed', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/internal/match/end', async (req, res) => {
    const client = getClient()!
    const { matchId, immediate } = req.body ?? {}
    if (!matchId) {
      res.status(400).json({ error: 'matchId required' })
      return
    }
    try {
      const result = await endMatch(client, Number(matchId), Boolean(immediate))
      // Always emit matchEnded — plugins might want to react to a queue cancel
      // even if the bot had no voice channels for that match (result.ok=false).
      client.emit(DRAFT_EVENTS.MATCH_ENDED as any, { matchId: Number(matchId), immediate: Boolean(immediate) })
      res.json(result)
    } catch (err) {
      Logger.error('POST /internal/match/end failed', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/internal/match/live', (_req, res) => {
    res.json({ matches: listLiveMatches() })
  })

  app.get('/internal/members', async (_req, res) => {
    const client = getClient()!
    const guildId = resolveGuildId()
    if (!guildId) {
      res.status(400).json({ error: 'guild_id not configured' })
      return
    }
    try {
      const members = await cached(`members:${guildId}`, async () => {
        const guild = await client.guilds.fetch(guildId)
        // Forces a full member fetch — requires GuildMembers privileged intent.
        // Without it the cache only contains members the bot has seen interact.
        await guild.members.fetch().catch(() => {})
        return [...guild.members.cache.values()]
          .filter((m) => !m.user.bot)
          .map((m) => ({
            id: m.id,
            username: m.user.username,
            displayName: m.displayName ?? m.user.username,
            avatarUrl: m.user.displayAvatarURL({ size: 64 }),
          }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
      })
      res.json({ guildId, members })
    } catch (err) {
      Logger.error('GET /internal/members failed', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/internal/plugins', (_req, res) => {
    res.json({ plugins: PluginManager.listPluginsMeta() })
  })

  // Generic event bus: any caller can fire an arbitrary draft event via
  // `discordBot.emit('myEvent', payload)` server-side and have it land on
  // every plugin with a matching `@EventHook on<MyEvent>` handler. No
  // dedicated bot endpoint needed for new event types.
  app.post('/internal/event', (req, res) => {
    const client = getClient()!
    const { type, payload } = req.body ?? {}
    if (typeof type !== 'string' || !type.length) {
      res.status(400).json({ error: 'type (string) required' })
      return
    }
    client.emit(type as any, payload)
    res.json({ ok: true })
  })

  // Post an admin-authored message (plain content and/or rich embeds) to a
  // guild channel as the bot. Backs the "Announcer" tab in the admin Discord
  // settings page — the admin pastes the embed JSON, previews it, and sends.
  // Embeds are passed straight through as Discord API embed objects; Discord
  // validates them and any error is surfaced back to the UI.
  app.post('/internal/send-message', async (req, res) => {
    const client = getClient()!
    const { channelId, content, embeds } = req.body ?? {}
    if (channelId == null || String(channelId).length === 0) {
      res.status(400).json({ error: 'channelId required' })
      return
    }
    const hasContent = typeof content === 'string' && content.trim().length > 0
    const hasEmbeds = Array.isArray(embeds) && embeds.length > 0
    if (!hasContent && !hasEmbeds) {
      res.status(400).json({ error: 'content or embeds required' })
      return
    }
    if (Array.isArray(embeds) && embeds.length > 10) {
      res.status(400).json({ error: 'a message can have at most 10 embeds' })
      return
    }
    try {
      const channel = await client.channels.fetch(String(channelId))
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        res.status(400).json({ error: 'channel not found or not a text channel' })
        return
      }
      const msg = await (channel as any).send({
        content: hasContent ? content : undefined,
        embeds: hasEmbeds ? embeds : undefined,
      })
      res.json({ ok: true, messageId: msg.id, channelId: String(channelId) })
    } catch (err) {
      Logger.error('POST /internal/send-message failed', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/internal/tournament/announce', (req, res) => {
    const client = getClient()!
    const payload = req.body
    if (!payload || typeof payload.id !== 'number' || typeof payload.name !== 'string') {
      res.status(400).json({ error: 'id (number) and name (string) required' })
      return
    }
    // Custom event, picked up by plugins via @EventHook on onTournamentAnnounce.
    // Goes through the same enable-gate as Discord-native events.
    client.emit('tournamentAnnounce' as any, payload)
    res.json({ ok: true })
  })

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    Logger.error('internal server error', err)
    res.status(500).json({ error: err.message })
  })

  app.listen(env.INTERNAL_PORT, () => {
    Logger.info(`Internal HTTP server listening on :${env.INTERNAL_PORT}`)
  })
}
