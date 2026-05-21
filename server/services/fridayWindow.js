// Single source of truth for "which Friday does this instant belong to?".
//
// An inhouse pool's Friday is a configurable window in Europe/Riga (league)
// time, anchored on Friday: it starts on Friday at `start_hour` and ends on
// Saturday at `end_hour`, i.e. the half-open interval
//
//     [ Friday start_hour:00 , Saturday end_hour:00 )   (Riga local time)
//
// Defaults 0/0 ⇒ Fri 00:00 → Sat 00:00, the plain calendar Friday. The window
// may be shorter or longer than 24h (e.g. 17→04 is 11h; 0→23 is 47h). The same
// window drives the Friday game mode, the per-match Friday win bonus, the
// top-3 daily bonus, and the Friday-top leaderboard tab, so they never
// disagree across a midnight boundary.

const TZ = 'Europe/Riga'

export function clampHour(h) {
  const n = Math.trunc(Number(h))
  if (!Number.isFinite(n)) return 0
  return Math.min(23, Math.max(0, n))
}

// Riga-local { date: 'YYYY-MM-DD', dow: 0..6 (Sun..Sat), hour: 0..23 } for an
// absolute instant (JS Date / parseable value).
export function rigaParts(d) {
  const date = d instanceof Date ? d : new Date(d)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date)
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)
  let hour = parseInt(p.hour, 10)
  if (hour === 24) hour = 0 // some ICU builds emit '24' at midnight
  return { date: `${p.year}-${p.month}-${p.day}`, dow, hour }
}

// Shift a 'YYYY-MM-DD' string by n days. Uses UTC noon so DST never rolls the
// calendar date over.
export function addDays(dateStr, n) {
  const dt = new Date(dateStr + 'T12:00:00Z')
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.toISOString().slice(0, 10)
}

// The Friday (YYYY-MM-DD, Riga) whose window contains `d`, or null if `d`
// falls outside every Friday window.
export function fridayWindowDate(d, startHour = 0, endHour = 0) {
  const sh = clampHour(startHour)
  const eh = clampHour(endHour)
  const { date, dow, hour } = rigaParts(d)
  if (dow === 5 && hour >= sh) return date              // Friday portion
  if (dow === 6 && hour < eh) return addDays(date, -1)  // Saturday spillover
  return null
}

export function isInFridayWindow(d, startHour = 0, endHour = 0) {
  return fridayWindowDate(d, startHour, endHour) !== null
}

// Has the window for `fridayDate` fully elapsed as of `now`? The window closes
// on Saturday (fridayDate + 1) at end_hour Riga. Pure Riga-parts comparison —
// no instant construction, so DST-safe.
export function fridayWindowClosed(fridayDate, endHour = 0, now = new Date()) {
  const eh = clampHour(endHour)
  const sat = addDays(fridayDate, 1)
  const { date, hour } = rigaParts(now)
  if (date > sat) return true
  if (date < sat) return false
  return hour >= eh
}

// SQL CASE mapping a row's timestamp to its Friday window date (Riga), or NULL
// if outside the window. `tsExpr` is the column expression (a TIMESTAMP stored
// as a UTC instant). start/end hours are clamped to integers and inlined as
// literals (safe — never user text).
export function fridayWindowSql(tsExpr, startHour, endHour) {
  const sh = clampHour(startHour)
  const eh = clampHour(endHour)
  const r = `(${tsExpr} AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Riga')`
  return `CASE
    WHEN EXTRACT(DOW FROM ${r}) = 5 AND EXTRACT(HOUR FROM ${r}) >= ${sh} THEN ${r}::date
    WHEN EXTRACT(DOW FROM ${r}) = 6 AND EXTRACT(HOUR FROM ${r}) <  ${eh} THEN (${r}::date - INTERVAL '1 day')::date
    ELSE NULL END`
}
