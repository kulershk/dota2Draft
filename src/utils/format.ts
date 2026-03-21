export function formatMatchDate(dateStr: string): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr.replace('Z', ''))
  const now = new Date()
  const diffMs = d.getTime() - now.getTime()
  const diffH = Math.floor(diffMs / 3600000)
  const diffD = Math.floor(diffMs / 86400000)
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (diffMs < 0) return `${date} ${time}`
  if (diffH < 1) return 'Starting soon'
  if (diffD === 0) return `Today ${time}`
  if (diffD === 1) return `Tomorrow ${time}`
  return `${date} ${time}`
}

export function formatDate(dateStr: string): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr.replace('Z', ''))
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatDateShort(dateStr: string): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr.replace('Z', ''))
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr.replace('Z', ''))
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  return `${diffD}d ago`
}
