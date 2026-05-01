// Live realtime score poller for in-game matches (queue or tournament).
//
// Steam exposes IDOTA2MatchStats_570/GetRealtimeStats which returns per-team
// kills, building HP, players (hero, KDA, NW, items), current game time —
// but only when you have the match's `server_steam_id`. The Go bot reports
// it on game_started; we fall back to scraping it from a player's
// `gameserversteamid` via ISteamUser/GetPlayerSummaries.
//
// Once we have a server_steam_id, we poll Steam every POLL_MS while the match
// is live, cache the latest snapshot in memory, and broadcast it over socket
// so home page + match room + queue match page can show real-time scores.
//
// Keyed by `matches.id` — works for both queue matches (one per queue_match)
// and tournament matches (one per matches row). The persistence column is
// `match_lobbies.server_steam_id` (latest lobby per match).

import { query, queryOne, execute } from '../db.js'

const POLL_MS = 12_000              // every 12s — well under Steam's ~1 req/sec
// Bootstrap budget: time we keep retrying GetPlayerSummaries when the bot
// didn't report a server_steam_id. Tournament drafts with strategy time can
// run 10–15 min before players actually load onto the match server (and
// before `gameserversteamid` becomes visible in the Steam Web API), so we
// give it 15 min. Each attempt is a cheap profile lookup.
const MAX_BOOTSTRAP_ATTEMPTS = 75   // 75 × 12s = 15 min

// matchId -> { intervalId, snapshot, attempts, serverSteamId, queueMatchId }
const active = new Map()
let ioRef = null

export function setLivePollerIo(io) { ioRef = io }

export function getLiveSnapshot(matchId) {
  return active.get(matchId)?.snapshot || null
}

// Push a freshly-discovered server_steam_id into the running poller context
// so the next tick can call GetRealtimeStats directly instead of staying in
// the bootstrap loop. Called from botPool when _onMatchIdCaptured or
// _onLobbyServerId surface the value AFTER startPolling already kicked off.
// No-op if the matchId isn't currently being polled (use startPolling instead).
export function updateServerSteamId(matchId, serverSteamId) {
  const ctx = active.get(matchId)
  if (!ctx) return false
  const next = String(serverSteamId || '').trim()
  if (!next || next === '0') return false
  if (ctx.serverSteamId === next) return false
  ctx.serverSteamId = next
  // Reset attempts so the bootstrap timeout doesn't carry over.
  ctx.attempts = 0
  console.log(`[livePoller] match ${matchId} — server_steam_id ${next} injected into running poller`)
  return true
}

// Look up the queue_matches.id for back-compat fields in the broadcast payload
// (older clients keyed off queueMatchId). Returns null for tournament matches.
async function findQueueMatchId(matchId) {
  const row = await queryOne('SELECT id FROM queue_matches WHERE match_id = $1', [matchId])
  return row?.id || null
}

