import { ref } from 'vue'

const isDark = ref(localStorage.getItem('draft_theme') !== 'light')

function applyDom(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark)
  localStorage.setItem('draft_theme', dark ? 'dark' : 'light')
}

applyDom(isDark.value)

export function useTheme() {
  function toggle() {
    isDark.value = !isDark.value
    applyDom(isDark.value)
  }
  return { isDark, toggle }
}
