import express, { type NextFunction, type Request, type Response } from 'express'
import type { Client } from 'discord.js'
import { ChannelType } from 'discord.js'
import { env } from '../env.js'
import { Logger } from './logger.js'
import { Settings, loadSettings } from './settings.js'
import { startMatch, endMatch, listLiveMatches } from './match-voice.js'
import { PluginManager } from '../core/plugin-manager.js'

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

export function startInternalServer(client: Client): void {
  const app = express()
  app.use(express.json())

  app.get('/internal/health', (_req, res) => {
    res.json({
      ok: true,
      ready: client.isReady(),
      bot: client.user?.tag ?? null,
      settingsLoaded: Settings.isLoaded(),
    })
  })

  app.use('/internal', bearerAuth)

  app.get('/internal/roles', async (_req, res) => {
    const guildId = resolveGuildId()
    if (!guildId) {
      res.status(400).json({ error: 'guild_id not configured' })
      return
    }
    try {
      const guild = await client.guilds.fetch(guildId)
      await guild.roles.fetch()
      const roles: RoleDto[] = guild.roles.cache
        .filter((r) => r.id !== guild.roles.everyone.id)
        .map((r) => ({
          id: r.id,
          name: r.name,
          color: r.color,
          position: r.position,
          managed: r.managed,
          hoist: r.hoist,
          mentionable: r.mentionable,
        }))
        .sort((a, b) => b.position - a.position)
      res.json({ guildId, roles })
    } catch (err) {
      Logger.error('GET /internal/roles failed', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/internal/channels', async (_req, res) => {
    const guildId = resolveGuildId()
    if (!guildId) {
      res.status(400).json({ error: 'guild_id not configured' })
      return
    }
    try {
      const guild = await client.guilds.fetch(guildId)
      await guild.channels.fetch()
      const channels: ChannelDto[] = guild.channels.cache
        .map((c): ChannelDto => ({
          id: c.id,
          name: c.name,
          type: TYPE_MAP[c.type] ?? 'other',
          parentId: 'parentId' in c ? (c.parentId ?? null) : null,
          position: 'position' in c ? (c.position ?? 0) : 0,
        }))
        .sort((a, b) => a.position - b.position)
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
    try {
      const { matchId, queueMatchId, team1, team2 } = req.body ?? {}
      if (!matchId || !team1?.playerIds || !team2?.playerIds) {
        res.status(400).json({ error: 'matchId, team1.playerIds, team2.playerIds required' })
        return
      }
      const result = await startMatch(client, {
        matchId,
        queueMatchId,
        team1: { side: team1.side ?? 'radiant', playerIds: team1.playerIds },
        team2: { side: team2.side ?? 'dire', playerIds: team2.playerIds },
      })
      res.json(result)
    } catch (err) {
      Logger.error('POST /internal/match/start failed', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/internal/match/end', async (req, res) => {
    const { matchId, immediate } = req.body ?? {}
    if (!matchId) {
      res.status(400).json({ error: 'matchId required' })
      return
    }
    try {
      const result = await endMatch(client, Number(matchId), Boolean(immediate))
      res.json(result)
    } catch (err) {
      Logger.error('POST /internal/match/end failed', err)
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/internal/match/live', (_req, res) => {
    res.json({ matches: listLiveMatches() })
  })

  app.get('/internal/plugins', (_req, res) => {
    res.json({ plugins: PluginManager.listPluginsMeta() })
  })

  app.post('/internal/tournament/announce', (req, res) => {
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
