import type { Client } from 'discord.js'
import { Plugin } from '../core/decorators/plugin.js'
import { EventHook } from '../core/decorators/event-hook.js'
import { Logger } from '../services/logger.js'
import { Settings } from '../services/settings.js'
import { env } from '../env.js'
import { ensureRole, removeRole, ROLE_KEYS } from '../services/roles.js'
import type { SubscriptionChangedPayload } from '../core/draft-events.js'
import type { PluginInterface } from '../core/types.js'

@Plugin({
  name: 'subscriberRole',
  description: 'Grant/remove the Subscriber role when a site subscription is activated or cancelled',
})
export class SubscriberRole implements PluginInterface {
  constructor(private client: Client) {}

  @EventHook()
  async onSubscriptionChanged(payload: SubscriptionChangedPayload): Promise<void> {
    if (!payload?.discordId) return
    const guildId = Settings.get('guild_id', env.DISCORD_GUILD_ID)
    if (!guildId) {
      Logger.warn('[subscriberRole] guild_id not configured — skipping')
      return
    }
    try {
      const guild = await this.client.guilds.fetch(guildId)
      // Member may not be in the guild (linked Discord but never joined) — that's
      // a no-op, not an error.
      const member = await guild.members.fetch(payload.discordId).catch(() => null)
      if (!member) {
        Logger.info(`[subscriberRole] member ${payload.discordId} not in guild — skipping`)
        return
      }
      if (payload.active) {
        const { added, role } = await ensureRole(member, ROLE_KEYS.Subscriber)
        if (!role) {
          Logger.warn(
            '[subscriberRole] Subscriber role not found — set discord_role_id_subscriber in /admin/discord, or create a role named "Subscriber".',
          )
        } else {
          Logger.info(`[subscriberRole] ${added ? 'granted' : 'already had'} Subscriber for ${member.user.tag}`)
        }
      } else {
        const removed = await removeRole(member, ROLE_KEYS.Subscriber)
        Logger.info(`[subscriberRole] ${removed ? 'removed' : 'no-op'} Subscriber for ${member.user.tag}`)
      }
    } catch (err) {
      Logger.error(`[subscriberRole] failed for ${payload.discordId}`, err)
    }
  }
}
