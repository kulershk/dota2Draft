import {
  ChannelType,
  EmbedBuilder,
  type Client,
  type GuildMember,
  type TextChannel,
} from 'discord.js'
import { Plugin } from '../core/decorators/plugin.js'
import { EventHook } from '../core/decorators/event-hook.js'
import { Logger } from '../services/logger.js'
import { Settings } from '../services/settings.js'
import { UserRepository } from '../services/user-repository.js'
import type { PluginInterface } from '../core/types.js'

@Plugin({ name: 'welcome', description: 'Greet new members in the configured welcome channel' })
export class Welcome implements PluginInterface {
  constructor(_client: Client) {}

  @EventHook()
  async onGuildMemberAdd(member: GuildMember): Promise<void> {
    Logger.info(`[welcome] guildMemberAdd fired: ${member.user.tag}`)
    if (member.user.bot) return
    const channelId = Settings.get('welcome_channel_id')
    if (!channelId) {
      Logger.info(`[welcome] discord_welcome_channel_id not set — skipping`)
      return
    }

    const channel = member.guild.channels.cache.get(channelId)
    if (!channel || channel.type !== ChannelType.GuildText) {
      Logger.warn(`[welcome] channel ${channelId} not found in guild ${member.guild.id} or not a text channel`)
      return
    }

    try {
      const user = await UserRepository.byDiscordId(member.id)
      const linked = Boolean(user?.steamId)

      const embed = new EmbedBuilder()
        .setColor(linked ? 0x2ecc71 : 0xf1c40f)
        .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
        .setTitle(`Sveicināts, ${member.displayName}! 👋`)

      if (linked && user) {
        embed
          .setDescription(
            `Tavs konts ir saistīts ar **${user.displayName}** uz dota.lv — Verified loma piešķirta automātiski. Glory Hunters! 🔥`,
          )
          .addFields(
            { name: 'Steam', value: `\`${user.steamId}\``, inline: true },
            { name: 'MMR', value: user.mmr ? String(user.mmr) : 'n/a', inline: true },
          )
      } else {
        embed.setDescription(
          [
            'Lai saņemtu **Verified** lomu un piedalītos turnīros:',
            '1. Pierakstīties caur Steam — https://dota.lv',
            '2. Profila iestatījumos sasaisti Discord kontu',
            '3. Atgriezies šeit un palaid `/verify`',
          ].join('\n'),
        )
      }

      await (channel as TextChannel).send({
        content: `<@${member.id}>`,
        embeds: [embed],
        allowedMentions: { users: [member.id] },
      })
      Logger.info(`welcome: posted for ${member.user.tag} (linked=${linked})`)
    } catch (err) {
      Logger.error(`welcome failed for ${member.user.tag}`, err)
    }
  }
}
