function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = localStorage.getItem('draft_auth_token')
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

// Listeners notified when a request is rejected because the caller is banned.
const bannedListeners = new Set<(reason: string | null) => void>()
export function onBannedAction(fn: (reason: string | null) => void): () => void {
  bannedListeners.add(fn)
  return () => bannedListeners.delete(fn)
}

// localStorage key + helper for the SWR site-settings cache. Cleared after
// any admin write so admins (and other tabs on the same browser) pick up
// fresh values on the next read.
const SITE_SETTINGS_CACHE_KEY = 'draft_site_settings_v1'
function invalidateSiteSettingsCache() {
  try { localStorage.removeItem(SITE_SETTINGS_CACHE_KEY) } catch {}
}

async function request(path: string, options?: RequestInit) {
  const res = await fetch(path, {
    headers: getAuthHeaders(),
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    if (res.status === 403 && err?.error === 'banned') {
      for (const fn of bannedListeners) {
        try { fn(err.reason ?? null) } catch {}
      }
    }
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
    getCompetitions: async (opts?: { limit?: number; offset?: number; search?: string }) => {
      const qs = new URLSearchParams()
      if (opts?.limit) qs.set('limit', String(opts.limit))
      if (opts?.offset) qs.set('offset', String(opts.offset))
      if (opts?.search) qs.set('search', opts.search)
      const url = qs.toString() ? `/api/competitions?${qs}` : '/api/competitions'
      const res = await request(url)
      // New shape: { rows, total, limit, offset }
      return res
    },
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

    // Team registration (captain self-registers a pre-formed team)
    registerTeam: (compId: number, data: {
      team: string
      captainRole?: number | null
      members: { playerId: number; playingRole?: number | null }[]
    }) =>
      request(`/api/competitions/${compId}/team-registration`, { method: 'POST', body: JSON.stringify(data) }),

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
    adminRetryQueueLobby: (queueMatchId: number) =>
      request(`/api/admin/queue/matches/${queueMatchId}/retry-lobby`, { method: 'POST' }),
    getUpcomingMatches: () => request('/api/upcoming-matches'),
    getAllMatches: (opts?: { status?: string; limit?: number; offset?: number; search?: string }) => {
      const qs = new URLSearchParams()
      if (opts?.status && opts.status !== 'all') qs.set('status', opts.status)
      if (opts?.limit) qs.set('limit', String(opts.limit))
      if (opts?.offset) qs.set('offset', String(opts.offset))
      if (opts?.search) qs.set('search', opts.search)
      const url = qs.toString() ? `/api/matches?${qs}` : '/api/matches'
      return request(url)
    },
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

    // Placement XP
    getPlacementsPreview: (compId: number) =>
      request(`/api/competitions/${compId}/placements/preview`),
    awardPlacementXp: (compId: number, stageId: number) =>
      request(`/api/competitions/${compId}/placements/${stageId}/award`, { method: 'POST' }),

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

    // Discord Settings (admin)
    getDiscordSettings: () => request('/api/admin/discord/settings') as Promise<Record<string, string>>,
    updateDiscordSettings: (data: Record<string, string | boolean>) =>
      request('/api/admin/discord/settings', { method: 'PUT', body: JSON.stringify(data) }),
    getDiscordRoles: () =>
      request('/api/admin/discord/roles') as Promise<{
        guildId: string
        roles: Array<{ id: string; name: string; color: number; position: number; managed: boolean; hoist: boolean; mentionable: boolean }>
      }>,
    getDiscordChannels: () =>
      request('/api/admin/discord/channels') as Promise<{
        guildId: string
        channels: Array<{ id: string; name: string; type: 'text' | 'voice' | 'category' | 'announcement' | 'forum' | 'stage' | 'other'; parentId: string | null; position: number }>
      }>,
    getDiscordHealth: () =>
      request('/api/admin/discord/health') as Promise<{ reachable: boolean; ready?: boolean; bot?: string | null; settingsLoaded?: boolean; error?: string }>,

    // Site Settings
    getSiteSettings: () => request('/api/site-settings'),
    // Stale-while-revalidate variant: returns cached payload from localStorage
    // immediately (or null on first ever visit) and a `fresh` promise that
    // resolves to the up-to-date payload and writes it back to localStorage.
    // Use for non-admin reads where rendering instantly from a slightly stale
    // value beats waiting on the network. Admins editing settings should
    // continue to use getSiteSettings() for the live value.
    getSiteSettingsCached: (): { cached: any | null; fresh: Promise<any> } => {
      let cached: any = null
      try {
        const raw = localStorage.getItem(SITE_SETTINGS_CACHE_KEY)
        if (raw) cached = JSON.parse(raw)
      } catch {}
      const fresh = request('/api/site-settings').then((data: any) => {
        try { localStorage.setItem(SITE_SETTINGS_CACHE_KEY, JSON.stringify(data)) } catch {}
        return data
      })
      return { cached, fresh }
    },
    updateSiteSettings: async (data: Record<string, string | boolean>) => {
      const r = await request('/api/site-settings', { method: 'PUT', body: JSON.stringify(data) })
      invalidateSiteSettingsCache()
      return r
    },
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
      invalidateSiteSettingsCache()
      return res.json()
    },
    deleteSiteLogo: async () => {
      const r = await request('/api/site-settings/logo', { method: 'DELETE' })
      invalidateSiteSettingsCache()
      return r
    },
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
      invalidateSiteSettingsCache()
      return res.json()
    },
    deleteSiteHeroBanner: async () => {
      const r = await request('/api/site-settings/hero-banner', { method: 'DELETE' })
      invalidateSiteSettingsCache()
      return r
    },

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
    getPlayerMatches: (id: number, params?: { limit?: number; offset?: number }) => {
      const qs = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : ''
      return request(`/api/players/${id}/matches${qs}`)
    },
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
    banPlayer: (id: number, reason?: string) =>
      request(`/api/admin/players/${id}/ban`, { method: 'POST', body: JSON.stringify({ reason: reason || null }) }),
    unbanPlayer: (id: number) =>
      request(`/api/admin/players/${id}/unban`, { method: 'POST' }),
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
    getNews: (opts?: { limit?: number; offset?: number }) => {
      const qs = new URLSearchParams()
      if (opts?.limit) qs.set('limit', String(opts.limit))
      if (opts?.offset) qs.set('offset', String(opts.offset))
      const url = qs.toString() ? `/api/news?${qs}` : '/api/news'
      return request(url)
    },
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

    // Leagues
    getLeagues: () => request('/api/leagues'),
    createLeague: (data: { name: string; dota_league_id: number; public?: boolean }) =>
      request('/api/leagues', { method: 'POST', body: JSON.stringify(data) }),
    updateLeague: (id: number, data: { name?: string; dota_league_id?: number; public?: boolean }) =>
      request(`/api/leagues/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteLeague: (id: number) =>
      request(`/api/leagues/${id}`, { method: 'DELETE' }),

    // Subscription plans
    getActiveSubscriptionPlans: () => request('/api/subscription-plans'),
    getAdminSubscriptionPlans: () => request('/api/admin/subscription-plans'),
    createSubscriptionPlan: (data: {
      name: string; slug?: string; description?: string | null;
      price_cents?: number; currency?: string; perks?: any;
      is_active?: boolean; sort_order?: number;
    }) => request('/api/admin/subscription-plans', { method: 'POST', body: JSON.stringify(data) }),
    updateSubscriptionPlan: (id: number, data: {
      name?: string; slug?: string; description?: string | null;
      price_cents?: number; currency?: string; perks?: any;
      is_active?: boolean; sort_order?: number;
    }) => request(`/api/admin/subscription-plans/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteSubscriptionPlan: (id: number) =>
      request(`/api/admin/subscription-plans/${id}`, { method: 'DELETE' }),
    getSubscriptionPlanSubscribers: (id: number) =>
      request(`/api/admin/subscription-plans/${id}/subscribers`),
    addSubscriptionPlanSubscriber: (id: number, data: { player_id: number; expires_at?: string | null }) =>
      request(`/api/admin/subscription-plans/${id}/subscribers`, { method: 'POST', body: JSON.stringify(data) }),
    cancelSubscriptionPlanSubscriber: (planId: number, subscriptionId: number) =>
      request(`/api/admin/subscription-plans/${planId}/subscribers/${subscriptionId}`, { method: 'DELETE' }),
    uploadSubscriptionPlanBadge: async (id: number, file: File): Promise<{ badge_url: string }> => {
      const formData = new FormData()
      formData.append('badge', file)
      const headers: Record<string, string> = {}
      const tok = (typeof localStorage !== 'undefined') ? localStorage.getItem('draft_auth_token') : null
      if (tok) headers['Authorization'] = `Bearer ${tok}`
      const res = await fetch('/api/admin/subscription-plans/' + id + '/badge', {
        method: 'POST',
        body: formData,
        headers,
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error || 'Upload failed')
      }
      return res.json()
    },
    deleteSubscriptionPlanBadge: (id: number) =>
      request(`/api/admin/subscription-plans/${id}/badge`, { method: 'DELETE' }),

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
    getQueuePlayerStats: (params: { poolId: number; playerIds: number[]; limit?: number }) => {
      const qs = new URLSearchParams()
      qs.set('poolId', String(params.poolId))
      qs.set('playerIds', params.playerIds.join(','))
      if (params.limit) qs.set('limit', String(params.limit))
      return request(`/api/queue/players/stats?${qs}`) as Promise<Array<{ playerId: number; wins: number; losses: number }>>
    },
    getQueueMatch: (id: number) => request(`/api/queue/match/${id}`),
    getQueueMatchLive: (id: number) => request(`/api/queue/match/${id}/live`),
    getMatchLive: (matchId: number) => request(`/api/matches/${matchId}/live`),
    setMatchLiveServerSteamId: (matchId: number, server_steam_id: string) =>
      request(`/api/admin/matches/${matchId}/live-server-id`, { method: 'POST', body: JSON.stringify({ server_steam_id }) }),
    restartMatchLive: (matchId: number) =>
      request(`/api/admin/matches/${matchId}/live-restart`, { method: 'POST' }),
    debugMatchLive: (matchId: number) =>
      request(`/api/admin/matches/${matchId}/live-debug`),
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
    forceCompleteQueueMatch: (id: number) =>
      request(`/api/admin/queue/matches/${id}/force-complete`, { method: 'POST' }),
    getAdminQueuePlayers: () => request('/api/admin/queue/players'),
    adminKickFromQueue: (playerId: number, reason?: string) =>
      request(`/api/admin/queue/kick/${playerId}`, { method: 'POST', body: JSON.stringify({ reason }) }),
    getAdminQueueBans: (poolId?: number | 'global') => {
      const qs = poolId == null ? '' : `?pool_id=${poolId}`
      return request(`/api/admin/queue/bans${qs}`)
    },
    addAdminQueueBan: (data: { player_id: number; pool_id?: number | null; duration_minutes?: number; reason?: string }) =>
      request('/api/admin/queue/bans', { method: 'POST', body: JSON.stringify(data) }),
    removeAdminQueueBan: (banId: number) =>
      request(`/api/admin/queue/bans/${banId}`, { method: 'DELETE' }),

    // Seasons (public)
    getPublicSeasons: () => request('/api/seasons'),
    getPublicSeason: (slug: string) => request(`/api/seasons/${slug}`),
    getSeasonLeaderboard: (slug: string, params?: { limit?: number; offset?: number }) => {
      const qs = new URLSearchParams()
      if (params?.limit) qs.set('limit', String(params.limit))
      if (params?.offset) qs.set('offset', String(params.offset))
      const tail = qs.toString() ? `?${qs}` : ''
      return request(`/api/seasons/${slug}/leaderboard${tail}`)
    },
    getSeasonPlayer: (slug: string, playerId: number) =>
      request(`/api/seasons/${slug}/players/${playerId}`),
    getPlayerSeasons: (playerId: number) =>
      request(`/api/players/${playerId}/seasons`),

    // Seasons (admin)
    getAdminSeasons: () => request('/api/admin/seasons'),
    getAdminSeason: (id: number) => request(`/api/admin/seasons/${id}`),
    createSeason: (data: Record<string, any>) =>
      request('/api/admin/seasons', { method: 'POST', body: JSON.stringify(data) }),
    updateSeason: (id: number, data: Record<string, any>) =>
      request(`/api/admin/seasons/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteSeason: (id: number) =>
      request(`/api/admin/seasons/${id}`, { method: 'DELETE' }),
    getAdminSeasonLeaderboard: (id: number) => request(`/api/admin/seasons/${id}/leaderboard`),
    getAdminSeasonAudit: (id: number, params?: { playerId?: number; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams()
      if (params?.playerId) qs.set('playerId', String(params.playerId))
      if (params?.limit) qs.set('limit', String(params.limit))
      if (params?.offset) qs.set('offset', String(params.offset))
      const tail = qs.toString() ? `?${qs}` : ''
      return request(`/api/admin/seasons/${id}/audit${tail}`)
    },
    adjustSeasonPoints: (id: number, data: { player_id: number; delta: number; reason?: string }) =>
      request(`/api/admin/seasons/${id}/adjust`, { method: 'POST', body: JSON.stringify(data) }),
    recomputeSeason: (id: number) =>
      request(`/api/admin/seasons/${id}/recompute`, { method: 'POST' }),
    backfillSeason: (id: number) =>
      request(`/api/admin/seasons/${id}/backfill`, { method: 'POST' }),

    // MMR verification (user)
    submitMmrVerification: async (mmr: number, screenshot: File) => {
      const fd = new FormData()
      fd.append('mmr', String(mmr))
      fd.append('screenshot', screenshot)
      const token = localStorage.getItem('draft_auth_token')
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch('/api/mmr-verifications', { method: 'POST', headers, body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error || 'Submission failed')
      }
      return res.json()
    },
    getMyMmrVerifications: () => request('/api/mmr-verifications/mine'),
    cancelMmrVerification: (id: number) =>
      request(`/api/mmr-verifications/${id}/cancel`, { method: 'POST' }),

    // MMR verification (admin)
    getAdminMmrVerifications: (status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'all' = 'pending', playerId?: number) => {
      const qs = new URLSearchParams({ status })
      if (playerId) qs.set('playerId', String(playerId))
      return request(`/api/admin/mmr-verifications?${qs}`)
    },
    approveMmrVerification: (id: number, note?: string) =>
      request(`/api/admin/mmr-verifications/${id}/approve`, { method: 'POST', body: JSON.stringify({ note }) }),
    rejectMmrVerification: (id: number, note?: string) =>
      request(`/api/admin/mmr-verifications/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),

    // Sponsors (admin)
    uploadSponsor: async (logo: File, alt: string, link: string) => {
      const fd = new FormData()
      fd.append('logo', logo)
      fd.append('alt', alt)
      fd.append('link', link)
      const token = localStorage.getItem('draft_auth_token')
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch('/api/site-settings/sponsors', { method: 'POST', headers, body: fd })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error || 'Upload failed')
      }
      invalidateSiteSettingsCache()
      return res.json()
    },
    updateSponsor: async (id: number, data: { alt?: string; link?: string }) => {
      const r = await request(`/api/site-settings/sponsors/${id}`, { method: 'PUT', body: JSON.stringify(data) })
      invalidateSiteSettingsCache()
      return r
    },
    deleteSponsor: async (id: number) => {
      const r = await request(`/api/site-settings/sponsors/${id}`, { method: 'DELETE' })
      invalidateSiteSettingsCache()
      return r
    },

    // Admin Request Stats
    getRequestStatsSummary: (period: string, opts?: { userId?: number; ip?: string; from?: string; to?: string }) => {
      const qs = new URLSearchParams({ period })
      if (opts?.userId) qs.set('userId', String(opts.userId))
      if (opts?.ip) qs.set('ip', opts.ip)
      if (opts?.from) qs.set('from', opts.from)
      if (opts?.to) qs.set('to', opts.to)
      return request(`/api/admin/stats/summary?${qs}`)
    },
    getRequestStatsTopRoutes: (period: string, opts?: { limit?: number; userId?: number; ip?: string; from?: string; to?: string }) => {
      const qs = new URLSearchParams({ period })
      qs.set('limit', String(opts?.limit ?? 20))
      if (opts?.userId) qs.set('userId', String(opts.userId))
      if (opts?.ip) qs.set('ip', opts.ip)
      if (opts?.from) qs.set('from', opts.from)
      if (opts?.to) qs.set('to', opts.to)
      return request(`/api/admin/stats/top-routes?${qs}`)
    },
    getRequestStatsTimeseries: (period: string, opts?: { bucket?: string; path?: string; method?: string; userId?: number; ip?: string; from?: string; to?: string }) => {
      const qs = new URLSearchParams({ period })
      if (opts?.bucket) qs.set('bucket', opts.bucket)
      if (opts?.path) qs.set('path', opts.path)
      if (opts?.method) qs.set('method', opts.method)
      if (opts?.userId) qs.set('userId', String(opts.userId))
      if (opts?.ip) qs.set('ip', opts.ip)
      if (opts?.from) qs.set('from', opts.from)
      if (opts?.to) qs.set('to', opts.to)
      return request(`/api/admin/stats/timeseries?${qs}`)
    },
    getRequestStatsTopUsers: (period: string, opts?: { limit?: number; ip?: string; from?: string; to?: string }) => {
      const qs = new URLSearchParams({ period })
      qs.set('limit', String(opts?.limit ?? 20))
      if (opts?.ip) qs.set('ip', opts.ip)
      if (opts?.from) qs.set('from', opts.from)
      if (opts?.to) qs.set('to', opts.to)
      return request(`/api/admin/stats/top-users?${qs}`)
    },
    getSocketEventStats: (period: string, opts?: { limit?: number; userId?: number; from?: string; to?: string }) => {
      const qs = new URLSearchParams({ period })
      qs.set('limit', String(opts?.limit ?? 50))
      if (opts?.userId) qs.set('userId', String(opts.userId))
      if (opts?.from) qs.set('from', opts.from)
      if (opts?.to) qs.set('to', opts.to)
      return request(`/api/admin/stats/socket-events?${qs}`)
    },
    getMultiAccountInspection: (userId: number, opts?: { days?: number; limit?: number }) => {
      const qs = new URLSearchParams()
      qs.set('days', String(opts?.days ?? 30))
      qs.set('limit', String(opts?.limit ?? 50))
      return request(`/api/admin/users/${userId}/multi-account?${qs}`)
    },
    getRequestStatsTopIps: (period: string, opts?: { limit?: number; userId?: number; from?: string; to?: string }) => {
      const qs = new URLSearchParams({ period })
      qs.set('limit', String(opts?.limit ?? 20))
      if (opts?.userId) qs.set('userId', String(opts.userId))
      if (opts?.from) qs.set('from', opts.from)
      if (opts?.to) qs.set('to', opts.to)
      return request(`/api/admin/stats/top-ips?${qs}`)
    },
    getRequestStatsRecentRequests: (period: string, opts: { userId?: number; ip?: string; limit?: number; from?: string; to?: string }) => {
      const qs = new URLSearchParams({ period })
      qs.set('limit', String(opts.limit ?? 100))
      if (opts.userId) qs.set('userId', String(opts.userId))
      if (opts.ip) qs.set('ip', opts.ip)
      if (opts.from) qs.set('from', opts.from)
      if (opts.to) qs.set('to', opts.to)
      return request(`/api/admin/stats/recent-requests?${qs}`)
    },
    getRequestStatsTopPages: (period: string, opts?: { limit?: number; userId?: number; from?: string; to?: string }) => {
      const qs = new URLSearchParams({ period })
      qs.set('limit', String(opts?.limit ?? 20))
      if (opts?.userId) qs.set('userId', String(opts.userId))
      if (opts?.from) qs.set('from', opts.from)
      if (opts?.to) qs.set('to', opts.to)
      return request(`/api/admin/stats/top-pages?${qs}`)
    },
    getRequestStatsRecentPages: (period: string, opts: { userId: number; limit?: number; from?: string; to?: string }) => {
      const qs = new URLSearchParams({ period })
      qs.set('limit', String(opts.limit ?? 100))
      qs.set('userId', String(opts.userId))
      if (opts.from) qs.set('from', opts.from)
      if (opts.to) qs.set('to', opts.to)
      return request(`/api/admin/stats/recent-pages?${qs}`)
    },

    // Global search
    search: (q: string, limit = 8) =>
      request(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),

    // Nav items
    getNavItems: () => request('/api/nav-items'),
    getAdminNavItems: () => request('/api/admin/nav-items'),
    createNavItem: (data: Record<string, any>) =>
      request('/api/admin/nav-items', { method: 'POST', body: JSON.stringify(data) }),
    updateNavItem: (id: number, data: Record<string, any>) =>
      request(`/api/admin/nav-items/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteNavItem: (id: number) =>
      request(`/api/admin/nav-items/${id}`, { method: 'DELETE' }),
    reorderNavItems: (order: number[]) =>
      request('/api/admin/nav-items/reorder', { method: 'PUT', body: JSON.stringify({ order }) }),

    // Home page data
    getHomeStats: () => request('/api/home/stats'),
    getFeaturedTournament: () => request('/api/home/featured-tournament'),
    getHomeTopPlayers: (limit = 5) => request(`/api/home/top-players?limit=${limit}`),
    getHomeHeroPickRate: (days = 7, limit = 3) => request(`/api/home/hero-pick-rate?days=${days}&limit=${limit}`),
  }
}
