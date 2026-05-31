import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { requirePermission } from '../middleware/permissions.js'
import { discordBot } from '../services/discordBotClient.js'

const router = Router()

// Parses both raw IDs and full message links of the form
//   https://discord.com/channels/<guild>/<channel>/<message>
function parseMessageLink(input) {
  if (!input) return null
  const m = String(input).match(/channels\/(\d+)\/(\d+)\/(\d+)/)
  if (m) return { guildId: m[1], channelId: m[2], messageId: m[3] }
  return null
}

router.get('/api/admin/discord/reaction-roles', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_discord_settings')
  if (!admin) return
  const rows = await query(
    `SELECT r.id, r.guild_id, r.channel_id, r.message_id, r.emoji, r.role_id, r.label,
            r.created_by, r.created_at, p.name AS created_by_name
       FROM discord_reaction_roles r
       LEFT JOIN players p ON p.id = r.created_by
       ORDER BY r.created_at DESC`,
  )
  res.json({ rows })
})

router.post('/api/admin/discord/reaction-roles', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_discord_settings')
  if (!admin) return

  const body = req.body || {}
  let guildId = String(body.guild_id || '').trim()
  let channelId = String(body.channel_id || '').trim()
  let messageId = String(body.message_id || '').trim()
  const emoji = String(body.emoji || '').trim()
  const roleId = String(body.role_id || '').trim()
  const label = body.label ? String(body.label).trim() : null

  // Accept a pasted message link in any of the id fields as a convenience.
  for (const candidate of [body.message_link, messageId, channelId]) {
    const parsed = parseMessageLink(candidate)
    if (parsed) {
      if (!guildId) guildId = parsed.guildId
      channelId = parsed.channelId
      messageId = parsed.messageId
      break
    }
  }

  if (!guildId || !channelId || !messageId || !emoji || !roleId) {
    return res.status(400).json({ error: 'guild_id, channel_id, message_id, emoji and role_id are required' })
  }

  try {
    const row = await queryOne(
      `INSERT INTO discord_reaction_roles (guild_id, channel_id, message_id, emoji, role_id, label, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, guild_id, channel_id, message_id, emoji, role_id, label, created_at`,
      [guildId, channelId, messageId, emoji, roleId, label, admin.id],
    )
    // Fire-and-forget: ask the bot to react to the message + hydrate its cache.
    discordBot.emit('reactionRoleAdded', {
      id: row.id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      messageId: row.message_id,
      emoji: row.emoji,
      roleId: row.role_id,
    })
    res.json(row)
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A mapping for this emoji on this message already exists' })
    }
    console.error('[discord-reaction-roles] insert failed:', err)
    res.status(500).json({ error: err.message })
  }
})

router.delete('/api/admin/discord/reaction-roles/:id', async (req, res) => {
  const admin = await requirePermission(req, res, 'manage_discord_settings')
  if (!admin) return
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' })

  const row = await queryOne(
    `SELECT id, guild_id, channel_id, message_id, emoji, role_id FROM discord_reaction_roles WHERE id = $1`,
    [id],
  )
  if (!row) return res.status(404).json({ error: 'not found' })

  await execute(`DELETE FROM discord_reaction_roles WHERE id = $1`, [id])
  discordBot.emit('reactionRoleRemoved', {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    emoji: row.emoji,
    roleId: row.role_id,
  })
  res.json({ ok: true })
})

export default router
