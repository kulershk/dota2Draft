import { createRouter, createWebHistory } from 'vue-router'
import { useDraftStore } from '@/composables/useDraftStore'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('@/pages/HomePage.vue') },
    {
      path: '/c/:compId',
      component: () => import('@/pages/CompetitionLayout.vue'),
      children: [
        { path: '', redirect: to => ({ path: `/c/${to.params.compId}/players` }) },
        { path: 'players', name: 'comp-players', component: () => import('@/pages/PlayersPage.vue') },
        { path: 'auction', name: 'comp-auction', component: () => import('@/pages/AuctionPage.vue') },
        { path: 'results', name: 'comp-results', component: () => import('@/pages/ResultsPage.vue') },
      ],
    },
    {
      path: '/admin',
      component: () => import('@/pages/admin/AdminLayout.vue'),
      meta: { requiresAdmin: true },
      redirect: '/admin/competitions',
      children: [
        { path: 'competitions', name: 'admin-competitions', component: () => import('@/pages/admin/AdminCompetitionsPage.vue') },
        { path: 'competitions/:compId', name: 'admin-competition-setup', component: () => import('@/pages/admin/AdminCompetitionSetupPage.vue') },
        { path: 'users', name: 'admin-users', component: () => import('@/pages/admin/AdminUsersPage.vue') },
        { path: 'news', name: 'admin-news', component: () => import('@/pages/admin/AdminNewsPage.vue') },
      ],
    },
  ],
})

router.beforeEach((to) => {
  if (to.meta.requiresAdmin) {
    const store = useDraftStore()
    if (!store.isAdmin.value) {
      return { name: 'home' }
    }
  }
})

export default router
