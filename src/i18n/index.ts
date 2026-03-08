import { createI18n } from 'vue-i18n'
import en from './en'
import lt from './lt'
import lv from './lv'

const savedLocale = localStorage.getItem('draft_locale') || 'en'

const i18n = createI18n({
  legacy: false,
  locale: savedLocale,
  fallbackLocale: 'en',
  messages: { en, lt, lv },
})

export function setLocale(locale: string) {
  ;(i18n.global.locale as any).value = locale
  localStorage.setItem('draft_locale', locale)
}

export default i18n
