import { createRouter, createWebHistory } from 'vue-router'
import { useDraftStore } from '@/composables/useDraftStore'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('@/pages/HomePage.vue') },
    { path: '/players', name: 'players', component: () => import('@/pages/PlayersPage.vue') },
    { path: '/auction', name: 'auction', component: () => import('@/pages/AuctionPage.vue') },
    { path: '/results', name: 'results', component: () => import('@/pages/ResultsPage.vue') },
    {
      path: '/admin',
      component: () => import('@/pages/admin/AdminLayout.vue'),
      meta: { requiresAdmin: true },
      redirect: '/admin/news',
      children: [
        { path: 'draft', name: 'admin-draft', component: () => import('@/pages/SetupPage.vue') },
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
