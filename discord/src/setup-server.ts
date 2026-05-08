import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type Role,
} from 'discord.js'
import { env } from './env.js'

interface RoleDef {
  name: string
  color: number
  permissions: bigint[]
  hoist: boolean
}

const ROLES: RoleDef[] = [
  { name: 'Admin', color: 0xE74C3C, permissions: [PermissionFlagsBits.Administrator], hoist: true },
  {
    name: 'Moderator',
    color: 0x3498DB,
    permissions: [
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.MuteMembers,
      PermissionFlagsBits.MoveMembers,
      PermissionFlagsBits.ManageThreads,
    ],
    hoist: true,
  },
  { name: 'Caster', color: 0x9B59B6, permissions: [], hoist: true },
  { name: 'Captain', color: 0xF1C40F, permissions: [], hoist: true },
  { name: 'Player', color: 0x2ECC71, permissions: [], hoist: false },
]

interface ChannelDef {
  name: string
  type: 'text' | 'voice'
  readonly?: boolean
}

interface CategoryDef {
  name: string
  visibleTo?: string[]
  channels: ChannelDef[]
}

const STAFF = ['Admin', 'Moderator']
const CAPTAINS_VIEW = ['Admin', 'Moderator', 'Captain']
const CASTERS_VIEW = ['Admin', 'Moderator', 'Caster']

const STRUCTURE: CategoryDef[] = [
  {
    name: '📢 INFO',
    channels: [
      { name: 'welcome', type: 'text', readonly: true },
      { name: 'rules', type: 'text', readonly: true },
      { name: 'announcements', type: 'text', readonly: true },
    ],
  },
  {
    name: '💬 COMMUNITY',
    channels: [
      { name: 'general', type: 'text' },
      { name: 'lfg', type: 'text' },
      { name: 'memes', type: 'text' },
      { name: 'off-topic', type: 'text' },
    ],
  },
  {
    name: '🏆 TOURNAMENTS',
    channels: [
      { name: 'tournament-info', type: 'text', readonly: true },
      { name: 'signups', type: 'text' },
      { name: 'brackets', type: 'text', readonly: true },
      { name: 'match-discussion', type: 'text' },
    ],
  },
  {
    name: '👑 CAPTAINS',
    visibleTo: CAPTAINS_VIEW,
    channels: [
      { name: 'captains-chat', type: 'text' },
      { name: 'captains-strategy', type: 'text' },
    ],
  },
  {
    name: '🎙️ CASTERS',
    visibleTo: CASTERS_VIEW,
    channels: [
      { name: 'casters-chat', type: 'text' },
      { name: 'stream-coordination', type: 'text' },
    ],
  },
  {
    name: '🛠️ STAFF',
    visibleTo: STAFF,
    channels: [
      { name: 'mod-chat', type: 'text' },
      { name: 'mod-logs', type: 'text' },
    ],
  },
  {
    name: '🎫 SUPPORT',
    channels: [{ name: 'support', type: 'text' }],
  },
  {
    name: '🔊 VOICE',
    channels: [
      { name: 'General Voice', type: 'voice' },
      { name: 'Lobby 1', type: 'voice' },
      { name: 'Lobby 2', type: 'voice' },
      { name: 'Lobby 3', type: 'voice' },
      { name: 'Lobby 4', type: 'voice' },
      { name: 'Lobby 5', type: 'voice' },
      { name: 'Casting Booth 1', type: 'voice' },
      { name: 'Casting Booth 2', type: 'voice' },
      { name: 'AFK', type: 'voice' },
    ],
  },
]

async function ensureRole(guild: Guild, def: RoleDef): Promise<Role> {
  const existing = guild.roles.cache.find((r) => r.name === def.name)
  if (existing) {
    console.log(`role exists: ${def.name}`)
    return existing
  }
  const role = await guild.roles.create({
    name: def.name,
    colors: { primaryColor: def.color },
    permissions: def.permissions,
    hoist: def.hoist,
    reason: 'Server bootstrap',
  })
  console.log(`created role: ${def.name}`)
  return role
}

async function main(): Promise<void> {
  if (!env.DISCORD_GUILD_ID) throw new Error('DISCORD_GUILD_ID is required for setup-server')

  const client = new Client({ intents: [GatewayIntentBits.Guilds] })
  client.on('error', (e) => console.error('client error:', e))
  await client.login(env.DISCORD_BOT_TOKEN)
  await new Promise<void>((res) => client.once('clientReady', () => res()))

  const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID)
  await guild.channels.fetch()
  await guild.roles.fetch()

  const roles = new Map<string, Role>()
  for (const def of ROLES) {
    roles.set(def.name, await ensureRole(guild, def))
  }

  const everyoneId = guild.roles.everyone.id

  for (const cat of STRUCTURE) {
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === cat.name,
    ) as CategoryChannel | undefined

    const categoryOverwrites = cat.visibleTo
      ? [
          { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
          ...cat.visibleTo.map((r) => ({
            id: roles.get(r)!.id,
            allow: [PermissionFlagsBits.ViewChannel],
          })),
        ]
      : []

    if (!category) {
      category = await guild.channels.create({
        name: cat.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: categoryOverwrites,
        reason: 'Server bootstrap',
      })
      console.log(`created category: ${cat.name}`)
    } else {
      console.log(`category exists: ${cat.name}`)
    }

    for (const ch of cat.channels) {
      const exists = guild.channels.cache.find(
        (c) =>
          c.parentId === category!.id &&
          c.name.toLowerCase() === ch.name.toLowerCase(),
      )
      if (exists) {
        console.log(`  channel exists: ${ch.name}`)
        continue
      }
      const channelOverwrites = ch.readonly
        ? [
            { id: everyoneId, deny: [PermissionFlagsBits.SendMessages] },
            ...STAFF.map((r) => ({
              id: roles.get(r)!.id,
              allow: [PermissionFlagsBits.SendMessages],
            })),
          ]
        : undefined

      await guild.channels.create({
        name: ch.name,
        type: ch.type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: channelOverwrites,
        reason: 'Server bootstrap',
      })
      console.log(`  created channel: ${ch.name}`)
    }
  }

  const afk = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildVoice && c.name === 'AFK',
  )
  if (afk) {
    await guild.setAFKChannel(afk.id)
    await guild.setAFKTimeout(300)
    console.log('AFK channel configured (5min timeout)')
  }

  console.log('Setup complete.')
  await client.destroy()
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
