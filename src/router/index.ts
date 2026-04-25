import { createRouter, createWebHistory } from 'vue-router'
import { useDraftStore } from '@/composables/useDraftStore'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('@/pages/HomePage.vue') },
    { path: '/competitions', name: 'competitions', component: () => import('@/pages/CompetitionsPage.vue') },
    { path: '/matches', name: 'matches', component: () => import('@/pages/MatchesPage.vue') },
    { path: '/how-it-works', name: 'how-it-works', component: () => import('@/pages/HowItWorksPage.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/pages/SettingsPage.vue') },
    { path: '/news', name: 'news', component: () => import('@/pages/NewsPage.vue') },
    { path: '/news/:id', name: 'news-post', component: () => import('@/pages/NewsPostPage.vue') },
    { path: '/queue', name: 'queue', component: () => import('@/pages/QueuePage.vue') },
    { path: '/queue/match/:id', name: 'queue-match', component: () => import('@/pages/QueueMatchPage.vue') },
    { path: '/leaderboard', name: 'leaderboard', component: () => import('@/pages/LeaderboardPage.vue') },
    { path: '/seasons', name: 'seasons', component: () => import('@/pages/SeasonsPage.vue') },
    { path: '/seasons/:slug', name: 'season-leaderboard', component: () => import('@/pages/SeasonLeaderboardPage.vue') },
    { path: '/player/:id', name: 'player-profile', component: () => import('@/pages/PlayerProfilePage.vue') },
    { path: '/team/:id', name: 'team-profile', component: () => import('@/pages/TeamProfilePage.vue') },
    {
      path: '/c/:compId',
      component: () => import('@/pages/CompetitionLayout.vue'),
      children: [
        { path: '', redirect: to => ({ path: `/c/${to.params.compId}/info` }) },
        { path: 'info', name: 'comp-info', component: () => import('@/pages/CompetitionInfoPage.vue') },
        { path: 'players', name: 'comp-players', component: () => import('@/pages/PlayersPage.vue') },
        { path: 'auction', name: 'comp-auction', component: () => import('@/pages/AuctionPage.vue') },
        { path: 'results', name: 'comp-results', component: () => import('@/pages/ResultsPage.vue') },
        { path: 'tournament', name: 'comp-tournament', component: () => import('@/pages/TournamentPage.vue') },
        { path: 'matches', name: 'comp-matches', component: () => import('@/pages/CompetitionMatchesPage.vue') },
        { path: 'fantasy', name: 'comp-fantasy', component: () => import('@/pages/FantasyPage.vue') },
        { path: 'rules', name: 'comp-rules', component: () => import('@/pages/CompetitionRulesPage.vue') },
        { path: 'match/:matchId', name: 'comp-match', component: () => import('@/pages/MatchRoomPage.vue') },
      ],
    },
    {
      path: '/admin',
      component: () => import('@/pages/admin/AdminLayout.vue'),
      meta: { requiresAdmin: true },
      redirect: () => {
        const store = useDraftStore()
        const sections = [
          { path: '/admin/competitions', perms: ['manage_competitions', 'manage_own_competitions'] },
          { path: '/admin/users', perms: ['manage_users'] },
          { path: '/admin/news', perms: ['manage_news'] },
          { path: '/admin/settings', perms: ['manage_site_settings'] },
          { path: '/admin/permissions', perms: ['manage_permissions'] },
          { path: '/admin/jobs', perms: ['manage_jobs'] },
        ]
        const first = sections.find(s => s.perms.some(p => store.hasPerm(p)))
        return first?.path || '/admin/competitions'
      },
      children: [
        { path: 'competitions', name: 'admin-competitions', meta: { permissions: ['manage_competitions', 'manage_own_competitions'] }, component: () => import('@/pages/admin/AdminCompetitionsPage.vue') },
        { path: 'competitions/:compId', name: 'admin-competition-setup', meta: { permissions: ['manage_competitions', 'manage_own_competitions'] }, component: () => import('@/pages/admin/AdminCompetitionSetupPage.vue') },
        { path: 'users', name: 'admin-users', meta: { permissions: ['manage_users'] }, component: () => import('@/pages/admin/AdminUsersPage.vue') },
        { path: 'news', name: 'admin-news', meta: { permissions: ['manage_news'] }, component: () => import('@/pages/admin/AdminNewsPage.vue') },
        { path: 'settings', name: 'admin-settings', meta: { permissions: ['manage_site_settings'] }, component: () => import('@/pages/admin/AdminSiteSettingsPage.vue') },
        { path: 'permissions', name: 'admin-permissions', meta: { permissions: ['manage_permissions'] }, component: () => import('@/pages/admin/AdminPermissionsPage.vue') },
        { path: 'bots', name: 'admin-bots', meta: { permissions: ['manage_bots'] }, component: () => import('@/pages/admin/AdminBotsPage.vue') },
        { path: 'games', name: 'admin-games', meta: { permissions: ['manage_games'] }, component: () => import('@/pages/admin/AdminGamesPage.vue') },
        { path: 'fantasy', name: 'admin-fantasy', meta: { permissions: ['manage_competitions', 'manage_own_competitions'] }, component: () => import('@/pages/admin/AdminFantasyPage.vue') },
        { path: 'xp-log', name: 'admin-xp-log', meta: { permissions: ['manage_users'] }, component: () => import('@/pages/admin/AdminXpLogPage.vue') },
        { path: 'queue', name: 'admin-queue', meta: { permissions: ['manage_queue_pools'] }, component: () => import('@/pages/admin/AdminQueuePage.vue') },
        { path: 'seasons', name: 'admin-seasons', meta: { permissions: ['manage_seasons'] }, component: () => import('@/pages/admin/AdminSeasonsPage.vue') },
        { path: 'seasons/:id', name: 'admin-season-setup', meta: { permissions: ['manage_seasons'] }, component: () => import('@/pages/admin/AdminSeasonSetupPage.vue') },
        { path: 'mmr-verifications', name: 'admin-mmr-verifications', meta: { permissions: ['manage_mmr_verifications'] }, component: () => import('@/pages/admin/AdminMmrVerificationsPage.vue') },
        { path: 'jobs', name: 'admin-jobs', meta: { permissions: ['manage_jobs'] }, component: () => import('@/pages/admin/AdminJobsPage.vue') },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  if (to.meta.requiresAdmin) {
    const store = useDraftStore()
    await store.authReady
    if (!store.canAccessAdmin.value) {
      return { name: 'home' }
    }
    const perms = to.meta.permissions as string[] | undefined
    if (perms && !perms.some(p => store.hasPerm(p))) {
      return { name: 'home' }
    }
  }
})

// Auto-recover from stale chunks after a deploy: when a route's lazy-loaded
// component file no longer exists (filename hash changed in the new build),
// the dynamic import throws. Reload the page once so the browser fetches the
// fresh index.html and current chunk filenames. The sessionStorage flag stops
// us from looping forever if the failure isn't actually about a stale build.
function isChunkLoadError(err: unknown): boolean {
  if (!err) return false
  const msg = err instanceof Error ? err.message : String(err)
  return /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk .* failed/i.test(msg)
}

function reloadOnce() {
  const KEY = 'draft_chunk_reload_at'
  const last = Number(sessionStorage.getItem(KEY) || 0)
  if (Date.now() - last < 10_000) return // already reloaded recently — give up
  sessionStorage.setItem(KEY, String(Date.now()))
  window.location.reload()
}

router.onError((err) => {
  if (isChunkLoadError(err)) reloadOnce()
})

window.addEventListener('vite:preloadError', () => reloadOnce())

export default router
