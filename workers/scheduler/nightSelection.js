// Night selection for the scheduled push worker. Kept free of the web-push and
// Cloudflare bindings so it can be exercised directly.

import { zonedParts, formatYmd, addDays } from '../../src/timezone.js'

const NOTIFY_THRESHOLD = 65

// Nights come from the shared pipeline, so each one is a single continuous
// astronomical-dark window (sunset-side dusk through dawn, spanning the date
// boundary) scored with the real moon — not a fixed 20:00-05:00 slice of one
// calendar date, which spliced the tail of one night onto the head of the next.
export function findGoodNight(nights, now, timezone) {
  for (const night of nights) {
    // Skip a night that has already ended, and any night with no usable data.
    if (!night.astroEnd || night.astroEnd <= now) continue
    if (night.nightAvg.score === null) continue
    if (night.nightAvg.score < NOTIFY_THRESHOLD) continue

    const score = Math.round(night.nightAvg.score)
    return {
      date: night.date,
      label: labelForNight(night, now, timezone),
      dateLabel: formatDateLabel(night.date, timezone),
      score,
      cloud: Math.round(night.nightAvg.cloud ?? 0),
      moon: Math.round((night.nightAvg.moonIllum ?? 0) * 100),
      verdict: score >= 85 ? 'GREAT' : 'GOOD',
    }
  }
  return null
}

// Labels are derived from the night's own civil date at the site, compared with the
// site's current civil date — not from a loop index over UTC dates, which made every
// notification read one day late.
function labelForNight(night, now, timezone) {
  if (night.astroStart && night.astroStart <= now) return 'Tonight'

  const today = zonedParts(now, timezone)
  for (let offset = 0; offset <= 2; offset++) {
    if (formatYmd(addDays(today, offset)) === night.date) {
      return offset === 0 ? 'Tonight' : offset === 1 ? 'Tomorrow night' : `In ${offset} nights`
    }
  }
  return 'An upcoming night'
}

function formatDateLabel(isoDate, timeZone) {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}
