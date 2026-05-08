import {
  ChannelType,
  EmbedBuilder,
  type Client,
  type TextChannel,
} from 'discord.js'
import { Plugin } from '../core/decorators/plugin.js'
import { EventHook } from '../core/decorators/event-hook.js'
import { Logger } from '../services/logger.js'
import { Settings } from '../services/settings.js'
import { htmlToDiscordMarkdown } from '../services/html-to-md.js'
import { env } from '../env.js'
import type { PluginInterface } from '../core/types.js'

// Payload that comes through internal-server's POST /internal/tournament/announce.
// Re-emitted on the discord client as the `tournamentAnnounce` event so this
// plugin can pick it up via @EventHook (method name onTournamentAnnounce).
export interface TournamentAnnouncePayload {
  id: number
  name: string
  description?: string | null
  startsAt?: string | null
  registrationStart?: string | null
  registrationEnd?: string | null
  competitionType?: string | null
  bannerUrl?: string | null
  publicUrl?: string | null
}

function fmtDate(iso?: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  // Compact UTC display — viewers see their local TZ via Discord <t:..:F> below.
  return `<t:${Math.floor(d.getTime() / 1000)}:F>`
}

@Plugin({
  name: 'tournamentAnnounce',
  description: 'Posts an embed in the tournament channel when a competition is created',
})
export class TournamentAnnounce implements PluginInterface {
  private readonly client: Client

  constructor(client: Client) {
    this.client = client
  }

  @EventHook()
  async onTournamentAnnounce(payload: TournamentAnnouncePayload): Promise<void> {
    const client = this.client
    const channelId = Settings.get('tournament_channel_id')
    if (!channelId) {
      Logger.info(`tournamentAnnounce: no channel configured, skipping comp #${payload.id}`)
      return
    }
    const guildId = Settings.get('guild_id', env.DISCORD_GUILD_ID)
    if (!guildId) {
      Logger.warn('tournamentAnnounce: guild_id not configured')
      return
    }

    let channel
    try {
      const guild = await client.guilds.fetch(guildId)
      channel = await guild.channels.fetch(channelId)
    } catch (err) {
      Logger.error(`tournamentAnnounce: failed to fetch channel`, err)
      return
    }
    if (!channel || channel.type !== ChannelType.GuildText) {
      Logger.warn(`tournamentAnnounce: channel ${channelId} not found or not text`)
      return
    }

    const fields: Array<{ name: string; value: string; inline?: boolean }> = []
    const startsAt = fmtDate(payload.startsAt)
    const regStart = fmtDate(payload.registrationStart)
    const regEnd = fmtDate(payload.registrationEnd)
    if (startsAt) fields.push({ name: 'Sākums', value: startsAt, inline: true })
    if (regStart) fields.push({ name: 'Reģistrācija sākas', value: regStart, inline: true })
    if (regEnd) fields.push({ name: 'Reģistrācija beidzas', value: regEnd, inline: true })
    if (payload.competitionType) {
      fields.push({ name: 'Formāts', value: payload.competitionType, inline: true })
    }

    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle(`🏆 ${payload.name}`)
      .setURL(payload.publicUrl ?? null)
    if (payload.description) {
      const md = htmlToDiscordMarkdown(payload.description)
      // Discord embed description hard-caps at 4096 chars; use 2000 as a comfy
      // limit to leave room for fields + footer.
      if (md) embed.setDescription(md.slice(0, 2000))
    }
    if (payload.bannerUrl) embed.setImage(payload.bannerUrl)
    if (fields.length) embed.addFields(...fields)
    if (payload.publicUrl) embed.addFields({ name: 'Pieteikšanās', value: payload.publicUrl })

    try {
      await (channel as TextChannel).send({ embeds: [embed] })
      Logger.info(`tournamentAnnounce: posted comp #${payload.id} (${payload.name})`)
    } catch (err) {
      Logger.error(`tournamentAnnounce: failed to send for comp #${payload.id}`, err)
    }
  }
}
