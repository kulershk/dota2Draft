// Live realtime score poller for queue matches.
//
// Steam exposes IDOTA2MatchStats_570/GetRealtimeStats which returns per-team
// kills, building HP, players, hero IDs, current game time — but only when
// you have the match's `server_steam_id`. The Go bot doesn't surface that
// directly, so we fall back to scraping it from a player's `gameserversteamid`
// via ISteamUser/GetPlayerSummaries.
//
// Once we have a server_steam_id, we poll Steam every POLL_MS while the match
// is live, cache the latest snapshot in memory, and broadcast it over socket
// so the home page + queue match page can show real-time scores.

import { query, queryOne, execute } from '../db.js'

const POLL_MS = 12_000              // every 12s — well under Steam's ~1 req/sec
const MAX_BOOTSTRAP_ATTEMPTS = 30   // give up finding server_steam_id after ~6 min

// queueMatchId -> { intervalId, snapshot, attempts, serverSteamId }
const active = new Map()
let ioRef = null

export function setLivePollerIo(io) { ioRef = io }

export function getLiveSnapshot(queueMatchId) {
  return active.get(queueMatchId)?.snapshot || null
}

export async function startPolling(queueMatchId) {
  if (!process.env.STEAM_API_KEY) {
    console.warn(`[livePoller] STEAM_API_KEY not set — skipping match ${queueMatchId}`)
    return
  }
  if (active.has(queueMatchId)) {
    console.log(`[livePoller] already polling match ${queueMatchId}`)
    return
  }
  const qm = await queryOne(
    'SELECT id, server_steam_id, team1_players, team2_players FROM queue_matches WHERE id = $1',
    [queueMatchId]
  )
  if (!qm) {
    console.warn(`[livePoller] queue match ${queueMatchId} not found`)
    return
  }

  const steamIds = [
    ...((qm.team1_players || []).map(p => p.steamId).filter(Boolean)),
    ...((qm.team2_players || []).map(p => p.steamId).filter(Boolean)),
  ]
  console.log(`[livePoller] starting match ${queueMatchId} — ${steamIds.length} steam ids, server_steam_id=${qm.server_steam_id || 'pending'}`)

  const ctx = {
    queueMatchId,
    serverSteamId: qm.server_steam_id ? String(qm.server_steam_id) : null,
    steamIds,
    snapshot: null,
    attempts: 0,
    intervalId: null,
  }
  active.set(queueMatchId, ctx)

  const tick = async () => {
    try {
      // 1. Bootstrap server_steam_id if missing
      if (!ctx.serverSteamId) {
        ctx.attempts++
        if (ctx.attempts > MAX_BOOTSTRAP_ATTEMPTS) {
          console.warn(`[livePoller] giving up on queue match ${queueMatchId} — no server_steam_id after ${ctx.attempts} attempts`)
          return stopPolling(queueMatchId)
        }
        const result = await deriveServerSteamId(ctx.steamIds)
        if (result.serverSteamId) {
          ctx.serverSteamId = result.serverSteamId
          console.log(`[livePoller] match ${queueMatchId} — captured server_steam_id ${ctx.serverSteamId} from player ${result.fromSteamId}`)
          await execute('UPDATE queue_matches SET server_steam_id = $1 WHERE id = $2', [ctx.serverSteamId, queueMatchId])
        } else {
          console.log(`[livePoller] match ${queueMatchId} attempt ${ctx.attempts}/${MAX_BOOTSTRAP_ATTEMPTS} — no player in-game yet (${result.diagnostic})`)
          return // try again next tick
        }
      }

      // 2. Pull realtime stats
      const stats = await fetchRealtimeStats(ctx.serverSteamId)
      if (!stats) {
        console.log(`[livePoller] match ${queueMatchId} — GetRealtimeStats returned no data`)
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

      // 3. Broadcast to anyone watching (home page + per-match page)
      if (ioRef) {
        const payload = { queueMatchId, ...ctx.snapshot }
        ioRef.emit('home:liveStats', payload)
        ioRef.to(`queue-match:${queueMatchId}`).emit('queue:liveStats', payload)
      }
    } catch (e) {
      // Don't kill the poller on transient API errors — just log.
      console.error(`[livePoller] tick failed for queue match ${queueMatchId}:`, e.message)
    }
  }

  // Kick off immediately, then on interval
  tick()
  ctx.intervalId = setInterval(tick, POLL_MS)
}

export function stopPolling(queueMatchId) {
  const ctx = active.get(queueMatchId)
  if (!ctx) return
  if (ctx.intervalId) clearInterval(ctx.intervalId)
  active.delete(queueMatchId)
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

// On startup, resume polling for any queue match still flagged as live.
export async function resumeActiveMatches() {
  try {
    const live = await query(
      `SELECT id FROM queue_matches WHERE status = 'live' AND created_at > NOW() - INTERVAL '4 hours'`
    )
    for (const row of live) startPolling(row.id)
    if (live.length) console.log(`[livePoller] resumed polling ${live.length} live match(es)`)
  } catch (e) {
    console.error('[livePoller] resume failed:', e.message)
  }
}
