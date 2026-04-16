export async function fetchSteamProfile(steamId) {
  let personaName = `Steam_${steamId.slice(-6)}`
  let avatarUrl = ''
  const steamApiKey = process.env.STEAM_API_KEY
  if (steamApiKey) {
    try {
      const profileRes = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${steamApiKey}&steamids=${steamId}`
      )
      const profileData = await profileRes.json()
      const player = profileData?.response?.players?.[0]
      if (player) {
        personaName = player.personaname || personaName
        avatarUrl = player.avatarfull || player.avatarmedium || player.avatar || ''
      }
    } catch (e) {
      console.error('Steam profile fetch error:', e)
    }
  }
  return { personaName, avatarUrl }
}

// Fetch up to 100 profiles in a single API call
export async function fetchSteamProfiles(steamIds) {
  const steamApiKey = process.env.STEAM_API_KEY
  if (!steamApiKey || steamIds.length === 0) return new Map()

  const results = new Map()
  // Steam API allows up to 100 IDs per request
  for (let i = 0; i < steamIds.length; i += 100) {
    const batch = steamIds.slice(i, i + 100)
    try {
      const res = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${steamApiKey}&steamids=${batch.join(',')}`
      )
      const data = await res.json()
      for (const p of (data?.response?.players || [])) {
        results.set(p.steamid, {
          personaName: p.personaname || `Steam_${p.steamid.slice(-6)}`,
          avatarUrl: p.avatarfull || p.avatarmedium || p.avatar || '',
        })
      }
    } catch (e) {
      console.error('Steam bulk profile fetch error:', e)
    }
  }
  return results
}

export async function resolveVanityUrl(vanityName) {
  const steamApiKey = process.env.STEAM_API_KEY
  if (!steamApiKey) return null
  try {
    const res = await fetch(
      `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${steamApiKey}&vanityurl=${encodeURIComponent(vanityName)}`
    )
    const data = await res.json()
    if (data?.response?.success === 1 && data.response.steamid) {
      return data.response.steamid
    }
  } catch (e) {
    console.error('Vanity URL resolve error:', e)
  }
  return null
}

/**
 * Fetch Dota 2 match details from the Steam Web API. Returns null if the
 * match isn't available yet (still being processed by Valve) or if no API
 * key is configured. The shape is normalised to look similar to OpenDota so
 * the caller can mostly treat them the same.
 */
export async function fetchSteamMatchDetails(dotaMatchId) {
  const steamApiKey = process.env.STEAM_API_KEY
  if (!steamApiKey) return null
  const matchId = String(dotaMatchId).replace(/\D/g, '')
  if (!matchId) return null

  try {
    const res = await fetch(
      `https://api.steampowered.com/IDOTA2Match_570/GetMatchDetails/v1/?key=${steamApiKey}&match_id=${matchId}`
    )
    if (!res.ok) return null
    const data = await res.json()
    const r = data?.result
    if (!r || r.error) return null

    return {
      match_id: r.match_id,
      radiant_win: r.radiant_win,
      duration: r.duration || 0,
      start_time: r.start_time || null,
      game_mode: r.game_mode,
      radiant_team_id: r.radiant_team_id || 0,
      dire_team_id: r.dire_team_id || 0,
      players: (r.players || []).map(p => ({
        account_id: p.account_id,
        hero_id: p.hero_id,
        kills: p.kills || 0,
        deaths: p.deaths || 0,
        assists: p.assists || 0,
        last_hits: p.last_hits || 0,
        denies: p.denies || 0,
        gold_per_min: p.gold_per_min || 0,
        xp_per_min: p.xp_per_min || 0,
        hero_damage: p.hero_damage || 0,
        tower_damage: p.tower_damage || 0,
        hero_healing: p.hero_healing || 0,
        net_worth: p.net_worth || 0,
        level: p.level || 0,
        item_0: p.item_0 || 0,
        item_1: p.item_1 || 0,
        item_2: p.item_2 || 0,
        item_3: p.item_3 || 0,
        item_4: p.item_4 || 0,
        item_5: p.item_5 || 0,
        backpack_0: p.backpack_0 || 0,
        backpack_1: p.backpack_1 || 0,
        backpack_2: p.backpack_2 || 0,
        item_neutral: p.item_neutral || 0,
        isRadiant: p.player_slot < 128,
        win: p.player_slot < 128 ? (r.radiant_win ? 1 : 0) : (r.radiant_win ? 0 : 1),
        lane_role: null,
      })),
      _source: 'steam',
    }
  } catch (e) {
    console.error(`[Steam] GetMatchDetails failed for ${matchId}:`, e.message)
    return null
  }
}

export async function parseSteamIds(text) {
  const lines = text.split(/[\n,]+/).map(l => l.trim()).filter(Boolean)
  const steamIds = []
  for (const line of lines) {
    // /profiles/76561198... — numeric Steam ID in URL
    const profileMatch = line.match(/\/profiles\/(\d+)/)
    if (profileMatch) {
      steamIds.push(profileMatch[1])
      continue
    }
    // /id/vanityname — vanity URL
    const vanityMatch = line.match(/\/id\/([^\/\s?#]+)/)
    if (vanityMatch) {
      const resolved = await resolveVanityUrl(vanityMatch[1])
      if (resolved) steamIds.push(resolved)
      continue
    }
    // Raw numeric Steam ID
    if (/^\d{10,}$/.test(line)) {
      steamIds.push(line)
      continue
    }
    // Treat as vanity name if it's a plain string
    if (/^[a-zA-Z0-9_-]+$/.test(line)) {
      const resolved = await resolveVanityUrl(line)
      if (resolved) steamIds.push(resolved)
    }
  }
  return [...new Set(steamIds)]
}
