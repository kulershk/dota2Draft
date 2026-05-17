import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'

const MAX_BODY = 200

export default function createMessagesRouter(io) {
  const router = Router()

  // List my conversations — latest message per peer + unread count from that
  // peer. The peer object includes display_name/avatar so the panel can
  // render without a second roundtrip.
  router.get('/api/messages/threads', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const rows = await query(
      `WITH peers AS (
         SELECT
           CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS peer_id,
           id, body, created_at, read_at, sender_id, recipient_id
           FROM direct_messages
          WHERE sender_id = $1 OR recipient_id = $1
       ),
       latest AS (
         SELECT DISTINCT ON (peer_id)
           peer_id, id, body, created_at, read_at, sender_id, recipient_id
           FROM peers
          ORDER BY peer_id, created_at DESC
       ),
       unread AS (
         SELECT sender_id AS peer_id, COUNT(*)::int AS c
           FROM direct_messages
          WHERE recipient_id = $1 AND read_at IS NULL
          GROUP BY sender_id
       )
       SELECT
         latest.peer_id,
         latest.id        AS last_id,
         latest.body      AS last_body,
         latest.created_at AS last_created_at,
         latest.sender_id  AS last_sender_id,
         latest.recipient_id AS last_recipient_id,
         latest.read_at    AS last_read_at,
         COALESCE(unread.c, 0) AS unread,
         p.id AS p_id,
         p.name AS p_name,
         p.display_name AS p_display,
         p.avatar_url AS p_avatar,
         p.mmr AS p_mmr
         FROM latest
         JOIN players p ON p.id = latest.peer_id
         LEFT JOIN unread ON unread.peer_id = latest.peer_id
        ORDER BY latest.created_at DESC`,
      [me.id],
    )
    res.json(rows.map(r => ({
      peer: {
        id: r.p_id,
        name: r.p_display || r.p_name,
        display_name: r.p_display,
        steam_name: r.p_name,
        avatar_url: r.p_avatar,
        mmr: r.p_mmr,
      },
      last_message: {
        id: r.last_id,
        body: r.last_body,
        created_at: r.last_created_at,
        sender_id: r.last_sender_id,
        recipient_id: r.last_recipient_id,
        read_at: r.last_read_at,
      },
      unread: r.unread,
    })))
  })

  // Fetch a single conversation between me and friendId, most-recent-first.
  // `before` is an optional message id for cursor pagination (we return msgs
  // older than that id).
  router.get('/api/messages/:friendId', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const friendId = Number(req.params.friendId)
    if (!Number.isFinite(friendId) || friendId === me.id) return res.status(400).json({ error: 'Invalid id' })
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
    const before = req.query.before ? Number(req.query.before) : null

    const params = [me.id, friendId]
    let where = `(sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)`
    if (before) {
      params.push(before)
      where = `(${where}) AND id < $${params.length}`
    }
    params.push(limit)
    const rows = await query(
      `SELECT id, sender_id, recipient_id, body, created_at, read_at
         FROM direct_messages
        WHERE ${where}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      params,
    )
    res.json(rows.reverse())
  })

  router.post('/api/messages', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const recipientId = Number(req.body?.recipient_id)
    const bodyRaw = typeof req.body?.body === 'string' ? req.body.body : ''
    const body = bodyRaw.trim()
    if (!Number.isFinite(recipientId) || recipientId === me.id) return res.status(400).json({ error: 'Invalid recipient' })
    if (body.length === 0) return res.status(400).json({ error: 'Empty message' })
    if (body.length > MAX_BODY) return res.status(400).json({ error: `Message exceeds ${MAX_BODY} characters` })

    const recipient = await queryOne('SELECT id FROM players WHERE id = $1', [recipientId])
    if (!recipient) return res.status(404).json({ error: 'Recipient not found' })

    // Hard block check — either direction. We deliberately return a generic
    // 403 so the blocked party can't infer who blocked them.
    const blocked = await queryOne(
      `SELECT 1 FROM friendships
        WHERE status = 'blocked'
          AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
        LIMIT 1`,
      [me.id, recipientId],
    )
    if (blocked) return res.status(403).json({ error: 'Unavailable' })

    const row = await queryOne(
      `INSERT INTO direct_messages (sender_id, recipient_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, sender_id, recipient_id, body, created_at, read_at`,
      [me.id, recipientId, body],
    )
    // Emit to both sides so each socket can append the row without refetching.
    io?.to(`user:${recipientId}`).emit('message:new', row)
    io?.to(`user:${me.id}`).emit('message:new', row)
    res.json(row)
  })

  // Mark every unread message FROM friendId TO me as read. Returns the count
  // that flipped. Emits message:read to the sender so their UI can render
  // receipts.
  router.post('/api/messages/:friendId/read', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const friendId = Number(req.params.friendId)
    if (!Number.isFinite(friendId) || friendId === me.id) return res.status(400).json({ error: 'Invalid id' })
    const result = await query(
      `UPDATE direct_messages
          SET read_at = NOW()
        WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL
        RETURNING id`,
      [me.id, friendId],
    )
    if (result.length > 0) {
      io?.to(`user:${friendId}`).emit('message:read', {
        reader_id: me.id,
        message_ids: result.map(r => r.id),
      })
    }
    res.json({ ok: true, marked: result.length })
  })

  return router
}
