import type { Client, GuildMember } from 'discord.js'
import { Plugin } from '../core/decorators/plugin.js'
import { EventHook } from '../core/decorators/event-hook.js'
import { Logger } from '../services/logger.js'
import { UserRepository } from '../services/user-repository.js'
import { ensureRole, ROLE_KEYS } from '../services/roles.js'
import { Settings } from '../services/settings.js'
import type { PluginInterface } from '../core/types.js'

@Plugin({ name: 'autoVerify', description: 'Auto-grant Verified role on join when Steam is linked on the site' })
export class AutoVerify implements PluginInterface {
  constructor(_client: Client) {}

  @EventHook()
  async onGuildMemberAdd(member: GuildMember): Promise<void> {
    if (member.user.bot) return
    if (!Settings.getBool('auto_verify_enabled', true)) return
    try {
      const user = await UserRepository.byDiscordId(member.id)
      if (!user || !user.steamId) {
        Logger.info(`Member ${member.user.tag} joined — no linked Steam, skipping auto-verify`)
        return
      }
      const { added, role } = await ensureRole(member, ROLE_KEYS.Verified)
      if (added && role) {
        Logger.info(`Auto-verified ${member.user.tag} → ${role.name} (steam ${user.steamId})`)
      }
    } catch (err) {
      Logger.error(`Auto-verify failed for ${member.user.tag}`, err)
    }
  }
}
