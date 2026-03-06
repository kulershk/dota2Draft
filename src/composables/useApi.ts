async function request(path: string, options?: RequestInit) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
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
    loginAdmin: (password: string) =>
      request('/api/auth/admin', { method: 'POST', body: JSON.stringify({ password }) }),
    loginCaptain: (name: string, password: string) =>
      request('/api/auth/captain', { method: 'POST', body: JSON.stringify({ name, password }) }),
    loginWithToken: (token: string) =>
      request('/api/auth/token', { method: 'POST', body: JSON.stringify({ token }) }),
    getCaptainLoginToken: (id: number) =>
      request(`/api/captains/${id}/login-token`),

    // Settings
    getSettings: () => request('/api/settings'),
    updateSettings: (data: Record<string, any>) => request('/api/settings', { method: 'PUT', body: JSON.stringify(data) }),

    // Captains
    getCaptains: () => request('/api/captains'),
    createCaptain: (data: { name: string; team: string; budget?: number; password?: string }) =>
      request('/api/captains', { method: 'POST', body: JSON.stringify(data) }),
    updateCaptain: (id: number, data: Record<string, any>) =>
      request(`/api/captains/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteCaptain: (id: number) =>
      request(`/api/captains/${id}`, { method: 'DELETE' }),

    // Players
    getPlayers: () => request('/api/players'),
    createPlayer: (data: { name: string; roles: string[]; mmr?: number; info?: string }) =>
      request('/api/players', { method: 'POST', body: JSON.stringify(data) }),
    updatePlayer: (id: number, data: Record<string, any>) =>
      request(`/api/players/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deletePlayer: (id: number) =>
      request(`/api/players/${id}`, { method: 'DELETE' }),

    // Auction
    getAuction: () => request('/api/auction'),
    getResults: () => request('/api/auction/results'),
  }
}
