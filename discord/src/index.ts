import 'reflect-metadata'
import { Client, Events, GatewayIntentBits } from 'discord.js'
import { env } from './env.js'
import { Logger } from './services/logger.js'
import { ping as dbPing } from './services/db.js'
import { CommandManager } from './core/command-manager.js'
import { PluginManager } from './core/plugin-manager.js'
import { CronManager } from './core/cron-manager.js'

async function main(): Promise<void> {
  try {
    await dbPing()
    Logger.info('Connected to database')
  } catch (err) {
    Logger.error('Database ping failed (continuing anyway)', err)
  }

  // Only non-privileged intents by default. Add GuildMembers / GuildMessages /
  // MessageContent here AND flip them on at https://discord.com/developers
  // once a plugin actually needs them.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] })
  client.on('error', (e) => Logger.error('client error', e))

  await client.login(env.DISCORD_BOT_TOKEN)
  await new Promise<void>((res) => client.once('clientReady', () => res()))
  Logger.info(`Logged in as ${client.user?.tag}`)

  PluginManager.setClient(client)
  await PluginManager.load()
  PluginManager.bindHooks()

  await CommandManager.load()
  await CommandManager.registerCommands(client)

  CronManager.setClient(client)
  await CronManager.load()
  CronManager.start(client)

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      const cmd = CommandManager.get(interaction.commandName)
      if (!cmd) return
      try {
        await cmd.instance.execute(interaction, client)
      } catch (err) {
        Logger.error(`Command ${interaction.commandName} failed`, err)
        const reply = { content: 'Command failed.', ephemeral: true }
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(reply).catch(() => {})
        } else {
          await interaction.reply(reply).catch(() => {})
        }
      }
      return
    }

    if (interaction.isButton()) {
      const cmd = CommandManager.getByButtonPrefix(interaction.customId)
      if (!cmd) return
      try {
        await cmd.instance.buttonExecute(interaction, client)
      } catch (err) {
        Logger.error(`Button ${interaction.customId} failed`, err)
      }
      return
    }

    if (interaction.isAutocomplete()) {
      const cmd = CommandManager.get(interaction.commandName)
      if (!cmd) return
      try {
        await cmd.instance.autocomplete(interaction, client)
      } catch (err) {
        Logger.error(`Autocomplete ${interaction.commandName} failed`, err)
      }
    }
  })
}

const shutdown = (sig: string) => {
  Logger.info(`Received ${sig}, exiting`)
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

main().catch((err) => {
  Logger.error('Fatal startup error', err)
  process.exit(1)
})
