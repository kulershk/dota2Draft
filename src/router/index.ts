import { createRouter, createWebHistory } from 'vue-router'
import { useDraftStore } from '@/composables/useDraftStore'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('@/pages/HomePage.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/pages/SettingsPage.vue') },
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

export default router
