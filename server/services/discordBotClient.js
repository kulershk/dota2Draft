// Thin client for the discord/ bot's internal HTTP server. All calls are
// fire-and-forget from the caller's perspective: failures are logged and
// swallowed so a Discord outage never blocks queue or match flows.

const BASE = process.env.DISCORD_BOT_INTERNAL_URL || 'http://draft-discordbot:3030'
const TOKEN = process.env.INTERNAL_TOKEN || ''

async function post(path, body) {
  if (!TOKEN) return { ok: false, reason: 'INTERNAL_TOKEN not configured' }
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.warn(`[discordBotClient] ${path} ${res.status}:`, data?.error || res.statusText)
      return { ok: false, status: res.status, ...data }
    }
    return data
  } catch (err) {
    console.warn(`[discordBotClient] ${path} unreachable:`, err.message)
    return { ok: false, reason: err.message }
  }
}

export const discordBot = {
  matchStart(payload) {
    return post('/internal/match/start', payload)
  },
  matchEnd(matchId, immediate = false) {
    return post('/internal/match/end', { matchId, immediate })
  },
  tournamentAnnounce(payload) {
    return post('/internal/tournament/announce', payload)
  },
}
