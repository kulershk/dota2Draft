import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Client, REST, Routes, type RESTPostAPIApplicationCommandsJSONBody } from 'discord.js'
import { Logger } from '../services/logger.js'
import { env } from '../env.js'
import type { LoadedCommand, ManagedCommand, CommandInterface } from './types.js'
import { loadEntities } from './loader.js'

const CACHE_PATH = resolve(process.cwd(), '.command-cache.json')

export class CommandManager {
  static readonly commandStore = new Map<string, ManagedCommand>()

  static async load(): Promise<void> {
    await loadEntities('commands')
  }

  static loadCommand<T>(command: LoadedCommand<T>): void {
    const name = command.builder.name
    if (this.commandStore.has(name)) {
      Logger.warn(`Command '${name}' already loaded`)
      return
    }
    this.commandStore.set(name, {
      builder: command.builder,
      instance: new command.target() as CommandInterface,
      buttonPrefix: command.buttonPrefix,
    })
    Logger.info(`Loaded '${name}' command`)
  }

  static getByButtonPrefix(customId: string): ManagedCommand | null {
    const prefix = customId.split('_')[0]
    for (const [, cmd] of this.commandStore) {
      if (cmd.buttonPrefix && cmd.buttonPrefix === prefix) return cmd
    }
    return null
  }

  static get(name: string): ManagedCommand | undefined {
    return this.commandStore.get(name)
  }

  private static buildCommandJson(): RESTPostAPIApplicationCommandsJSONBody[] {
    return Array.from(this.commandStore.values()).map((c) => c.builder.toJSON())
  }

  static async registerCommands(_client: Client): Promise<void> {
    const body = this.buildCommandJson()
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')

    const cached = this.readCache()
    if (cached && cached.hash === hash && cached.scope === env.DISCORD_GUILD_ID) {
      Logger.info('Commands unchanged, skipping registration')
      return
    }

    const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN)
    const route = env.DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID)
      : Routes.applicationCommands(env.DISCORD_CLIENT_ID)

    await rest.put(route, { body })
    Logger.info(`Successfully registered ${body.length} application command(s)`)
    this.writeCache(hash)
  }

  private static readCache(): { hash: string; scope: string } | null {
    if (!existsSync(CACHE_PATH)) return null
    try {
      return JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    } catch {
      return null
    }
  }

  private static writeCache(hash: string): void {
    try {
      writeFileSync(CACHE_PATH, JSON.stringify({ hash, scope: env.DISCORD_GUILD_ID }), 'utf8')
    } catch (err) {
      Logger.warn(`Failed to write command cache: ${(err as Error).message}`)
    }
  }
}
