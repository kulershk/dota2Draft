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

    // Competitions
    getCompetitions: () => request('/api/competitions'),
    getCompetition: (id: number) => request(`/api/competitions/${id}`),
    createCompetition: (data: { name: string; description?: string; starts_at?: string; registration_start?: string; registration_end?: string; settings?: Record<string, any> }) =>
      request('/api/competitions', { method: 'POST', body: JSON.stringify(data) }),
    updateCompetition: (id: number, data: Record<string, any>) =>
      request(`/api/competitions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteCompetition: (id: number) =>
      request(`/api/competitions/${id}`, { method: 'DELETE' }),

    // Competition-specific user info
    getCompMe: (compId: number) => request(`/api/competitions/${compId}/me`),

    // Competition Players
    getCompPlayers: (compId: number) => request(`/api/competitions/${compId}/players`),
    registerForComp: (compId: number, data: { roles: string[]; mmr?: number; info?: string }) =>
      request(`/api/competitions/${compId}/players/register`, { method: 'POST', body: JSON.stringify(data) }),
    updateCompPlayer: (compId: number, playerId: number, data: Record<string, any>) =>
      request(`/api/competitions/${compId}/players/${playerId}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteCompPlayer: (compId: number, playerId: number) =>
      request(`/api/competitions/${compId}/players/${playerId}`, { method: 'DELETE' }),

    // Competition Captains
    getCompCaptains: (compId: number) => request(`/api/competitions/${compId}/captains`),
    promoteToCaptain: (compId: number, data: { playerId: number; team: string }) =>
      request(`/api/competitions/${compId}/captains/promote`, { method: 'POST', body: JSON.stringify(data) }),
    updateCaptain: (compId: number, id: number, data: Record<string, any>) =>
      request(`/api/competitions/${compId}/captains/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    demoteCaptain: (compId: number, id: number) =>
      request(`/api/competitions/${compId}/captains/${id}/demote`, { method: 'POST' }),
    uploadCaptainBanner: async (compId: number, captainId: number, file: File) => {
      const form = new FormData()
      form.append('banner', file)
      const token = localStorage.getItem('draft_auth_token')
      const res = await fetch(`/api/competitions/${compId}/captains/${captainId}/banner`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error || 'Upload failed')
      }
      return res.json()
    },
    deleteCaptainBanner: (compId: number, captainId: number) =>
      request(`/api/competitions/${compId}/captains/${captainId}/banner`, { method: 'DELETE' }),

    // Competition Pool (admin)
    addUserToCompPool: (compId: number, userId: number) =>
      request(`/api/competitions/${compId}/users/${userId}/add-to-pool`, { method: 'POST', body: '{}' }),
    removeUserFromCompPool: (compId: number, userId: number) =>
      request(`/api/competitions/${compId}/users/${userId}/remove-from-pool`, { method: 'POST', body: '{}' }),

    // Competition Auction
    getCompAuction: (compId: number) => request(`/api/competitions/${compId}/auction`),
    getCompResults: (compId: number) => request(`/api/competitions/${compId}/auction/results`),

    // User self-update
    updateMe: (data: Record<string, any>) =>
      request('/api/auth/me', { method: 'PUT', body: JSON.stringify(data) }),

    // Twitch OAuth
    getTwitchLinkUrl: () => request('/api/auth/twitch/link'),
    unlinkTwitch: () => request('/api/auth/twitch/unlink', { method: 'POST' }),

    // Streamers (public)
    getStreamers: () => request('/api/streamers'),

    // Users (global)
    getUsers: () => request('/api/users'),
    updatePlayer: (id: number, data: Record<string, any>) =>
      request(`/api/players/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

    // News
    getNews: () => request('/api/news'),
    createNews: (data: { title: string; content: string }) =>
      request('/api/news', { method: 'POST', body: JSON.stringify(data) }),
    updateNews: (id: number, data: { title?: string; content?: string }) =>
      request(`/api/news/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteNews: (id: number) =>
      request(`/api/news/${id}`, { method: 'DELETE' }),

    // News Comments
    getComments: (newsId: number) => request(`/api/news/${newsId}/comments`),
    addComment: (newsId: number, content: string) =>
      request(`/api/news/${newsId}/comments`, { method: 'POST', body: JSON.stringify({ content }) }),
    deleteComment: (newsId: number, commentId: number) =>
      request(`/api/news/${newsId}/comments/${commentId}`, { method: 'DELETE' }),
  }
}
