import { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } from '../config.js'

let twitchAppToken = null
let twitchAppTokenExpiresAt = 0

export async function getTwitchAppToken() {
  if (twitchAppToken && Date.now() < twitchAppTokenExpiresAt - 60000) return twitchAppToken
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return null
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
    })
    const data = await res.json()
    if (data.access_token) {
      twitchAppToken = data.access_token
      twitchAppTokenExpiresAt = Date.now() + data.expires_in * 1000
      return twitchAppToken
    }
  } catch (e) {
    console.error('Failed to get Twitch app token:', e.message)
  }
  return null
}

export async function fetchTwitchProfileImage(username) {
  const token = await getTwitchAppToken()
  if (!token) return null
  try {
    const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID },
    })
    const data = await res.json()
    return data.data?.[0]?.profile_image_url || null
  } catch { return null }
}
