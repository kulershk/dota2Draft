import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import './assets/main.css'

// Stale-chunk auto-reload (after deploys with new chunk hashes) is wired
// inside router/index.ts via router.onError + vite:preloadError +
// unhandledrejection.

createApp(App).use(router).use(i18n).mount('#app')
