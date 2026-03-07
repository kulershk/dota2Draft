function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = localStorage.getItem('draft_auth_token')
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

async function request(path: string, options?: RequestInit) {
  const res = await fetch(path, {
    headers: getAuthHeaders(),
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || 'Request failed')
  }
  return res.json()
}

export function useApi() {
  return {
    // Auth
    getMe: () => request('/api/auth/me'),
    claimAdmin: (password: string) =>
      request('/api/auth/claim-admin', { method: 'POST', body: JSON.stringify({ password }) }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),

    // Player pool self-registration
    registerPlayer: (data: { roles: string[]; mmr?: number; info?: string }) =>
      request('/api/players/register', { method: 'POST', body: JSON.stringify(data) }),

    // Users (all Steam accounts - admin)
    getUsers: () => request('/api/users'),
    addUserToPool: (id: number) =>
      request(`/api/users/${id}/add-to-pool`, { method: 'POST', body: '{}' }),
    removeUserFromPool: (id: number) =>
      request(`/api/users/${id}/remove-from-pool`, { method: 'POST', body: '{}' }),

    // Settings
    getSettings: () => request('/api/settings'),
    updateSettings: (data: Record<string, any>) => request('/api/settings', { method: 'PUT', body: JSON.stringify(data) }),

    // Captains
    getCaptains: () => request('/api/captains'),
    promoteToCaptain: (data: { playerId: number; team: string }) =>
      request('/api/captains/promote', { method: 'POST', body: JSON.stringify(data) }),
    updateCaptain: (id: number, data: Record<string, any>) =>
      request(`/api/captains/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    demoteCaptain: (id: number) =>
      request(`/api/captains/${id}/demote`, { method: 'POST' }),

    // Players
    getPlayers: () => request('/api/players'),
    updatePlayer: (id: number, data: Record<string, any>) =>
      request(`/api/players/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deletePlayer: (id: number) =>
      request(`/api/players/${id}`, { method: 'DELETE' }),

    // Auction
    getAuction: () => request('/api/auction'),
    getResults: () => request('/api/auction/results'),

    // News
    getNews: () => request('/api/news'),
    createNews: (data: { title: string; content: string }) =>
      request('/api/news', { method: 'POST', body: JSON.stringify(data) }),
    updateNews: (id: number, data: { title?: string; content?: string }) =>
      request(`/api/news/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteNews: (id: number) =>
      request(`/api/news/${id}`, { method: 'DELETE' }),
  }
}
