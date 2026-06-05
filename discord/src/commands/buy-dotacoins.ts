import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type GuildMember,
  type OverwriteResolvable,
  type TextChannel,
} from 'discord.js'
import { Command } from '../core/decorators/command.js'
import { BaseCommand } from '../core/types.js'
import { MSG_FLAG_EPHEMERAL } from '../core/flags.js'
import { Logger } from '../services/logger.js'
import { Settings } from '../services/settings.js'
import { UserRepository } from '../services/user-repository.js'
import { query, queryOne, execute } from '../services/db.js'

// Button customIds are matched by their first `_`-delimited token (see
// CommandManager.getByButtonPrefix), so this prefix must contain no underscore.
const BUTTON_PREFIX = 'buyticket'

// Configurable via the shared `settings` table (discord_* keys), same as the
// rest of the bot:
//   discord_buy_ticket_enabled        — "true"/"false" (default true)
//   discord_buy_ticket_category_id    — category to nest the ticket channel under
//   discord_buy_ticket_support_role_id— role granted access + pinged in the ticket
@Command(
  new SlashCommandBuilder()
    .setName('buydotacoins')
    .setDescription('Open a private ticket to buy dotacoins with PayPal or Revolut'),
  BUTTON_PREFIX,
)
export class BuyDotacoins extends BaseCommand {
  override async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MSG_FLAG_EPHEMERAL })

    if (!interaction.inCachedGuild() || !interaction.guild) {
      await interaction.editReply('This command can only be used inside the server.')
      return
    }
    if (!Settings.getBool('buy_ticket_enabled', true)) {
      await interaction.editReply('Dotacoin purchases are currently unavailable. Please check back later.')
      return
    }

    const guild = interaction.guild
    const opener = interaction.user

    // Dedupe: if the user already has an open ticket whose channel still
    // exists, point them at it instead of spawning another channel. If the
    // channel was deleted out from under us, mark the row closed and continue.
    const open = await query<{ id: number; channel_id: string }>(
      `SELECT id, channel_id FROM discord_buy_tickets WHERE opener_discord_id = $1 AND status = 'open'`,
      [opener.id],
    )
    for (const row of open) {
      const existing =
        guild.channels.cache.get(row.channel_id) ??
        (await guild.channels.fetch(row.channel_id).catch(() => null))
      if (existing) {
        await interaction.editReply(`You already have an open ticket: <#${row.channel_id}>`)
        return
      }
      await execute(
        `UPDATE discord_buy_tickets SET status = 'closed', closed_at = NOW() WHERE id = $1`,
        [row.id],
      )
    }

    const categoryId = Settings.get('buy_ticket_category_id')
    const category = categoryId
      ? ((guild.channels.cache.get(categoryId) as CategoryChannel | undefined) ?? null)
      : null
    const supportRoleId = Settings.get('buy_ticket_support_role_id')
    const botId = interaction.client.user?.id

    const overwrites: OverwriteResolvable[] = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: opener.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ]
    if (botId) {
      overwrites.push({
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
      })
    }
    if (supportRoleId) {
      overwrites.push({
        id: supportRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      })
    }

    // Discord lowercases channel names and strips invalid chars anyway; do it
    // ourselves so the stored/displayed name matches what's created.
    const safeName = `buy-${opener.username}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 90)

    let channel: TextChannel
    try {
      channel = await guild.channels.create({
        name: safeName,
        type: ChannelType.GuildText,
        parent: category?.id ?? undefined,
        topic: `Dotacoin purchase ticket — opened by ${opener.tag} (${opener.id})`,
        permissionOverwrites: overwrites,
        reason: `Dotacoin buy ticket for ${opener.tag}`,
      })
    } catch (err) {
      Logger.error('[buydotacoins] failed to create ticket channel', err)
      await interaction.editReply(
        'Could not create your ticket channel. The bot may be missing the **Manage Channels** permission, or the configured category is invalid — please ping a moderator.',
      )
      return
    }

    const linked = await UserRepository.byDiscordId(opener.id).catch(() => null)

    await execute(
      `INSERT INTO discord_buy_tickets (channel_id, opener_discord_id, opener_player_id, guild_id, status)
       VALUES ($1, $2, $3, $4, 'open')`,
      [channel.id, opener.id, linked?.id ?? null, guild.id],
    )

    const embed = new EmbedBuilder()
      .setTitle('💰 Buy dotacoins')
      .setColor(0xf5a623)
      .setDescription(
        [
          'Thanks for your interest! You can top up your dotacoins balance with **PayPal** or **Revolut**.',
          '',
          '**Rate:** 1 dotacoin = €0.01 (one euro cent) — so €1 = 100 dotacoins.',
          '',
          'Reply here with **how many dotacoins** you want and your **preferred payment method**, and a staff member will follow up with payment details.',
          linked
            ? `\nLinked account: **${linked.displayName}** — your purchase will be credited there.`
            : '\n⚠️ Your Discord isn\'t linked to a dota.lv account yet. Sign in with Steam on the site and link Discord in your profile so we can credit the right account.',
        ].join('\n'),
      )

    const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}_close`)
        .setLabel('Close ticket')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger),
    )

    const mention = supportRoleId ? `<@${opener.id}> <@&${supportRoleId}>` : `<@${opener.id}>`
    await channel
      .send({ content: mention, embeds: [embed], components: [closeRow] })
      .catch((err: unknown) => Logger.warn(`[buydotacoins] failed to post welcome message: ${(err as Error).message}`))

    await interaction.editReply(`Your ticket is ready: <#${channel.id}>`)
  }

  override async buttonExecute(interaction: ButtonInteraction): Promise<void> {
    const [, action] = this.parseCustomId(interaction.customId)
    if (action !== 'close') return

    if (!interaction.inCachedGuild() || !interaction.channel) {
      await interaction.reply({ content: 'This can only be used inside the server.', flags: MSG_FLAG_EPHEMERAL })
      return
    }

    const channelId = interaction.channelId
    const ticket = await queryOne<{ id: number; opener_discord_id: string }>(
      `SELECT id, opener_discord_id FROM discord_buy_tickets WHERE channel_id = $1`,
      [channelId],
    )

    // The opener can close their own ticket; otherwise require Manage Channels
    // (staff). Mirrors how tickets are normally closed in support flows.
    const member = interaction.member as GuildMember
    const isOpener = ticket?.opener_discord_id === interaction.user.id
    const isStaff = member.permissions.has(PermissionFlagsBits.ManageChannels)
    if (!isOpener && !isStaff) {
      await interaction.reply({
        content: 'Only the ticket opener or staff can close this ticket.',
        flags: MSG_FLAG_EPHEMERAL,
      })
      return
    }

    if (ticket) {
      await execute(
        `UPDATE discord_buy_tickets SET status = 'closed', closed_at = NOW() WHERE id = $1`,
        [ticket.id],
      ).catch(() => {})
    }

    await interaction.reply({ content: `Closing this ticket — deleting the channel in a moment…` }).catch(() => {})
    const ch = interaction.channel as TextChannel
    setTimeout(() => {
      ch.delete('Dotacoin buy ticket closed').catch((err: unknown) =>
        Logger.warn(`[buydotacoins] failed to delete channel ${channelId}: ${(err as Error).message}`),
      )
    }, 3000)
  }
}
