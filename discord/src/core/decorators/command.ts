import type { AnyCommandBuilder } from '../types.js'
import { CommandManager } from '../command-manager.js'

export const Command = (builder: AnyCommandBuilder, buttonPrefix: string | null = null): ClassDecorator => {
  return (target: any) => {
    CommandManager.loadCommand({ builder, target, buttonPrefix })
  }
}
