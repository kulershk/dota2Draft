import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { upload } from '../middleware/upload.js'

export default function createNewsRouter(io) {
  const router = Router()

  // Upload news image
  router.post('/api/news/upload-image', upload.single('image'), async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_news')
    if (!admin) return
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    res.json({ url: `/uploads/${req.file.filename}` })
  })

  router.get('/api/news', async (req, res) => {
    const rawLimit = parseInt(req.query.limit, 10)
    const rawOffset = parseInt(req.query.offset, 10)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : null
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0

    const params = []
    let limitClause = ''
    if (limit !== null) {
      params.push(limit)
      limitClause += ` LIMIT $${params.length}`
      params.push(offset)
      limitClause += ` OFFSET $${params.length}`
    }

    const news = await query(`
      SELECT n.*, COALESCE(p.display_name, p.name) AS created_by_name, p.avatar_url AS created_by_avatar
      FROM news n
      LEFT JOIN players p ON p.id = n.created_by
      ORDER BY n.created_at DESC${limitClause}
    `, params)
    res.json(news)
  })

  router.get('/api/news/:id', async (req, res) => {
    const post = await queryOne(`
      SELECT n.*, COALESCE(p.display_name, p.name) AS created_by_name, p.avatar_url AS created_by_avatar
      FROM news n LEFT JOIN players p ON p.id = n.created_by WHERE n.id = $1
    `, [req.params.id])
    if (!post) return res.status(404).json({ error: 'Not found' })
    res.json(post)
  })

  router.post('/api/news', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_news')
    if (!admin) return
    const { title, content, image_url } = req.body
    if (!title || !content) return res.status(400).json({ error: 'Title and content required' })
    const result = await queryOne(
      'INSERT INTO news (title, content, created_by, image_url) VALUES ($1, $2, $3, $4) RETURNING id',
      [title, content, admin.id, image_url || null]
    )
    const post = await queryOne(`
      SELECT n.*, COALESCE(p.display_name, p.name) AS created_by_name, p.avatar_url AS created_by_avatar
      FROM news n LEFT JOIN players p ON p.id = n.created_by WHERE n.id = $1
    `, [result.id])
    io.emit('news:updated')
    res.status(201).json(post)
  })

  router.put('/api/news/:id', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_news')
    if (!admin) return
    const post = await queryOne('SELECT * FROM news WHERE id = $1', [req.params.id])
    if (!post) return res.status(404).json({ error: 'Post not found' })
    const { title, content, image_url } = req.body
    await execute(
      'UPDATE news SET title = $1, content = $2, image_url = $3 WHERE id = $4',
      [title ?? post.title, content ?? post.content, image_url !== undefined ? (image_url || null) : post.image_url, req.params.id]
    )
    io.emit('news:updated')
    const updated = await queryOne(`
      SELECT n.*, COALESCE(p.display_name, p.name) AS created_by_name, p.avatar_url AS created_by_avatar
      FROM news n LEFT JOIN players p ON p.id = n.created_by WHERE n.id = $1
    `, [req.params.id])
    res.json(updated)
  })

  router.delete('/api/news/:id', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_news')
    if (!admin) return
    await execute('DELETE FROM news WHERE id = $1', [req.params.id])
    io.emit('news:updated')
    res.json({ ok: true })
  })

  // Comments
  router.get('/api/news/:newsId/comments', async (req, res) => {
    const player = await getAuthPlayer(req)
    const comments = await query(`
      SELECT c.*, COALESCE(p.display_name, p.name) AS player_name, p.avatar_url AS player_avatar,
        COALESCE(SUM(v.vote) FILTER (WHERE v.vote = 1), 0)::int AS likes,
        COALESCE(SUM(-v.vote) FILTER (WHERE v.vote = -1), 0)::int AS dislikes
      FROM news_comments c
      JOIN players p ON p.id = c.player_id
      LEFT JOIN news_comment_votes v ON v.comment_id = c.id
      WHERE c.news_id = $1
      GROUP BY c.id, p.display_name, p.name, p.avatar_url
      ORDER BY c.created_at ASC
    `, [req.params.newsId])

    // Attach current user's vote if logged in
    if (player) {
      const votes = await query(
        'SELECT comment_id, vote FROM news_comment_votes WHERE player_id = $1 AND comment_id = ANY($2::int[])',
        [player.id, comments.map(c => c.id)]
      )
      const voteMap = Object.fromEntries(votes.map(v => [v.comment_id, v.vote]))
      for (const c of comments) {
        c.my_vote = voteMap[c.id] || 0
      }
    }

    res.json(comments)
  })

  router.post('/api/news/:newsId/comments', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Login required' })
    if (player.is_banned) return res.status(403).json({ error: 'Your account has been banned' })
    const { content } = req.body
    if (!content || !content.trim()) return res.status(400).json({ error: 'Comment cannot be empty' })
    const newsPost = await queryOne('SELECT id FROM news WHERE id = $1', [req.params.newsId])
    if (!newsPost) return res.status(404).json({ error: 'News post not found' })
    const result = await queryOne(
      'INSERT INTO news_comments (news_id, player_id, content) VALUES ($1, $2, $3) RETURNING id',
      [req.params.newsId, player.id, content.trim()]
    )
    const comment = await queryOne(`
      SELECT c.*, COALESCE(p.display_name, p.name) AS player_name, p.avatar_url AS player_avatar
      FROM news_comments c JOIN players p ON p.id = c.player_id WHERE c.id = $1
    `, [result.id])
    io.emit('news:commented', { newsId: Number(req.params.newsId) })
    res.status(201).json(comment)
  })

  router.delete('/api/news/:newsId/comments/:commentId', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Login required' })
    const comment = await queryOne('SELECT * FROM news_comments WHERE id = $1 AND news_id = $2', [req.params.commentId, req.params.newsId])
    if (!comment) return res.status(404).json({ error: 'Comment not found' })
    if (comment.player_id !== player.id && !player.is_admin) {
      return res.status(403).json({ error: 'Not authorized' })
    }
    await execute('DELETE FROM news_comments WHERE id = $1', [req.params.commentId])
    io.emit('news:commented', { newsId: Number(req.params.newsId) })
    res.json({ ok: true })
  })

  // Vote on comment (like/dislike)
  router.post('/api/news/:newsId/comments/:commentId/vote', async (req, res) => {
    const player = await getAuthPlayer(req)
    if (!player) return res.status(401).json({ error: 'Login required' })
    const { vote } = req.body
    if (vote !== 1 && vote !== -1 && vote !== 0) return res.status(400).json({ error: 'Vote must be 1, -1, or 0' })

    const comment = await queryOne('SELECT id FROM news_comments WHERE id = $1 AND news_id = $2', [req.params.commentId, req.params.newsId])
    if (!comment) return res.status(404).json({ error: 'Comment not found' })

    if (vote === 0) {
      // Remove vote
      await execute('DELETE FROM news_comment_votes WHERE comment_id = $1 AND player_id = $2', [req.params.commentId, player.id])
    } else {
      // Upsert vote
      await execute(`
        INSERT INTO news_comment_votes (comment_id, player_id, vote) VALUES ($1, $2, $3)
        ON CONFLICT (comment_id, player_id) DO UPDATE SET vote = $3
      `, [req.params.commentId, player.id, vote])
    }

    // Return updated counts
    const counts = await queryOne(`
      SELECT
        COALESCE(SUM(vote) FILTER (WHERE vote = 1), 0)::int AS likes,
        COALESCE(SUM(-vote) FILTER (WHERE vote = -1), 0)::int AS dislikes
      FROM news_comment_votes WHERE comment_id = $1
    `, [req.params.commentId])

    res.json({ ok: true, likes: counts.likes, dislikes: counts.dislikes, my_vote: vote })
  })

  return router
}
