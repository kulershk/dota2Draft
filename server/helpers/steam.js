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
