import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { Command } from '../core/decorators/command.js'
import { BaseCommand } from '../core/types.js'

@Command(new SlashCommandBuilder().setName('ping').setDescription('Check that the bot is alive'))
export class Ping extends BaseCommand {
  override async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sent = await interaction.reply({ content: 'Pinging…', fetchReply: true })
    const latency = sent.createdTimestamp - interaction.createdTimestamp
    await interaction.editReply(`Pong! Round-trip ${latency}ms · WS ${Math.round(interaction.client.ws.ping)}ms`)
  }
}
