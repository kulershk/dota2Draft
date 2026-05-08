import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { Command } from '../core/decorators/command.js'
import { BaseCommand } from '../core/types.js'
import { UserRepository } from '../services/user-repository.js'

@Command(new SlashCommandBuilder().setName('whoami').setDescription('Show your linked draft account'))
export class WhoAmI extends BaseCommand {
  override async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true })
    const user = await UserRepository.byDiscordId(interaction.user.id)
    if (!user) {
      await interaction.editReply('No linked draft account. Sign in with Discord on the site to link.')
      return
    }
    const lines = [
      `**${user.displayName}** (id ${user.id})`,
      user.steamId ? `Steam: \`${user.steamId}\`` : 'Steam: not linked',
      `MMR: ${user.mmr ?? 'n/a'}`,
      `XP: ${user.totalXp} · Daily streak: ${user.dailyStreak}`,
    ]
    await interaction.editReply(lines.join('\n'))
  }
}
