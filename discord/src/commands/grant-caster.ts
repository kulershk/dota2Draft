import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js'
import { Command } from '../core/decorators/command.js'
import { BaseCommand } from '../core/types.js'
import { UserRepository } from '../services/user-repository.js'
import { ensureRole, removeRole, ROLE_KEYS } from '../services/roles.js'

@Command(
  new SlashCommandBuilder()
    .setName('grant-caster')
    .setDescription('Grant or revoke the Caster role (admin/moderator only)')
    .addUserOption((o) =>
      o.setName('user').setDescription('The user to grant/revoke Caster').setRequired(true),
    )
    .addBooleanOption((o) =>
      o.setName('revoke').setDescription('Set true to remove the Caster role instead'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
)
export class GrantCaster extends BaseCommand {
  override async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true })

    if (!interaction.inCachedGuild() || !interaction.member) {
      await interaction.editReply('Server only.')
      return
    }
    // Permission gate is enforced by setDefaultMemberPermissions(ManageRoles)
    // on the slash command itself — Discord blocks unauthorized users from
    // even seeing it.

    const targetUser = interaction.options.getUser('user', true)
    const revoke = interaction.options.getBoolean('revoke') ?? false
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null)
    if (!member) {
      await interaction.editReply(`Could not find ${targetUser.tag} in this server.`)
      return
    }

    if (revoke) {
      const removed = await removeRole(member, ROLE_KEYS.Caster)
      await interaction.editReply(
        removed
          ? `Removed **${ROLE_KEYS.Caster}** from ${member.user.tag}.`
          : `${member.user.tag} did not have the **${ROLE_KEYS.Caster}** role.`,
      )
      return
    }

    const linked = await UserRepository.byDiscordId(targetUser.id)
    const twitchNote = linked?.raw.twitch_username
      ? ` (Twitch: \`${linked.raw.twitch_username}\`)`
      : linked
        ? ' (no Twitch linked on dota.lv)'
        : ' (not linked on dota.lv)'

    const { added, role } = await ensureRole(member, ROLE_KEYS.Caster)
    if (!role) {
      await interaction.editReply(`Role "${ROLE_KEYS.Caster}" not found in this server.`)
      return
    }
    await interaction.editReply(
      added
        ? `Granted **${role.name}** to ${member.user.tag}${twitchNote}.`
        : `${member.user.tag} already has **${role.name}**${twitchNote}.`,
    )
  }
}
