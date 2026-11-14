import { formatTimeInZone, safeTimeZone, zonedDateString, zonedParts, zonedToUtc } from './timezone.js'

const HOUR_MS = 3_600_000

export function hasUpcomingCloudData(nights, now) {
  return nights?.some((night) => night?.hours.some(
    ({ time, cloud }) => cloud != null && +time + HOUR_MS > +now,
  ))
}

export function isActiveNight(night, now) {
  return night.displayStart <= now && now < night.displayEnd
}

export function defaultNightIndex(nights, now, timeZone) {
  const active = nights.findIndex((night) => isActiveNight(night, now))
  if (active !== -1) return active
  const day = zonedDateString(now, safeTimeZone(timeZone))
  const upcoming = nights.findIndex((night) => night.date >= day)
  return Math.max(0, upcoming)
}

export function skyReading(night, now) {
  if (isActiveNight(night, now)) {
    const hour = night.hours.find(({ time }) => time <= now && now.getTime() < +time + HOUR_MS)
    return { cloud: hour?.cloud ?? null, hour: hour?.time ?? null }
  }
  // The forecast window, not its calendar label, decides whether this is an
  // upcoming night. Once it starts, only its matching hourly reading is used.
  const upcoming = now < night.displayStart && night.wholeNightSummaryAvailable !== false
  return { cloud: upcoming ? night.nightAvg?.cloud ?? null : null, hour: null }
}

export function formatDashboardHour(night, time, timeZone) {
  const tz = safeTimeZone(timeZone)
  const label = formatTimeInZone(time, tz)
  const repeated = night.hours?.some((hour) => +hour.time !== +time && formatTimeInZone(hour.time, tz) === label)
  if (!repeated) return label
  const formatter = new Intl.DateTimeFormat('en-AU', { timeZone: tz, timeZoneName: 'short' })
  const zone = formatter.formatToParts(time).find(({ type }) => type === 'timeZoneName')?.value
  return zone ? `${label} ${zone}` : label
}

export function nextDashboardBoundary(nights, now, timeZone) {
  const tz = safeTimeZone(timeZone)
  const { year, month, day } = zonedParts(now, tz)
  const midnight = +zonedToUtc(year, month, day + 1, 0, 0, tz)
  const times = nights.flatMap((night) => [
    +night.displayStart, +night.displayEnd,
    ...(night.hours ?? []).flatMap(({ time }) => [+time, +time + HOUR_MS]),
  ])
  return Math.min(midnight, ...times.filter((time) => time > now))
}

export function bestWindowSegments(night) {
  if (!night.optimalWindow || night.wholeNightSummaryAvailable === false) return []
  const { startHour, endHour } = night.optimalWindow
  const duration = night.displayEnd - night.displayStart
  if (!(duration > 0)) return []

  // Each highlight corresponds to an actual scored sample. Gaps stay empty.
  return night.hours
    .filter(({ time, score }) => score != null && time >= startHour && time <= endHour)
    .map(({ time }) => ({
      left: (time - night.displayStart) / duration * 100,
      width: Math.min(HOUR_MS, night.displayEnd - time) / duration * 100,
    }))
}
