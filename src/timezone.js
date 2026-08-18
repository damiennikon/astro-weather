// Calendar arithmetic for the *observing location's* timezone.
//
// Every forecast timestamp in this app is an absolute instant (a Date, or an epoch
// second from Open-Meteo's timeformat=unixtime). Every *calendar* decision — which
// day a night belongs to, when 17:00 local is, when the site's midnight falls — has
// to be resolved in the location's zone. Reading those off the browser clock via
// Date.prototype.getHours() silently shifts the whole forecast by the offset between
// the viewer and the site (2h Brisbane->Perth, 1h Sydney->Brisbane under DST).

const FORMATTERS = new Map()

function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23', // plain hour12:false can yield '24' for midnight on some ICU builds
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    FORMATTERS.set(timeZone, formatter)
  }
  return formatter
}

// An unknown/misspelled IANA id makes Intl throw. Falling back to UTC would put an
// Australian site 8-11 hours out, so fall back to the runtime's own zone instead —
// that is what the old browser-clock code effectively used, so it can only improve.
export function safeTimeZone(timeZone) {
  if (timeZone) {
    try {
      formatterFor(timeZone)
      return timeZone
    } catch {
      /* fall through */
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
}

// Wall-clock fields at `date` as seen in `timeZone`.
export function zonedParts(date, timeZone) {
  const parts = {}
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value)
  }
  return parts
}

// Milliseconds to add to UTC to get `timeZone`'s wall clock at that instant.
export function tzOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // Offsets are whole minutes, so drop sub-second precision on both sides rather
  // than letting it leak into the difference.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

// Inverse of zonedParts: the instant at which `timeZone`'s wall clock reads the
// given fields. Out-of-range components normalise like Date.UTC (day 32 -> next
// month, hour 24 -> next day), which is what lets callers write `day + 1` freely.
export function zonedToUtc(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0)
  // Guess with the offset in force at `wall` read as UTC, then re-resolve once so a
  // DST transition sitting between the guess and the answer is picked up.
  const guess = wall - tzOffsetMs(new Date(wall), timeZone)
  return new Date(wall - tzOffsetMs(new Date(guess), timeZone))
}

// 'YYYY-MM-DD' for the civil date at `date` in `timeZone`.
export function zonedDateString(date, timeZone) {
  const p = zonedParts(date, timeZone)
  const pad = (n) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

export function formatYmd({ year, month, day }) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}`
}

// Civil-date arithmetic that normalises month/year rollover.
export function addDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}
