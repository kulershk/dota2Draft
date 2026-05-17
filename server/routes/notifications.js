import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'

export default function createNotificationsRouter(io) {
  const router = Router()

  // List notifications visible to me (broadcasts + anything targeted at me)
  // with read state. Limit to the 100 most recent to keep payloads bounded.
  router.get('/api/notifications', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const rows = await query(
      `SELECT n.id, n.type, n.title, n.body, n.link, n.recipient_id, n.created_at,
              r.read_at
         FROM notifications n
         LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.player_id = $1
        WHERE n.recipient_id IS NULL OR n.recipient_id = $1
        ORDER BY n.created_at DESC
        LIMIT 100`,
      [me.id],
    )
    const unread = rows.filter(r => !r.read_at).length
    res.json({ rows, unread })
  })

  router.post('/api/notifications/:id/read', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const id = Number(req.params.id)
    const n = await queryOne(
      'SELECT id, recipient_id FROM notifications WHERE id = $1',
      [id],
    )
    if (!n) return res.status(404).json({ error: 'Not found' })
    if (n.recipient_id !== null && n.recipient_id !== me.id) {
      return res.status(403).json({ error: 'Not yours' })
    }
    await execute(
      `INSERT INTO notification_reads (notification_id, player_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id, me.id],
    )
    res.json({ ok: true })
  })

  router.post('/api/notifications/read-all', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    await execute(
      `INSERT INTO notification_reads (notification_id, player_id)
         SELECT n.id, $1
           FROM notifications n
           LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.player_id = $1
          WHERE (n.recipient_id IS NULL OR n.recipient_id = $1)
            AND r.notification_id IS NULL
       ON CONFLICT DO NOTHING`,
      [me.id],
    )
    res.json({ ok: true })
  })

  // Admin: create a broadcast announcement. We allow either the dedicated
  // `manage_notifications` perm OR plain admin so projects without that perm
  // configured still work out of the box.
  router.post('/api/admin/notifications', async (req, res) => {
    const admin = await getAuthPlayer(req)
    if (!admin) return res.status(401).json({ error: 'Not authenticated' })
    if (!admin.is_admin) {
      const granted = await requirePermission(req, res, 'manage_notifications')
      if (!granted) return
    }
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
    if (!title) return res.status(400).json({ error: 'title is required' })
    const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 4000) || null : null
    const link = typeof req.body?.link === 'string' ? req.body.link.trim().slice(0, 500) || null : null
    const row = await queryOne(
      `INSERT INTO notifications (recipient_id, type, title, body, link, created_by)
       VALUES (NULL, 'announcement', $1, $2, $3, $4)
       RETURNING id, type, title, body, link, recipient_id, created_at`,
      [title, body, link, admin.id],
    )
    io?.emit('notification:new', { id: row.id })
    res.json(row)
  })

  router.delete('/api/admin/notifications/:id', async (req, res) => {
    const admin = await getAuthPlayer(req)
    if (!admin) return res.status(401).json({ error: 'Not authenticated' })
    if (!admin.is_admin) {
      const granted = await requirePermission(req, res, 'manage_notifications')
      if (!granted) return
    }
    const id = Number(req.params.id)
    await execute('DELETE FROM notifications WHERE id = $1', [id])
    io?.emit('notification:removed', { id })
    res.json({ ok: true })
  })

  // Admin: list all broadcast announcements (with sender display name).
  router.get('/api/admin/notifications', async (req, res) => {
    const admin = await getAuthPlayer(req)
    if (!admin) return res.status(401).json({ error: 'Not authenticated' })
    if (!admin.is_admin) {
      const granted = await requirePermission(req, res, 'manage_notifications')
      if (!granted) return
    }
    const rows = await query(
      `SELECT n.id, n.type, n.title, n.body, n.link, n.created_at,
              p.id AS sender_id, p.name AS sender_name, p.display_name AS sender_display
         FROM notifications n
         LEFT JOIN players p ON p.id = n.created_by
        WHERE n.recipient_id IS NULL
        ORDER BY n.created_at DESC
        LIMIT 200`,
    )
    res.json(rows.map(r => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      created_at: r.created_at,
      sender: r.sender_id ? { id: r.sender_id, name: r.sender_display || r.sender_name } : null,
    })))
  })

  return router
}
