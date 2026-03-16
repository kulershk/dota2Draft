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
    toggleCompPublic: (id: number, isPublic: boolean) =>
      request(`/api/competitions/${id}`, { method: 'PUT', body: JSON.stringify({ is_public: isPublic }) }),
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
    importSteamParticipant: (compId: number, steamId: string) =>
      request(`/api/competitions/${compId}/import-steam-participants`, { method: 'POST', body: JSON.stringify({ steamId }) }),

    // Competition Auction
    getCompAuction: (compId: number) => request(`/api/competitions/${compId}/auction`),
    getCompResults: (compId: number) => request(`/api/competitions/${compId}/auction/results`),

    // Tournament
    getTournament: (compId: number) => request(`/api/competitions/${compId}/tournament`),
    addTournamentStage: (compId: number, data: { name: string; format: string; groups?: any[]; bestOf?: number; seeds?: number[] }) =>
      request(`/api/competitions/${compId}/tournament/stages`, { method: 'POST', body: JSON.stringify(data) }),
    updateTournamentStage: (compId: number, stageId: number, data: { name?: string; status?: string }) =>
      request(`/api/competitions/${compId}/tournament/stages/${stageId}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteTournamentStage: (compId: number, stageId: number) =>
      request(`/api/competitions/${compId}/tournament/stages/${stageId}`, { method: 'DELETE' }),
    updateMatchScore: (compId: number, matchId: number, data: { score1?: number; score2?: number; status?: string; games?: any[] }) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/score`, { method: 'PUT', body: JSON.stringify(data) }),
    resetTournament: (compId: number) =>
      request(`/api/competitions/${compId}/tournament`, { method: 'DELETE' }),
    getMatchGameStats: (compId: number, matchId: number, gameNumber: number) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/games/${gameNumber}/stats`),
    refetchMatchGameStats: (compId: number, matchId: number, gameNumber: number) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/games/${gameNumber}/refetch`, { method: 'POST' }),

    // Fantasy
    getFantasy: (compId: number) => request(`/api/competitions/${compId}/fantasy`),
    getFantasyLeaderboard: (compId: number) => request(`/api/competitions/${compId}/fantasy/leaderboard`),
    createFantasyStage: (compId: number, data: { name: string; matchIds: number[] }) =>
      request(`/api/competitions/${compId}/fantasy/stages`, { method: 'POST', body: JSON.stringify(data) }),
    updateFantasyStage: (compId: number, stageId: number, data: Record<string, any>) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteFantasyStage: (compId: number, stageId: number) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}`, { method: 'DELETE' }),
    saveFantasyPicks: (compId: number, stageId: number, picks: Record<string, number>) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}/picks`, { method: 'PUT', body: JSON.stringify(picks) }),
    getFantasyTopPicks: (compId: number, stageId: number) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}/top-picks`),

    // User self-update
    updateMe: (data: Record<string, any>) =>
      request('/api/auth/me', { method: 'PUT', body: JSON.stringify(data) }),

    // Permission Groups
    getAllPermissions: () => request('/api/permissions/all'),
    getPermissionGroups: () => request('/api/permission-groups'),
    createPermissionGroup: (data: { name: string; permissions: string[] }) =>
      request('/api/permission-groups', { method: 'POST', body: JSON.stringify(data) }),
    updatePermissionGroup: (id: number, data: { name?: string; permissions?: string[] }) =>
      request(`/api/permission-groups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deletePermissionGroup: (id: number) =>
      request(`/api/permission-groups/${id}`, { method: 'DELETE' }),
    getPlayerGroups: (playerId: number) => request(`/api/players/${playerId}/groups`),
    setPlayerGroups: (playerId: number, groupIds: number[]) =>
      request(`/api/players/${playerId}/groups`, { method: 'PUT', body: JSON.stringify({ groupIds }) }),

    // Site Settings
    getSiteSettings: () => request('/api/site-settings'),
    updateSiteSettings: (data: Record<string, string>) =>
      request('/api/site-settings', { method: 'PUT', body: JSON.stringify(data) }),
    uploadSiteLogo: async (file: File) => {
      const form = new FormData()
      form.append('logo', file)
      const token = localStorage.getItem('draft_auth_token')
      const res = await fetch('/api/site-settings/logo', {
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
    deleteSiteLogo: () =>
      request('/api/site-settings/logo', { method: 'DELETE' }),

    // Twitch OAuth
    getTwitchLinkUrl: () => request('/api/auth/twitch/link'),
    unlinkTwitch: () => request('/api/auth/twitch/unlink', { method: 'POST' }),

    // Discord OAuth
    getDiscordLinkUrl: () => request('/api/auth/discord/link'),
    unlinkDiscord: () => request('/api/auth/discord/unlink', { method: 'POST' }),

    // Streamers (public)
    getStreamers: () => request('/api/streamers'),

    // Users (global)
    getPlayerProfile: (id: number) => request(`/api/players/${id}/profile`),
    getUsers: () => request('/api/users'),
    updatePlayer: (id: number, data: Record<string, any>) =>
      request(`/api/players/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    impersonateUser: (id: number) =>
      request(`/api/admin/impersonate/${id}`, { method: 'POST' }),
    generateTestUsers: (count: number) =>
      request('/api/admin/generate-test-users', { method: 'POST', body: JSON.stringify({ count }) }),
    parseSteamIds: (input: string) =>
      request('/api/admin/parse-steam-ids', { method: 'POST', body: JSON.stringify({ input }) }),
    importSteamUser: (steamId: string) =>
      request('/api/admin/import-steam-user', { method: 'POST', body: JSON.stringify({ steamId }) }),
    syncSteamUser: (id: number) =>
      request(`/api/admin/sync-steam-user/${id}`, { method: 'POST' }),
    syncSteamAll: () =>
      request('/api/admin/sync-steam-all', { method: 'POST' }),
    getSteamSyncStatus: () =>
      request('/api/admin/steam-sync-status'),
    getOnlineUsers: () =>
      request('/api/admin/online-users'),

    // Competition Streams
    getCompStreams: (compId: number) => request(`/api/competitions/${compId}/streams`),
    getCompStreamsLive: (compId: number) => request(`/api/competitions/${compId}/streams/live`),
    addCompStream: (compId: number, data: { twitch_username: string; title?: string }) =>
      request(`/api/competitions/${compId}/streams`, { method: 'POST', body: JSON.stringify(data) }),
    updateCompStream: (compId: number, streamId: number, data: { twitch_username?: string; title?: string }) =>
      request(`/api/competitions/${compId}/streams/${streamId}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteCompStream: (compId: number, streamId: number) =>
      request(`/api/competitions/${compId}/streams/${streamId}`, { method: 'DELETE' }),

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
