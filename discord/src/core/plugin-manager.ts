import type { Client, ClientEvents } from 'discord.js'
import { Logger } from '../services/logger.js'
import { Settings } from '../services/settings.js'
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

  // True if the plugin is enabled for runtime hook firing. Default = the
  // @Plugin({ enabled }) info value (defaults to true). Admins override per
  // plugin via the `discord_plugin_<pluginName>_enabled` setting key.
  static isPluginEnabled(pluginClassName: string): boolean {
    const managed = this.pluginStore.get(pluginClassName)
    if (!managed) return false
    const defaultEnabled = managed.info.enabled !== false
    return Settings.getBool(`plugin_${managed.info.name}_enabled`, defaultEnabled)
  }

  static listPluginsMeta(): Array<{ name: string; description: string; class: string; enabled: boolean }> {
    return [...this.pluginStore.entries()].map(([cls, m]) => ({
      class: cls,
      name: m.info.name,
      description: m.info.description,
      enabled: this.isPluginEnabled(cls),
    }))
  }

  static bindHooks(): void {
    const client = this.getClient()
    for (const [event, hooks] of this.hookStore) {
      client.on(event as keyof ClientEvents, (...args: any[]) => {
        for (const hook of hooks) {
          const managed = this.pluginStore.get(hook.target)
          if (!managed) continue
          // Central enable-gate. Plugins themselves no longer need to read
          // settings — toggling here turns every @EventHook on the plugin
          // off in one place.
          if (!this.isPluginEnabled(hook.target)) continue
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
