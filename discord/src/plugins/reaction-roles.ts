import type {
  Client,
  Message,
  MessageReaction,
  PartialMessage,
  PartialMessageReaction,
  PartialUser,
  User,
} from 'discord.js'
import { Plugin } from '../core/decorators/plugin.js'
import { EventHook } from '../core/decorators/event-hook.js'
import { Logger } from '../services/logger.js'
import { Settings } from '../services/settings.js'
import { query, execute } from '../services/db.js'
import { addRoleById, removeRoleById } from '../services/roles.js'
import type { PluginInterface } from '../core/types.js'
import type { ReactionRolePayload } from '../core/draft-events.js'

interface ReactionRoleRow {
  id: number
  guild_id: string
  channel_id: string
  message_id: string
  emoji: string
  role_id: string
}

// Build the same string we store in the DB so lookups are exact-match. Unicode
// emoji uses .name (the character). Custom guild emoji is stored as `name:id`.
function emojiKey(reaction: MessageReaction | PartialMessageReaction): string {
  const e = reaction.emoji
  if (e.id) return `${e.name ?? ''}:${e.id}`
  return e.name ?? ''
}

// Convert the stored key back into something `message.react()` accepts. For
// unicode that's the raw character; for custom emoji it's the snowflake id.
function reactArg(stored: string): string {
  const m = stored.match(/^(.+):(\d+)$/)
  return m ? m[2] : stored
}

@Plugin({
  name: 'reactionRoles',
  description: 'Assign or remove a Discord role when users react to / un-react from a configured message',
})
export class ReactionRolesPlugin implements PluginInterface {
  constructor(private client: Client) {
    // Defer until the next tick so PluginManager.bindHooks() has wired up the
    // central enable-gate before any startup work fires.
    setImmediate(() => {
      void this.hydrate().catch((err) => Logger.error('[reactionRoles] hydrate failed', err))
    })
  }

  // Startup: for every configured mapping, make sure the bot's own reaction is
  // present, then catch up anyone who reacted while the bot was offline.
  // Skipped when the plugin is disabled via the settings toggle — runtime
  // hooks are gated centrally in PluginManager.bindHooks, but this startup
  // path runs from the constructor (no enable-gate), so we re-check here.
  private async hydrate(): Promise<void> {
    if (!Settings.getBool('plugin_reactionRoles_enabled', true)) return
    const rows = await query<ReactionRoleRow>(
      `SELECT id, guild_id, channel_id, message_id, emoji, role_id FROM discord_reaction_roles`,
    )
    if (!rows.length) return
    Logger.info(`[reactionRoles] hydrating ${rows.length} mapping(s)`)
    // Group rows by message — one channel/message fetch covers every emoji on it.
    const byMessage = new Map<string, ReactionRoleRow[]>()
    for (const r of rows) {
      const k = `${r.channel_id}:${r.message_id}`
      const arr = byMessage.get(k) ?? []
      arr.push(r)
      byMessage.set(k, arr)
    }
    for (const group of byMessage.values()) {
      try {
        await this.hydrateMessage(group)
      } catch (err) {
        Logger.warn(`[reactionRoles] hydrate skipped ${group[0].channel_id}/${group[0].message_id}: ${(err as Error).message}`)
      }
    }
  }

  private async hydrateMessage(group: ReactionRoleRow[]): Promise<void> {
    const sample = group[0]
    const channel = await this.client.channels.fetch(sample.channel_id)
    if (!channel || !('messages' in channel)) return
    const message = await channel.messages.fetch(sample.message_id)
    for (const row of group) {
      const arg = reactArg(row.emoji)
      const existing = message.reactions.cache.find((r) => emojiKey(r) === row.emoji)
      if (!existing) {
        await message.react(arg).catch((err) => {
          Logger.warn(`[reactionRoles] react seed failed (${row.emoji}): ${(err as Error).message}`)
        })
        continue
      }
      // Catch up: anyone whose reaction we missed while offline gets the role now.
      try {
        const users = await existing.users.fetch()
        for (const [, u] of users) {
          if (u.bot) continue
          await this.grantToMember(row, u.id).catch(() => {})
        }
      } catch (err) {
        Logger.warn(`[reactionRoles] catch-up users fetch failed: ${(err as Error).message}`)
      }
    }
  }

  private async grantToMember(row: ReactionRoleRow, userId: string): Promise<void> {
    const guild = await this.client.guilds.fetch(row.guild_id).catch(() => null)
    if (!guild) return
    const member = await guild.members.fetch(userId).catch(() => null)
    if (!member) return
    const added = await addRoleById(member, row.role_id, `reaction-role: ${row.emoji}`)
    if (added) Logger.info(`[reactionRoles] +${row.role_id} for ${member.user.tag}`)
  }

