import { getServerNow } from '@/composables/useSocket'

export function formatMatchDate(dateStr: string, t?: (key: string) => string): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  const now = new Date(getServerNow())
  const diffMs = d.getTime() - now.getTime()
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (diffMs < 0) return `${date} ${time}`
  if (diffMs < 3600000) return t ? t('startingSoon') : 'Starting soon'
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const matchDate = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dayDiff = Math.round((matchDate.getTime() - todayDate.getTime()) / 86400000)
  if (dayDiff === 0) return `${t ? t('today') : 'Today'} ${time}`
  if (dayDiff === 1) return `${t ? t('tomorrow') : 'Tomorrow'} ${time}`
  return `${date} ${time}`
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatDateShort(dateStr: string): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Convert a UTC date string to a local datetime string for datetime-local inputs */
export function toLocalDatetime(dateStr: string): string {
  const d = new Date(dateStr)
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16)
}

/** Convert a local datetime-local input value to a UTC ISO string for the server */
export function localDatetimeToISO(localStr: string): string {
  return new Date(localStr).toISOString()
}

export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  const now = new Date(getServerNow())
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  return `${diffD}d ago`
}
