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
    getDailyStatus: () => request('/api/auth/daily-status'),
    claimDaily: () => request('/api/auth/daily-claim', { method: 'POST' }),

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
    syncPlayerRoles: (compId: number) =>
      request(`/api/competitions/${compId}/players/sync-roles`, { method: 'POST' }),
    assignPlayer: (compId: number, playerId: number, captainId: number) =>
      request(`/api/competitions/${compId}/players/${playerId}/assign`, { method: 'POST', body: JSON.stringify({ captainId }) }),
    unassignPlayer: (compId: number, playerId: number) =>
      request(`/api/competitions/${compId}/players/${playerId}/unassign`, { method: 'POST' }),

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

    // Dota constants
    getDotaConstants: () => request('/api/dota/constants'),

    // Admin games
    getUnparsedGames: () => request('/api/admin/games/unparsed'),
    getAllGames: () => request('/api/admin/games/all'),
    refetchGame: (gameId: number) => request(`/api/admin/games/${gameId}/refetch`, { method: 'POST' }),

    // Competition Templates
    getCompetitionTemplates: () => request('/api/competition-templates'),
    createTemplateFromCompetition: (compId: number, data: { name: string; description?: string }) =>
      request(`/api/competition-templates/from-competition/${compId}`, { method: 'POST', body: JSON.stringify(data) }),
    deleteCompetitionTemplate: (id: number) =>
      request(`/api/competition-templates/${id}`, { method: 'DELETE' }),

    // Competition Auction
    getCompAuction: (compId: number) => request(`/api/competitions/${compId}/auction`),
    getCompResults: (compId: number) => request(`/api/competitions/${compId}/auction/results`),

    // Tournament
    getTournament: (compId: number) => request(`/api/competitions/${compId}/tournament`),
    repairBracketAdvancement: (compId: number) =>
      request(`/api/competitions/${compId}/tournament/repair-advancement`, { method: 'POST' }),
    getUpcomingMatches: () => request('/api/upcoming-matches'),
    getAllMatches: (status?: string) => request(`/api/matches${status && status !== 'all' ? `?status=${status}` : ''}`),
    getMyUpcomingMatchCount: () => request('/api/matches/my-upcoming-count'),
    addTournamentStage: (compId: number, data: { name: string; format: string; groups?: any[]; bestOf?: number; seeds?: number[] }) =>
      request(`/api/competitions/${compId}/tournament/stages`, { method: 'POST', body: JSON.stringify(data) }),
    updateTournamentStage: (compId: number, stageId: number, data: { name?: string; status?: string }) =>
      request(`/api/competitions/${compId}/tournament/stages/${stageId}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteTournamentStage: (compId: number, stageId: number) =>
      request(`/api/competitions/${compId}/tournament/stages/${stageId}`, { method: 'DELETE' }),
    // Custom bracket
    addCustomStageMatch: (compId: number, stageId: number, data: { best_of?: number; round?: number; match_order?: number; label?: string | null; team1_captain_id?: number | null; team2_captain_id?: number | null }) =>
      request(`/api/competitions/${compId}/tournament/stages/${stageId}/matches`, { method: 'POST', body: JSON.stringify(data) }),
    updateMatchMeta: (matchId: number, data: { best_of?: number; round?: number; match_order?: number; label?: string | null }) =>
      request(`/api/admin/matches/${matchId}/meta`, { method: 'PATCH', body: JSON.stringify(data) }),
    updateMatchTeams: (matchId: number, data: { team1_captain_id?: number | null; team2_captain_id?: number | null }) =>
      request(`/api/admin/matches/${matchId}/teams`, { method: 'PATCH', body: JSON.stringify(data) }),
    updateMatchLinks: (matchId: number, data: { next_match_id?: number | null; next_match_slot?: number | null; loser_next_match_id?: number | null; loser_next_match_slot?: number | null }) =>
      request(`/api/admin/matches/${matchId}/links`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteCustomMatch: (matchId: number) =>
      request(`/api/admin/matches/${matchId}`, { method: 'DELETE' }),
    activateCustomStage: (compId: number, stageId: number) =>
      request(`/api/competitions/${compId}/tournament/stages/${stageId}/activate`, { method: 'POST' }),
    // Match Standins
    getMatchStandins: (compId: number, matchId: number) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/standins`),
    addMatchStandin: (compId: number, matchId: number, data: { original_player_id: number; standin_player_id: number; captain_id: number; match_game_id?: number }) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/standins`, { method: 'POST', body: JSON.stringify(data) }),
    removeMatchStandin: (compId: number, matchId: number, id: number) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/standins/${id}`, { method: 'DELETE' }),
    updateMatchScore: (compId: number, matchId: number, data: { score1?: number; score2?: number; status?: string; games?: any[] }) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/score`, { method: 'PUT', body: JSON.stringify(data) }),
    updateMatchPenalties: (compId: number, matchId: number, data: { penalty_radiant: number | null; penalty_dire: number | null }) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/penalties`, { method: 'PUT', body: JSON.stringify(data) }),
    resetTournament: (compId: number) =>
      request(`/api/competitions/${compId}/tournament`, { method: 'DELETE' }),
    getMatchGameStats: (compId: number, matchId: number, gameNumber: number) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/games/${gameNumber}/stats`),
    refetchMatchGameStats: (compId: number, matchId: number, gameNumber: number) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/games/${gameNumber}/refetch`, { method: 'POST' }),

    // Fantasy
    getFantasy: (compId: number) => request(`/api/competitions/${compId}/fantasy`),
    getFantasyLeaderboard: (compId: number) => request(`/api/competitions/${compId}/fantasy/leaderboard`),
    createFantasyStage: (compId: number, data: { name: string; matchIds: number[]; allowedCaptainIds?: number[] | null }) =>
      request(`/api/competitions/${compId}/fantasy/stages`, { method: 'POST', body: JSON.stringify(data) }),
    updateFantasyStage: (compId: number, stageId: number, data: Record<string, any>) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteFantasyStage: (compId: number, stageId: number) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}`, { method: 'DELETE' }),
    awardFantasyXp: (compId: number, stageId: number) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}/award-xp`, { method: 'POST' }),
    revokeFantasyXp: (compId: number, stageId: number) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}/revoke-xp`, { method: 'POST' }),
    saveFantasyPicks: (compId: number, stageId: number, picks: Record<string, number>) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}/picks`, { method: 'PUT', body: JSON.stringify(picks) }),
    saveFantasyPick: (compId: number, stageId: number, role: string, playerId: number) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}/pick`, { method: 'PUT', body: JSON.stringify({ role, playerId }) }),
    clearFantasyPick: (compId: number, stageId: number, role: string) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}/pick/${role}`, { method: 'DELETE' }),
    getFantasyTopPicks: (compId: number, stageId: number) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}/top-picks`),
    getFantasyPlayerCheck: (compId: number, stageId: number, playerId: number, role: string) =>
      request(`/api/competitions/${compId}/fantasy/stages/${stageId}/player-check?playerId=${playerId}&role=${role}`),

    // Admin Fantasy Picks
    getAdminFantasyPicks: (compId: number) =>
      request(`/api/competitions/${compId}/fantasy/admin/picks`),
    adminSetFantasyPick: (compId: number, userId: number, stageId: number, role: string, playerId: number) =>
      request(`/api/competitions/${compId}/fantasy/admin/picks/${userId}/stages/${stageId}/pick`, { method: 'PUT', body: JSON.stringify({ role, playerId }) }),
    adminClearFantasyPick: (compId: number, userId: number, stageId: number, role: string) =>
      request(`/api/competitions/${compId}/fantasy/admin/picks/${userId}/stages/${stageId}/pick/${role}`, { method: 'DELETE' }),

    // Lobby Bots
    getBots: () => request('/api/admin/bots'),
    addBot: (data: { username: string; password: string }) =>
      request('/api/admin/bots', { method: 'POST', body: JSON.stringify(data) }),
    deleteBot: (id: number) =>
      request(`/api/admin/bots/${id}`, { method: 'DELETE' }),
    getBotLogs: (id: number) =>
      request(`/api/admin/bots/${id}/logs`),
    connectBot: (id: number) =>
      request(`/api/admin/bots/${id}/connect`, { method: 'POST' }),
    disconnectBot: (id: number) =>
      request(`/api/admin/bots/${id}/disconnect`, { method: 'POST' }),
    submitSteamGuard: (id: number, code: string) =>
      request(`/api/admin/bots/${id}/steam-guard`, { method: 'POST', body: JSON.stringify({ code }) }),
    freeBusyBot: (id: number) =>
      request(`/api/admin/bots/${id}/free`, { method: 'POST' }),
    setBotAutoConnect: (id: number, autoConnect: boolean) =>
      request(`/api/admin/bots/${id}/auto-connect`, { method: 'PUT', body: JSON.stringify({ autoConnect }) }),
    uploadBotAvatar: async (form: FormData) => {
      const token = localStorage.getItem('draft_auth_token')
      const res = await fetch('/api/admin/bots/avatar', {
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

    // Lobby Management
    createLobby: (compId: number, matchId: number, gameNumber: number, data?: Record<string, any>) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/games/${gameNumber}/lobby`, { method: 'POST', body: JSON.stringify(data || {}) }),
    getLobbyStatus: (compId: number, matchId: number, gameNumber: number) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/games/${gameNumber}/lobby`),
    forceLaunchLobby: (compId: number, matchId: number, gameNumber: number) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/games/${gameNumber}/lobby/launch`, { method: 'POST' }),
    cancelLobby: (compId: number, matchId: number, gameNumber: number) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/games/${gameNumber}/lobby/cancel`, { method: 'POST' }),
    resetLobby: (compId: number, matchId: number, gameNumber: number) =>
      request(`/api/competitions/${compId}/tournament/matches/${matchId}/games/${gameNumber}/lobby/reset`, { method: 'POST' }),

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
    uploadSiteHeroBanner: async (file: File) => {
      const form = new FormData()
      form.append('banner', file)
      const token = localStorage.getItem('draft_auth_token')
      const res = await fetch('/api/site-settings/hero-banner', {
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
    deleteSiteHeroBanner: () =>
      request('/api/site-settings/hero-banner', { method: 'DELETE' }),

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
    getPlayerXpLog: (id: number) => request(`/api/players/${id}/xp-log`),
    getAdminXpLog: (params?: Record<string, string | number>) => {
      const qs = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : ''
      return request(`/api/admin/xp-log${qs}`)
    },
    getLeaderboard: (params?: { limit?: number; offset?: number }) => {
      const qs = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : ''
      return request(`/api/leaderboard${qs}`)
    },
    getTeamProfile: (captainId: number) => request(`/api/teams/${captainId}/profile`),
    getUsers: () => request('/api/users'),
    searchPlayers: (q: string) => request(`/api/players/search?q=${encodeURIComponent(q)}`),
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

    // Background jobs (admin)
    getAdminJobs: (params?: Record<string, string | number>) => {
      const qs = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : ''
      return request(`/api/admin/jobs${qs}`)
    },
    getAdminJob: (id: number) => request(`/api/admin/jobs/${id}`),
    createAdminJob: (data: { type: string; payload?: any; maxAttempts?: number }) =>
      request('/api/admin/jobs', { method: 'POST', body: JSON.stringify(data) }),
    retryAdminJob: (id: number) =>
      request(`/api/admin/jobs/${id}/retry`, { method: 'POST' }),
    cancelAdminJob: (id: number) =>
      request(`/api/admin/jobs/${id}/cancel`, { method: 'POST' }),
    deleteAdminJob: (id: number) =>
      request(`/api/admin/jobs/${id}`, { method: 'DELETE' }),
    pruneAdminJobs: (data: { status?: string; olderThanDays?: number }) =>
      request('/api/admin/jobs/prune', { method: 'POST', body: JSON.stringify(data) }),

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
    getNewsPost: (id: number) => request(`/api/news/${id}`),
    uploadNewsImage: async (file: File) => {
      const form = new FormData()
      form.append('image', file)
      const token = localStorage.getItem('draft_auth_token')
      const res = await fetch('/api/news/upload-image', {
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
    createNews: (data: { title: string; content: string; image_url?: string }) =>
      request('/api/news', { method: 'POST', body: JSON.stringify(data) }),
    updateNews: (id: number, data: { title?: string; content?: string; image_url?: string }) =>
      request(`/api/news/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteNews: (id: number) =>
      request(`/api/news/${id}`, { method: 'DELETE' }),

    // News Comments
    getComments: (newsId: number) => request(`/api/news/${newsId}/comments`),
    addComment: (newsId: number, content: string) =>
      request(`/api/news/${newsId}/comments`, { method: 'POST', body: JSON.stringify({ content }) }),
    deleteComment: (newsId: number, commentId: number) =>
      request(`/api/news/${newsId}/comments/${commentId}`, { method: 'DELETE' }),
    voteComment: (newsId: number, commentId: number, vote: number) =>
      request(`/api/news/${newsId}/comments/${commentId}/vote`, { method: 'POST', body: JSON.stringify({ vote }) }),

    // Queue
    getQueuePools: () => request('/api/queue/pools'),
    getQueuePool: (poolId: number) => request(`/api/queue/pools/${poolId}`),
    getQueueHistory: (params?: { poolId?: number; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams()
      if (params?.poolId) qs.set('poolId', String(params.poolId))
      if (params?.limit) qs.set('limit', String(params.limit))
      if (params?.offset) qs.set('offset', String(params.offset))
      return request(`/api/queue/history?${qs}`)
    },
    getQueueMatch: (id: number) => request(`/api/queue/match/${id}`),
    getQueueMatchGameStats: (queueMatchId: number, gameNumber: number) =>
      request(`/api/queue/match/${queueMatchId}/games/${gameNumber}/stats`),

    // Admin Queue
    getAdminQueuePools: () => request('/api/admin/queue/pools'),
    createQueuePool: (data: Record<string, any>) =>
      request('/api/admin/queue/pools', { method: 'POST', body: JSON.stringify(data) }),
    updateQueuePool: (id: number, data: Record<string, any>) =>
      request(`/api/admin/queue/pools/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteQueuePool: (id: number) =>
      request(`/api/admin/queue/pools/${id}`, { method: 'DELETE' }),
    getAdminQueueMatches: () => request('/api/admin/queue/matches'),
    cancelQueueMatch: (id: number) =>
      request(`/api/admin/queue/matches/${id}/cancel`, { method: 'POST' }),
    getAdminQueuePlayers: () => request('/api/admin/queue/players'),
    adminKickFromQueue: (playerId: number, reason?: string) =>
      request(`/api/admin/queue/kick/${playerId}`, { method: 'POST', body: JSON.stringify({ reason }) }),
    getAdminQueueBans: () => request('/api/admin/queue/bans'),
    addAdminQueueBan: (data: { player_id: number; duration_minutes?: number; reason?: string }) =>
      request('/api/admin/queue/bans', { method: 'POST', body: JSON.stringify(data) }),
    removeAdminQueueBan: (playerId: number) =>
      request(`/api/admin/queue/bans/${playerId}`, { method: 'DELETE' }),
  }
}