  private async revokeFromMember(row: ReactionRoleRow, userId: string): Promise<void> {
    const guild = await this.client.guilds.fetch(row.guild_id).catch(() => null)
    if (!guild) return
    const member = await guild.members.fetch(userId).catch(() => null)
    if (!member) return
    const removed = await removeRoleById(member, row.role_id, `reaction-role: un-${row.emoji}`)
    if (removed) Logger.info(`[reactionRoles] -${row.role_id} for ${member.user.tag}`)
  }

  private async resolvePartials(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<{ reaction: MessageReaction; user: User } | null> {
    try {
      if (reaction.partial) await reaction.fetch()
      if (user.partial) await user.fetch()
      return { reaction: reaction as MessageReaction, user: user as User }
    } catch (err) {
      Logger.warn(`[reactionRoles] partial fetch failed: ${(err as Error).message}`)
      return null
    }
  }

  @EventHook()
  async onMessageReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (user.bot) return
    const resolved = await this.resolvePartials(reaction, user)
    if (!resolved) return
    const key = emojiKey(resolved.reaction)
    const messageId = resolved.reaction.message.id
    const row = await query<ReactionRoleRow>(
      `SELECT id, guild_id, channel_id, message_id, emoji, role_id
         FROM discord_reaction_roles WHERE message_id = $1 AND emoji = $2`,
      [messageId, key],
    )
    if (!row.length) return
    await this.grantToMember(row[0], resolved.user.id).catch((err) => {
      Logger.error(`[reactionRoles] grant failed for ${resolved.user.id}`, err)
    })
  }

  @EventHook()
  async onMessageReactionRemove(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (user.bot) return
    const resolved = await this.resolvePartials(reaction, user)
    if (!resolved) return
    const key = emojiKey(resolved.reaction)
    const messageId = resolved.reaction.message.id
    const row = await query<ReactionRoleRow>(
      `SELECT id, guild_id, channel_id, message_id, emoji, role_id
         FROM discord_reaction_roles WHERE message_id = $1 AND emoji = $2`,
      [messageId, key],
    )
    if (!row.length) return
    await this.revokeFromMember(row[0], resolved.user.id).catch((err) => {
      Logger.error(`[reactionRoles] revoke failed for ${resolved.user.id}`, err)
    })
  }

  // Admin added a mapping in /admin/discord. Go seed the bot's reaction so
  // users have something to click.
  @EventHook()
  async onReactionRoleAdded(payload: ReactionRolePayload): Promise<void> {
    if (!payload?.channelId || !payload.messageId || !payload.emoji) return
    try {
      const channel = await this.client.channels.fetch(payload.channelId)
      if (!channel || !('messages' in channel)) return
      const message = await channel.messages.fetch(payload.messageId)
      await message.react(reactArg(payload.emoji))
      Logger.info(`[reactionRoles] seeded ${payload.emoji} on message ${payload.messageId}`)
    } catch (err) {
      Logger.error(`[reactionRoles] seed reaction failed`, err)
    }
  }

  // Admin removed a mapping. Strip the bot's own reaction; existing role
  // holders keep the role (consistent with how toggling the plugin off works).
  @EventHook()
  async onReactionRoleRemoved(payload: ReactionRolePayload): Promise<void> {
    if (!payload?.channelId || !payload.messageId || !payload.emoji) return
    try {
      const channel = await this.client.channels.fetch(payload.channelId)
      if (!channel || !('messages' in channel)) return
      const message = await channel.messages.fetch(payload.messageId)
      const existing = message.reactions.cache.find((r) => emojiKey(r) === payload.emoji)
      if (existing) {
        await existing.users.remove(this.client.user!.id).catch(() => {})
      }
    } catch (err) {
      Logger.warn(`[reactionRoles] remove-seed failed: ${(err as Error).message}`)
    }
  }

  // If the watched message is deleted, drop its mappings so we don't leave
  // orphaned rows the admin can't see in any Discord channel.
  @EventHook()
  async onMessageDelete(message: Message | PartialMessage): Promise<void> {
    try {
      await execute(`DELETE FROM discord_reaction_roles WHERE message_id = $1`, [message.id])
    } catch (err) {
      Logger.warn(`[reactionRoles] cleanup on messageDelete failed: ${(err as Error).message}`)
    }
  }
}
