import { Router } from 'express'
import { query, queryOne, execute } from '../db.js'
import { getAuthPlayer } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'

export default function createNewsRouter(io) {
  const router = Router()

  router.get('/api/news', async (req, res) => {
    const news = await query(`
      SELECT n.*, COALESCE(p.display_name, p.name) AS created_by_name, p.avatar_url AS created_by_avatar
      FROM news n
      LEFT JOIN players p ON p.id = n.created_by
      ORDER BY n.created_at DESC
    `)
    res.json(news)
  })

  router.post('/api/news', async (req, res) => {
    const admin = await requirePermission(req, res, 'manage_news')
    if (!admin) return
    const { title, content } = req.body
    if (!title || !content) return res.status(400).json({ error: 'Title and content required' })
    const result = await queryOne(
      'INSERT INTO news (title, content, created_by) VALUES ($1, $2, $3) RETURNING id',
      [title, content, admin.id]
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
    const { title, content } = req.body
    await execute(
      'UPDATE news SET title = $1, content = $2 WHERE id = $3',
      [title ?? post.title, content ?? post.content, req.params.id]
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
    const comments = await query(`
      SELECT c.*, COALESCE(p.display_name, p.name) AS player_name, p.avatar_url AS player_avatar
      FROM news_comments c
      JOIN players p ON p.id = c.player_id
      WHERE c.news_id = $1
      ORDER BY c.created_at ASC
    `, [req.params.newsId])
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

  return router
}
