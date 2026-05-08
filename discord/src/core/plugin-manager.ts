import type { Client, ClientEvents } from 'discord.js'
import { Logger } from '../services/logger.js'
import type {
  EventHookInfo,
  LoadedPlugin,
  ManagedPlugin,
} from './types.js'
import { loadEntities } from './loader.js'

export class PluginManager {
  private static _client: Client | null = null
  static readonly pluginStore = new Map<string, ManagedPlugin>()
  static readonly hookStore = new Map<string, EventHookInfo[]>()

  static setClient(client: Client): void {
    this._client = client
  }

  static getClient(): Client {
    if (!this._client) throw new Error('PluginManager: client not set')
    return this._client
  }

  static async load(): Promise<void> {
    await loadEntities('plugins')
  }

  static loadPlugin<T>(plugin: LoadedPlugin<T>): void {
    const name = plugin.target.name
    if (this.pluginStore.has(name)) {
      Logger.warn(`Plugin '${name}' already loaded`)
      return
    }
    if (plugin.info.enabled === false) return
    this.pluginStore.set(name, {
      info: plugin.info,
      instance: new plugin.target(this.getClient()),
    })
    Logger.info(`Loaded '${name}' plugin`)
  }

  static loadHook(hook: EventHookInfo): void {
    if (!this.hookStore.has(hook.event)) this.hookStore.set(hook.event, [])
    this.hookStore.get(hook.event)!.push(hook)
  }

  static bindHooks(): void {
    const client = this.getClient()
    for (const [event, hooks] of this.hookStore) {
      client.on(event as keyof ClientEvents, (...args: any[]) => {
        for (const hook of hooks) {
          const managed = this.pluginStore.get(hook.target)
          if (!managed) continue
          try {
            const fn = (managed.instance as any)[hook.method]
            if (typeof fn === 'function') fn.call(managed.instance, ...args)
          } catch (err) {
            Logger.error(`${hook.target}::${hook.method} threw`, err)
          }
        }
      })
    }
  }
}
