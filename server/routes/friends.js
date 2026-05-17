import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { getOnlinePlayerIds } from '../socket/state.js'

export default function createFriendsRouter(io) {
  const router = Router()

  function publicPlayer(p) {
    return {
      id: p.id,
      name: p.display_name || p.name,
      display_name: p.display_name || null,
      steam_name: p.name,
      avatar_url: p.avatar_url || null,
      mmr: p.mmr || 0,
    }
  }

  router.get('/api/friends', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const rows = await query(
      `SELECT f.id, f.created_at, f.responded_at,
              p.id AS p_id, p.name AS p_name, p.display_name AS p_display, p.avatar_url AS p_avatar, p.mmr AS p_mmr
         FROM friendships f
         JOIN players p ON p.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
        WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND f.status = 'accepted'
        ORDER BY COALESCE(f.responded_at, f.created_at) DESC`,
      [me.id],
    )
    const online = new Set(getOnlinePlayerIds())
    res.json(rows.map(r => ({
      id: r.id,
      created_at: r.created_at,
      responded_at: r.responded_at,
      player: publicPlayer({ id: r.p_id, name: r.p_name, display_name: r.p_display, avatar_url: r.p_avatar, mmr: r.p_mmr }),
      online: online.has(r.p_id),
    })))
  })

  router.get('/api/friends/requests', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const incoming = await query(
      `SELECT f.id, f.created_at,
              p.id AS p_id, p.name AS p_name, p.display_name AS p_display, p.avatar_url AS p_avatar, p.mmr AS p_mmr
         FROM friendships f
         JOIN players p ON p.id = f.requester_id
        WHERE f.addressee_id = $1 AND f.status = 'pending'
        ORDER BY f.created_at DESC`,
      [me.id],
    )
    const outgoing = await query(
      `SELECT f.id, f.created_at,
              p.id AS p_id, p.name AS p_name, p.display_name AS p_display, p.avatar_url AS p_avatar, p.mmr AS p_mmr
         FROM friendships f
         JOIN players p ON p.id = f.addressee_id
        WHERE f.requester_id = $1 AND f.status = 'pending'
        ORDER BY f.created_at DESC`,
      [me.id],
    )
    const shape = r => ({
      id: r.id,
      created_at: r.created_at,
      player: publicPlayer({ id: r.p_id, name: r.p_name, display_name: r.p_display, avatar_url: r.p_avatar, mmr: r.p_mmr }),
    })
    res.json({ incoming: incoming.map(shape), outgoing: outgoing.map(shape) })
  })

  router.get('/api/friends/blocks', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const rows = await query(
      `SELECT f.id, f.created_at,
              p.id AS p_id, p.name AS p_name, p.display_name AS p_display, p.avatar_url AS p_avatar, p.mmr AS p_mmr
         FROM friendships f
         JOIN players p ON p.id = f.addressee_id
        WHERE f.requester_id = $1 AND f.status = 'blocked'
        ORDER BY f.created_at DESC`,
      [me.id],
    )
    res.json(rows.map(r => ({
      id: r.id,
      created_at: r.created_at,
      player: publicPlayer({ id: r.p_id, name: r.p_name, display_name: r.p_display, avatar_url: r.p_avatar, mmr: r.p_mmr }),
    })))
  })

  router.post('/api/friends/requests', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const addresseeId = Number(req.body?.addressee_id)
    if (!Number.isFinite(addresseeId) || addresseeId === me.id) return res.status(400).json({ error: 'Invalid addressee' })
    const addressee = await queryOne('SELECT id, name, display_name, avatar_url, mmr FROM players WHERE id = $1', [addresseeId])
    if (!addressee) return res.status(404).json({ error: 'Player not found' })

    // Reject if either side has blocked the other.
    const blocked = await queryOne(
      `SELECT 1 FROM friendships
        WHERE status = 'blocked'
          AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
        LIMIT 1`,
      [me.id, addresseeId],
    )
    if (blocked) return res.status(403).json({ error: 'Unavailable' })

    // If a row already exists between this directional pair, reject as duplicate.
    const existing = await queryOne(
      'SELECT id, status FROM friendships WHERE requester_id = $1 AND addressee_id = $2',
      [me.id, addresseeId],
    )
    if (existing && (existing.status === 'pending' || existing.status === 'accepted')) {
      return res.status(409).json({ error: 'Already exists' })
    }

    // If the reverse direction is pending (they asked me first), auto-accept it
    // instead of creating a new row.
    const reverse = await queryOne(
      "SELECT id FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'",
      [addresseeId, me.id],
    )
    if (reverse) {
      await execute(
        "UPDATE friendships SET status = 'accepted', responded_at = NOW() WHERE id = $1",
        [reverse.id],
      )
      io?.to(`user:${addresseeId}`).emit('friend:accepted', { id: reverse.id })
      io?.to(`user:${me.id}`).emit('friend:accepted', { id: reverse.id })
      return res.json({ id: reverse.id, status: 'accepted' })
    }

    // If there is already an accepted row in the reverse direction (shouldn't
    // happen given the symmetry rule, but be defensive), do nothing.
    const acceptedReverse = await queryOne(
      "SELECT id FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = 'accepted'",
      [addresseeId, me.id],
    )
    if (acceptedReverse) return res.status(409).json({ error: 'Already friends' })

    const row = await queryOne(
      `INSERT INTO friendships (requester_id, addressee_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING id, created_at`,
      [me.id, addresseeId],
    )
    io?.to(`user:${addresseeId}`).emit('friend:request', {
      id: row.id,
      from: publicPlayer(me),
    })
    res.json({ id: row.id, status: 'pending' })
  })

  router.post('/api/friends/:id/accept', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const id = Number(req.params.id)
    const row = await queryOne('SELECT * FROM friendships WHERE id = $1', [id])
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (row.addressee_id !== me.id) return res.status(403).json({ error: 'Only the addressee can accept' })
    if (row.status !== 'pending') return res.status(409).json({ error: 'Not pending' })
    await execute(
      "UPDATE friendships SET status = 'accepted', responded_at = NOW() WHERE id = $1",
      [id],
    )
    io?.to(`user:${row.requester_id}`).emit('friend:accepted', { id })
    io?.to(`user:${row.addressee_id}`).emit('friend:accepted', { id })
    res.json({ id, status: 'accepted' })
  })

  router.delete('/api/friends/:id', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const id = Number(req.params.id)
    const row = await queryOne('SELECT * FROM friendships WHERE id = $1', [id])
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (row.status === 'blocked') return res.status(403).json({ error: 'Use unblock endpoint' })
    if (row.requester_id !== me.id && row.addressee_id !== me.id) {
      return res.status(403).json({ error: 'Not your friendship' })
    }
    await execute('DELETE FROM friendships WHERE id = $1', [id])
    const otherId = row.requester_id === me.id ? row.addressee_id : row.requester_id
    io?.to(`user:${otherId}`).emit('friend:removed', { id })
    res.json({ ok: true })
  })

  router.post('/api/friends/blocks', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const targetId = Number(req.body?.addressee_id)
    if (!Number.isFinite(targetId) || targetId === me.id) return res.status(400).json({ error: 'Invalid target' })
    const target = await queryOne('SELECT id FROM players WHERE id = $1', [targetId])
    if (!target) return res.status(404).json({ error: 'Player not found' })

    await execute('BEGIN')
    try {
      // Drop any existing non-blocked relationship rows between the pair so the
      // target doesn't show up as a friend or pending request for me anymore.
      await execute(
        `DELETE FROM friendships
          WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
            AND status IN ('pending','accepted')`,
        [me.id, targetId],
      )
      const existingBlock = await queryOne(
        "SELECT id FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = 'blocked'",
        [me.id, targetId],
      )
      let row = existingBlock
      if (!existingBlock) {
        row = await queryOne(
          `INSERT INTO friendships (requester_id, addressee_id, status)
           VALUES ($1, $2, 'blocked')
           RETURNING id`,
          [me.id, targetId],
        )
      }
      await execute('COMMIT')
      io?.to(`user:${targetId}`).emit('friend:removed', { id: row.id })
      res.json({ id: row.id, status: 'blocked' })
    } catch (e) {
      await execute('ROLLBACK')
      throw e
    }
  })

  router.delete('/api/friends/blocks/:id', async (req, res) => {
    const me = await getAuthPlayer(req)
    if (!me) return res.status(401).json({ error: 'Not authenticated' })
    const id = Number(req.params.id)
    const row = await queryOne('SELECT * FROM friendships WHERE id = $1', [id])
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (row.requester_id !== me.id || row.status !== 'blocked') {
      return res.status(403).json({ error: 'Not your block' })
    }
    await execute('DELETE FROM friendships WHERE id = $1', [id])
    res.json({ ok: true })
  })

  return router
}
