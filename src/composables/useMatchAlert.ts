import i18n from '@/i18n'

// "Match found — accept now" alert for the queue ready check: a desktop
// notification (only when the page isn't focused, so a user already staring at
// the accept modal isn't double-notified) plus a short sound cue. Everything is
// best-effort — it silently no-ops where the browser lacks support or the user
// hasn't granted notification permission.

let audioCtx: AudioContext | null = null
let lastNotif: Notification | null = null
let lastAlertedId: number | null = null

// Resume / create an AudioContext from inside a user gesture (e.g. clicking
// "Join queue") so a beep can play later without a direct gesture — the browser
// autoplay policy requires the context to have been unlocked by interaction.
// The context persists for the page session, so auto-requeued rounds (no fresh
// click) stay unlocked too.
export function unlockMatchAudio() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return
    if (!audioCtx) audioCtx = new Ctx()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
  } catch { /* ignore */ }
}

// Ask for desktop-notification permission. Call from a user gesture (Chrome
// requires it). No-op if already granted/denied or unsupported.
export function requestMatchNotifyPermission() {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'default') void Notification.requestPermission()
  } catch { /* ignore */ }
}

function playChime() {
  if (!audioCtx) return
  try {
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    const ctx = audioCtx
    const now = ctx.currentTime
    // Two-note rising chime.
    for (const [freq, at] of [[880, 0], [1320, 0.16]] as const) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, now + at)
      gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.15)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + at)
      osc.stop(now + at + 0.16)
    }
  } catch { /* ignore */ }
}

// Fire the match-found alert. `readyCheckId` dedupes: a reconnect can re-emit
// the same ready check, and we don't want to alert twice for one match.
export function fireMatchFoundAlert(readyCheckId?: number) {
  if (readyCheckId != null && readyCheckId === lastAlertedId) return
  if (readyCheckId != null) lastAlertedId = readyCheckId

  playChime()

  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    // A focused, visible user already sees the accept modal — only pop a desktop
    // notification when the tab/window doesn't have focus (other tab, other app,
    // or minimized). hasFocus() covers all three; document.hidden would miss the
    // "another window on top but tab still active" case.
    if (document.hasFocus()) return
    const t = i18n.global.t as (k: string) => string
    lastNotif?.close?.()
    const n = new Notification(t('matchFoundNotifyTitle'), {
      body: t('matchFoundNotifyBody'),
      tag: 'queue-ready-check',
    })
    n.onclick = () => { try { window.focus() } catch { /* ignore */ } ; n.close() }
    lastNotif = n
  } catch { /* ignore */ }
}
