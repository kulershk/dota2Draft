import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { Command } from '../core/decorators/command.js'
import { BaseCommand } from '../core/types.js'
import { Api } from '../services/api.js'

@Command(new SlashCommandBuilder().setName('status').setDescription('Show draft API status'))
export class Status extends BaseCommand {
  override async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply()
    try {
      const data = await Api.homeStats()
      const lines = Object.entries(data).map(([k, v]) => `**${k}**: ${String(v)}`)
      await interaction.editReply(lines.join('\n') || 'No data')
    } catch (err) {
      await interaction.editReply(`API unreachable: ${(err as Error).message}`)
    }
  }
}
