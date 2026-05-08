import type { Client, GuildMember } from 'discord.js'
import { Plugin } from '../core/decorators/plugin.js'
import { EventHook } from '../core/decorators/event-hook.js'
import { Logger } from '../services/logger.js'
import { UserRepository } from '../services/user-repository.js'
import { ensureRole, ROLE_KEYS } from '../services/roles.js'
import type { PluginInterface } from '../core/types.js'

@Plugin({ name: 'autoVerify', description: 'Auto-grant Verified role on join when Steam is linked on the site' })
export class AutoVerify implements PluginInterface {
  constructor(_client: Client) {}

  @EventHook()
  async onGuildMemberAdd(member: GuildMember): Promise<void> {
    Logger.info(`[autoVerify] guildMemberAdd fired: ${member.user.tag} (id=${member.id}, bot=${member.user.bot})`)
    if (member.user.bot) {
      Logger.info(`[autoVerify] skipping bot user`)
      return
    }
    try {
      const user = await UserRepository.byDiscordId(member.id)
      if (!user) {
        Logger.info(`[autoVerify] no draft account linked to Discord id ${member.id}`)
        return
      }
      if (!user.steamId) {
        Logger.info(`[autoVerify] draft account ${user.id} (${user.displayName}) found but Steam not linked — skipping`)
        return
      }
      const { added, role } = await ensureRole(member, ROLE_KEYS.Verified)
      if (!role) {
        Logger.warn(`[autoVerify] Verified role not found in guild — set discord_role_id_verified in /admin/discord, or ensure a role named "Verified" exists. Skipped ${member.user.tag}.`)
        return
      }
      if (added) {
        Logger.info(`[autoVerify] granted ${role.name} to ${member.user.tag} (steam ${user.steamId})`)
      } else {
        Logger.info(`[autoVerify] ${member.user.tag} already had ${role.name} — no change`)
      }
    } catch (err) {
      Logger.error(`[autoVerify] failed for ${member.user.tag}`, err)
    }
  }
}
