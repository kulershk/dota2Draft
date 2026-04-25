import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import './assets/main.css'

// After a deploy the old index.html is cached in users' open tabs and points
// at chunk filenames whose content hashes no longer exist on the server. The
// next dynamic import (route navigation, lazy modal, etc.) 404s. Catch the
// Vite preload-error and force a full reload — the new index.html will then
// resolve to the current chunk names. Guarded against reload loops.
window.addEventListener('vite:preloadError', () => {
  const KEY = 'draft_chunk_reload_at'
  const last = Number(sessionStorage.getItem(KEY) || 0)
  if (Date.now() - last < 10_000) return // already tried recently — let the error bubble
  sessionStorage.setItem(KEY, String(Date.now()))
  window.location.reload()
})

createApp(App).use(router).use(i18n).mount('#app')
