import type { PluginInfo } from '../types.js'
import { PluginManager } from '../plugin-manager.js'

export const Plugin = (info: PluginInfo): ClassDecorator => {
  return (target: any) => {
    PluginManager.loadPlugin({ info, target })
  }
}
