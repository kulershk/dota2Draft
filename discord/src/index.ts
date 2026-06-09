import 'reflect-metadata'
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'
import { MSG_FLAG_EPHEMERAL } from './core/flags.js'
import { env } from './env.js'
import { Logger } from './services/logger.js'
import { ping as dbPing } from './services/db.js'
import { CommandManager } from './core/command-manager.js'
import { PluginManager } from './core/plugin-manager.js'
import { CronManager } from './core/cron-manager.js'
import { loadSettings, startSettingsRefresh } from './services/settings.js'
import { startInternalServer } from './services/internal-server.js'
import { restoreLiveMatches } from './services/match-voice.js'

// The current gateway client, or null while (re)connecting. Published only
// after a fully-successful login + init so the internal server's readiness
// gate doesn't expose a half-initialised client.
let activeClient: Client | null = null

function buildClient(): Client {
  // Guilds + GuildVoiceStates are non-privileged (needed for /queue match
  // voice channels — listing/moving members in voice).
  // GuildMembers is privileged — opt in via ENABLE_GUILD_MEMBERS_INTENT=true
  // AFTER toggling SERVER MEMBERS INTENT at https://discord.com/developers.
  // Without it, the auto-verify plugin's onGuildMemberAdd hook never fires.
  // GuildMessageReactions + Message/Channel/Reaction partials power the
  // reaction-roles plugin — without partials, reactions on messages older
  // than the bot's cache silently never fire.
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ]
  if (env.ENABLE_GUILD_MEMBERS_INTENT) intents.push(GatewayIntentBits.GuildMembers)
  Logger.info(`Intents: ${intents.map((i) => GatewayIntentBits[i]).join(', ')} (ENABLE_GUILD_MEMBERS_INTENT=${env.ENABLE_GUILD_MEMBERS_INTENT})`)
  const client = new Client({
    intents,
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  })
  client.on('error', (e) => Logger.error('client error', e))

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      const cmd = CommandManager.get(interaction.commandName)
      if (!cmd) return
      try {
        await cmd.instance.execute(interaction, client)
      } catch (err) {
        Logger.error(`Command ${interaction.commandName} failed`, err)
        const reply = { content: 'Command failed.', flags: MSG_FLAG_EPHEMERAL }
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

  return client
}

// Connect to Discord and run the post-login init, retrying forever on failure.
// A bad token or a Discord gateway outage must NOT take the process down: the
// internal HTTP server is already listening, so /admin/discord keeps loading
// and shows "bot not ready" (with the cause in these logs) instead of a 502.
async function connectAndInit(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const client = buildClient()
    try {
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

      // Re-hydrate match-voice state from DB before we publish the client, so
      // an inbound /internal/match/end for a crash-resumed match finds its
      // entry in liveMatches (until published, that route returns 503).
      await restoreLiveMatches(client)

      activeClient = client
      Logger.info('Bot fully initialised')
      return
    } catch (err) {
      const delayMs = Math.min(60_000, 5_000 * attempt)
      Logger.error(`Discord login/init failed (attempt ${attempt}); retrying in ${delayMs}ms`, err)
      activeClient = null
      try { await client.destroy() } catch {}
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

async function main(): Promise<void> {
  try {
    await dbPing()
    Logger.info('Connected to database')
    await loadSettings()
    startSettingsRefresh()
  } catch (err) {
    Logger.error('Database ping failed (continuing anyway)', err)
  }

  // Start the internal HTTP server FIRST, before logging in to Discord. This
  // keeps /internal/health (and the admin Discord page) reachable even while
  // the bot is still connecting or retrying a failed login — the readiness
  // gate degrades client-dependent routes to 503 instead of the whole server
  // being unreachable (which surfaced as a 502 in the admin UI).
  startInternalServer(() => activeClient)

  await connectAndInit()
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