// Pull the steam_ids from the most-recent match_lobbies row for this match,
// covers both queue and tournament paths since both write players_expected.
async function fetchSteamIdsForMatch(matchId) {
  const row = await queryOne(
    `SELECT players_expected, server_steam_id
       FROM match_lobbies
      WHERE match_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [matchId]
  )
  const expected = row?.players_expected || []
  const ids = []
  for (const p of expected) {
    const sid = p?.steam_id || p?.steamId
    if (sid) ids.push(String(sid))
  }
  return { steamIds: ids, serverSteamId: row?.server_steam_id ? String(row.server_steam_id) : null }
}

export async function startPolling(matchId) {
  if (!process.env.STEAM_API_KEY) {
    console.warn(`[livePoller] STEAM_API_KEY not set — skipping match ${matchId}`)
    return
  }
  if (active.has(matchId)) {
    console.log(`[livePoller] already polling match ${matchId}`)
    return
  }
  const { steamIds, serverSteamId } = await fetchSteamIdsForMatch(matchId)
  const queueMatchId = await findQueueMatchId(matchId)

  console.log(`[livePoller] starting match ${matchId} — ${steamIds.length} steam ids, server_steam_id=${serverSteamId || 'pending'}, queueMatchId=${queueMatchId || 'none'}`)

  const ctx = {
    matchId,
    queueMatchId,
    serverSteamId,
    steamIds,
    snapshot: null,
    attempts: 0,
    intervalId: null,
  }
  active.set(matchId, ctx)

  const tick = async () => {
    try {
      // 1. Bootstrap server_steam_id if missing
      if (!ctx.serverSteamId) {
        ctx.attempts++
        if (ctx.attempts > MAX_BOOTSTRAP_ATTEMPTS) {
          console.warn(`[livePoller] giving up on match ${matchId} — no server_steam_id after ${ctx.attempts} attempts`)
          return stopPolling(matchId)
        }
        const result = await deriveServerSteamId(ctx.steamIds)
        if (result.serverSteamId) {
          ctx.serverSteamId = result.serverSteamId
          console.log(`[livePoller] match ${matchId} — captured server_steam_id ${ctx.serverSteamId} from player ${result.fromSteamId}`)
          // Persist on the most-recent match_lobbies row so resume can use it.
          try {
            await execute(
              `UPDATE match_lobbies SET server_steam_id = $1
                WHERE id = (SELECT id FROM match_lobbies WHERE match_id = $2 ORDER BY id DESC LIMIT 1)`,
              [ctx.serverSteamId, matchId]
            )
          } catch (e) { console.error('[livePoller] persist server_steam_id failed:', e.message) }
          // Mirror onto queue_matches.server_steam_id when applicable so older
          // queue-match queries that read from there still work.
          if (ctx.queueMatchId) {
            try { await execute('UPDATE queue_matches SET server_steam_id = $1 WHERE id = $2', [ctx.serverSteamId, ctx.queueMatchId]) } catch {}
          }
        } else {
          console.log(`[livePoller] match ${matchId} attempt ${ctx.attempts}/${MAX_BOOTSTRAP_ATTEMPTS} — no player in-game yet (${result.diagnostic})`)
          return // try again next tick
        }
      }

      // 2. Pull realtime stats
      const stats = await fetchRealtimeStats(ctx.serverSteamId)
      if (!stats) {
        console.log(`[livePoller] match ${matchId} — GetRealtimeStats returned no data`)
        return
      }

      // Flatten per-player rows from both teams. team_number 0 = radiant, 1 = dire
      // per the GetRealtimeStats schema. Items array can be missing on early ticks.
      const players = []
      const teams = stats.teams || []
      for (let i = 0; i < teams.length; i++) {
        const team = i === 0 ? 'radiant' : 'dire'
        for (const p of (teams[i].players || [])) {
          players.push({
            account_id:  p.accountid ?? null,
            team,
            hero_id:     p.heroid ?? 0,
            level:       p.level ?? 0,
            kills:       p.kill_count ?? 0,
            deaths:      p.death_count ?? 0,
            assists:     p.assists_count ?? 0,
            last_hits:   p.lh_count ?? 0,
            denies:      p.denies_count ?? 0,
            net_worth:   p.net_worth ?? 0,
            gold:        p.gold ?? 0,
            items:       Array.isArray(p.items) ? p.items.slice(0, 6) : [],
          })
        }
      }

      ctx.snapshot = {
        radiant_score: stats.teams?.[0]?.score ?? null,
        dire_score:    stats.teams?.[1]?.score ?? null,
        game_time:     stats.match?.game_time ?? null,
        game_state:    stats.match?.game_state ?? null,
        players,
        updated_at:    Date.now(),
      }

      // 3. Broadcast to anyone watching. matchId is the new canonical id;
      // queueMatchId is included when applicable for backwards-compat.
      if (ioRef) {
        const payload = {
          matchId,
          queueMatchId: ctx.queueMatchId,
          ...ctx.snapshot,
        }
        ioRef.emit('home:liveStats', payload)
        // Per-room broadcasts: tournament rooms hang off comp:${compId} but
        // are too broad for live-stats; instead use a match-scoped room and
        // a queue-match room for the existing queue page.
        ioRef.to(`match:${matchId}`).emit('match:liveStats', payload)
        if (ctx.queueMatchId) {
          ioRef.to(`queue-match:${ctx.queueMatchId}`).emit('queue:liveStats', payload)
        }
      }
    } catch (e) {
      // Don't kill the poller on transient API errors — just log.
      console.error(`[livePoller] tick failed for match ${matchId}:`, e.message)
    }
  }

  // Kick off immediately, then on interval
  tick()
  ctx.intervalId = setInterval(tick, POLL_MS)
}

export function stopPolling(matchId) {
  const ctx = active.get(matchId)
  if (!ctx) return
  if (ctx.intervalId) clearInterval(ctx.intervalId)
  active.delete(matchId)
  // Notify clients so the LIVE banner clears immediately instead of waiting
  // 30s to fade to "Stale". Same routing fields as the broadcast payloads.
  if (ioRef) {
    const payload = { matchId, queueMatchId: ctx.queueMatchId }
    ioRef.emit('home:liveStatsEnd', payload)
    ioRef.to(`match:${matchId}`).emit('match:liveStatsEnd', payload)
    if (ctx.queueMatchId) ioRef.to(`queue-match:${ctx.queueMatchId}`).emit('queue:liveStatsEnd', payload)
  }
}

// Derive server_steam_id by polling Steam Web API for the first player
// who's currently in a game. Returns { serverSteamId, fromSteamId, diagnostic }.
async function deriveServerSteamId(steamIds) {
  if (!steamIds.length) return { serverSteamId: null, fromSteamId: null, diagnostic: 'no steamIds' }
  const key = process.env.STEAM_API_KEY
  if (!key) return { serverSteamId: null, fromSteamId: null, diagnostic: 'no STEAM_API_KEY' }
  // Steam allows up to 100 IDs per call
  const ids = steamIds.slice(0, 100).join(',')
  try {
    const res = await fetch(
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${key}&steamids=${ids}`
    )
    if (!res.ok) return { serverSteamId: null, fromSteamId: null, diagnostic: `Steam API HTTP ${res.status}` }
    const json = await res.json()
    const players = json?.response?.players || []
    if (!players.length) return { serverSteamId: null, fromSteamId: null, diagnostic: 'Steam API returned 0 players (visibility?)' }
    // gameserversteamid only present when the user is in a game session
    const inGame = players.find(p => p.gameserversteamid)
    if (inGame) return { serverSteamId: inGame.gameserversteamid, fromSteamId: inGame.steamid, diagnostic: 'ok' }
    // Diagnostic: how many were visible / in any game (gameid 570 = Dota 2)
    const visible = players.length
    const inDota = players.filter(p => p.gameid === '570').length
    return { serverSteamId: null, fromSteamId: null, diagnostic: `${visible} visible, ${inDota} in Dota 2 but no gameserversteamid yet` }
  } catch (e) {
    return { serverSteamId: null, fromSteamId: null, diagnostic: `fetch failed: ${e.message}` }
  }
}

async function fetchRealtimeStats(serverSteamId) {
  const key = process.env.STEAM_API_KEY
  if (!key) return null
  try {
    const res = await fetch(
      `https://api.steampowered.com/IDOTA2MatchStats_570/GetRealtimeStats/v1/?key=${key}&server_steam_id=${serverSteamId}`
    )
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// On startup, resume polling for any match whose latest lobby launched the
// game (status='completed' + dota_match_id set) within the last 4 hours and
// whose match_games row hasn't been resolved yet (no winner).
export async function resumeActiveMatches() {
  try {
    const live = await query(`
      SELECT DISTINCT ml.match_id
        FROM match_lobbies ml
        LEFT JOIN match_games mg
          ON mg.match_id = ml.match_id AND mg.game_number = ml.game_number
       WHERE ml.status = 'completed'
         AND ml.dota_match_id IS NOT NULL
         AND ml.created_at > NOW() - INTERVAL '4 hours'
         AND (mg.winner_captain_id IS NULL)
    `)
    for (const row of live) startPolling(row.match_id)
    if (live.length) console.log(`[livePoller] resumed polling ${live.length} live match(es)`)
  } catch (e) {
    console.error('[livePoller] resume failed:', e.message)
  }
}
