import { SlashCommandBuilder, type ChatInputCommandInteraction, type GuildMember } from 'discord.js'
import { Command } from '../core/decorators/command.js'
import { BaseCommand } from '../core/types.js'
import { MSG_FLAG_EPHEMERAL } from '../core/flags.js'
import { UserRepository } from '../services/user-repository.js'
import { ensureRole, ROLE_KEYS } from '../services/roles.js'

@Command(
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Re-check your linked Steam account and grant the Player role'),
)
export class Verify extends BaseCommand {
  override async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MSG_FLAG_EPHEMERAL })

    if (!interaction.inCachedGuild() || !interaction.member) {
      await interaction.editReply('This command can only be used inside the server.')
      return
    }

    const user = await UserRepository.byDiscordId(interaction.user.id)
    if (!user) {
      await interaction.editReply(
        'No linked draft account found. Sign in on https://dota.lv with Steam, then link Discord in your profile.',
      )
      return
    }
    if (!user.steamId) {
      await interaction.editReply(
        'Your account is on dota.lv but Steam is not linked. Sign in with Steam on the site, then re-run /verify.',
      )
      return
    }

    const { added, role } = await ensureRole(interaction.member as GuildMember, ROLE_KEYS.Verified)
    if (!role) {
      await interaction.editReply(`Role "${ROLE_KEYS.Verified}" not found in this server. Ask a moderator.`)
      return
    }
    await interaction.editReply(
      added
        ? `Verified! You now have the **${role.name}** role (linked to ${user.displayName}).`
        : `You already have the **${role.name}** role.`,
    )
  }
}
