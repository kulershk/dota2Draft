import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
} from 'discord.js'
import { Command } from '../core/decorators/command.js'
import { BaseCommand } from '../core/types.js'
import { MSG_FLAG_EPHEMERAL } from '../core/flags.js'
import { Logger } from '../services/logger.js'
import { UserRepository, type User } from '../services/user-repository.js'
import { ensureRole, findRole, ROLE_KEYS } from '../services/roles.js'

@Command(
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Re-check Steam linkage and grant the Verified role')
    .addSubcommand((s) =>
      s.setName('me').setDescription('Re-check your own linked Steam account'),
    )
    .addSubcommand((s) =>
      s
        .setName('checkall')
        .setDescription('(Admin) Scan every server member and verify anyone with linked Steam'),
    ),
)
export class Verify extends BaseCommand {
  override async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand()
    if (sub === 'checkall') return this.runCheckAll(interaction)
    return this.runMe(interaction)
  }

  private async runMe(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MSG_FLAG_EPHEMERAL })

    if (!interaction.inCachedGuild() || !interaction.member) {
      await interaction.editReply('This command can only be used inside the server.')
      return
    }

    const user = await UserRepository.byDiscordId(interaction.user.id)
    if (!user) {
      await interaction.editReply(
        'No linked draft account found. Sign in on https://dota.lv with Steam, then link Discord in your profile.',
      )
      return
    }
    if (!user.steamId) {
      await interaction.editReply(
        'Your account is on dota.lv but Steam is not linked. Sign in with Steam on the site, then re-run /verify me.',
      )
      return
    }

    const { added, role } = await ensureRole(interaction.member as GuildMember, ROLE_KEYS.Verified)
    if (!role) {
      await interaction.editReply(`Role "${ROLE_KEYS.Verified}" not found in this server. Ask a moderator.`)
      return
    }
    await interaction.editReply(
      added
        ? `Verified! You now have the **${role.name}** role (linked to ${user.displayName}).`
        : `You already have the **${role.name}** role.`,
    )
  }

  private async runCheckAll(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MSG_FLAG_EPHEMERAL })

    if (!interaction.inCachedGuild() || !interaction.guild || !interaction.member) {
      await interaction.editReply('This command can only be used inside the server.')
      return
    }

    // Permission gate — the slash builder doesn't expose per-subcommand
    // permissions, so we enforce here. ManageRoles is the closest match for
    // "person who'd be granting Verified manually anyway".
    const member = interaction.member as GuildMember
    if (!member.permissions.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.editReply('You need the **Manage Roles** permission to run /verify checkall.')
      return
    }

    const guild = interaction.guild as Guild
    const role = findRole(guild, ROLE_KEYS.Verified)
    if (!role) {
      await interaction.editReply(`Role "${ROLE_KEYS.Verified}" not found in this server. Set it in /admin/discord first.`)
      return
    }

    // Fetching every member requires the GuildMembers privileged intent.
    let members
    try {
      members = await guild.members.fetch()
    } catch (err) {
      Logger.error('[verify checkall] failed to fetch members', err)
      await interaction.editReply(
        'Failed to fetch server members. Make sure SERVER MEMBERS INTENT is enabled in the Developer Portal AND ENABLE_GUILD_MEMBERS_INTENT=true is set in the bot env.',
      )
      return
    }

    const humans = members.filter((m) => !m.user.bot)
    const discordIds = [...humans.values()].map((m) => m.id)
    const linked = await UserRepository.verifiableByDiscordIds(discordIds)

    let granted = 0
    let alreadyHad = 0
    let notLinked = 0
    let failed = 0
    const grantedNames: string[] = []
    const failures: string[] = []

    for (const m of humans.values()) {
      const linkedUser: User | undefined = linked.get(m.id)
      if (!linkedUser) {
        notLinked++
        continue
      }
      if (m.roles.cache.has(role.id)) {
        alreadyHad++
        continue
      }
      try {
        await m.roles.add(role, '/verify checkall')
        granted++
        if (grantedNames.length < 25) grantedNames.push(`${m.user.tag} (${linkedUser.displayName})`)
        Logger.info(`[verify checkall] granted ${role.name} → ${m.user.tag} (steam ${linkedUser.steamId})`)
      } catch (err) {
        failed++
        if (failures.length < 5) failures.push(`${m.user.tag}: ${(err as Error).message}`)
        Logger.warn(`[verify checkall] failed for ${m.user.tag}: ${(err as Error).message}`)
      }
    }

    const lines = [
      `**Scanned ${humans.size} members.**`,
      `🟢 Granted **${role.name}**: ${granted}`,
      `✅ Already verified: ${alreadyHad}`,
      `⚪ Not linked on dota.lv: ${notLinked}`,
    ]
    if (failed) lines.push(`❌ Failed: ${failed}`)
    if (grantedNames.length) {
      lines.push('', '**Newly verified:**', grantedNames.map((n) => `• ${n}`).join('\n'))
      if (granted > grantedNames.length) lines.push(`…and ${granted - grantedNames.length} more`)
    }
    if (failures.length) lines.push('', '**Failures:**', failures.map((f) => `• ${f}`).join('\n'))

    await interaction.editReply(lines.join('\n').slice(0, 1900))
  }
}
