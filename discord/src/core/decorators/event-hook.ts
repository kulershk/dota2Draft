import { PluginManager } from '../plugin-manager.js'

export const EventHook = (): MethodDecorator => {
  return (target, key) => {
    const method = key.toString()
    if (!method.startsWith('on')) return
    const event = method.slice(2)
    PluginManager.loadHook({
      target: target.constructor.name,
      method,
      event: event.charAt(0).toLowerCase() + event.slice(1),
    })
  }
}
