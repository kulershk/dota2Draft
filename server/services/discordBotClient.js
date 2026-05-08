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
    // Dedicated endpoint — does inline match-voice work AND fans out
    // matchStarted to plugins from inside the handler. Don't replace with
    // emit() (would skip the voice-channel creation).
    return post('/internal/match/start', payload)
  },
  matchEnd(matchId, immediate = false) {
    // Same — dedicated endpoint cleans up voice channels AND fans out.
    return post('/internal/match/end', { matchId, immediate })
  },
  tournamentAnnounce(payload) {
    // Dedicated endpoint that re-emits via client.emit (no inline work).
    // Could equally be `emit('tournamentAnnounce', payload)`; kept as a
    // dedicated route for input validation symmetry with the other two.
    return post('/internal/tournament/announce', payload)
  },
  /**
   * Fire a generic draft event for any plugin to react to. Use this for new
   * server-side actions where the bot doesn't need to do any inline work
   * itself (just plugin fan-out). For events that also need bot-internal
   * side effects (channel creation, etc.), add a dedicated endpoint instead.
   *
   * Plugins consume via @EventHook on a method named on<EventName> with the
   * first character upper-cased — e.g. `emit('captainAdded', payload)` is
   * received by `async onCaptainAdded(payload) { ... }`.
   */
  emit(type, payload) {
    return post('/internal/event', { type, payload })
  },
}
