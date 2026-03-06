import { createRouter, createWebHistory } from 'vue-router'
import { useDraftStore } from '@/composables/useDraftStore'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'setup', component: () => import('@/pages/SetupPage.vue'), meta: { requiresAdmin: true } },
    { path: '/players', name: 'players', component: () => import('@/pages/PlayersPage.vue') },
    { path: '/auction', name: 'auction', component: () => import('@/pages/AuctionPage.vue') },
    { path: '/results', name: 'results', component: () => import('@/pages/ResultsPage.vue') },
  ],
})

router.beforeEach((to) => {
  if (to.meta.requiresAdmin) {
    const store = useDraftStore()
    if (!store.isAdmin.value) {
      return { name: 'players' }
    }
  }
})

export default router
