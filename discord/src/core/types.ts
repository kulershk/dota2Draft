import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js'

export interface Type<T> {
  new (...args: any[]): T
}

export type EntityFolder = 'commands' | 'plugins' | 'jobs'

export type AnyCommandBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder

export interface CommandInterface {
  execute(interaction: ChatInputCommandInteraction, discord: Client): Promise<void>
  buttonExecute(interaction: ButtonInteraction, discord: Client): Promise<void>
  autocomplete(interaction: AutocompleteInteraction, discord: Client): Promise<void>
}

export class BaseCommand implements CommandInterface {
  async execute(_interaction: ChatInputCommandInteraction, _discord: Client): Promise<void> {}
  async buttonExecute(_interaction: ButtonInteraction, _discord: Client): Promise<void> {}
  async autocomplete(_interaction: AutocompleteInteraction, _discord: Client): Promise<void> {}

  parseCustomId(customId: string): string[] {
    return customId.split('_')
  }
}

export interface ManagedCommand {
  builder: AnyCommandBuilder
  instance: CommandInterface
  buttonPrefix: string | null
}

export interface LoadedCommand<T> {
  builder: AnyCommandBuilder
  target: Type<T>
  buttonPrefix: string | null
}

export interface PluginInfo {
  name: string
  description: string
  enabled?: boolean
}

export interface PluginInterface {}

export interface ManagedPlugin {
  info: PluginInfo
  instance: any
}

export interface LoadedPlugin<T> {
  info: PluginInfo
  target: Type<T>
}

export interface EventHookInfo {
  target: string
  method: string
  event: string
}

export interface JobInfo {
  name: string
  description: string
  cronTime: string
  enabled?: boolean
}

export interface JobInterface {
  execute(): Promise<void>
}

export interface ManagedJob {
  info: JobInfo
  instance: JobInterface
}

export interface LoadedJob<T> {
  info: JobInfo
  target: Type<T>
}
