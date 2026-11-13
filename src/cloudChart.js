import { formatDashboardHour } from './dashboardForecast.js'
import { safeTimeZone } from './timezone.js'

const formatCloud = (value) => Number.isFinite(value) ? `${Math.round(value)}%` : '—'
const formatTemp = (value) => Number.isFinite(value) ? `${Math.round(value)}°C` : '—'

export function renderCloudChart(container, night, nightIndex, timeZone, onSelect) {
  const { hours, astroStart, astroEnd } = night
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone: safeTimeZone(timeZone), hour: 'numeric', minute: '2-digit', hour12: true,
  })
  const formatTime = (date) => {
    const short = formatter.format(date).replace(':00', '')
    const siteTime = formatDashboardHour(night, date, timeZone)
    const zoneSuffix = siteTime.indexOf(' ')
    return zoneSuffix < 0 ? short : short + siteTime.slice(zoneSuffix)
  }
  const darkness = astroStart && astroEnd ? `${formatTime(astroStart)}–${formatTime(astroEnd)}` : ''
  const hasCloud = hours.some((hour) => Number.isFinite(hour.cloud))

  container.innerHTML = `
    <section class="tonight-chart" aria-labelledby="tonight-hourly-title">
      <header class="tonight-chart-heading">
        <h3 id="tonight-hourly-title">Hourly forecast</h3>
        <span id="tonight-selected-time"></span>
      </header>
      <div class="tonight-readout">
        <div><strong id="tonight-selected-cloud"></strong><span>Cloud cover</span></div>
        <div><strong id="tonight-selected-temp"></strong><span>Temperature</span></div>
      </div>
      ${renderPlot(hours, formatTime, astroStart, astroEnd)}
      <div class="tonight-chart-footer">
        <span class="tonight-dark-key">Astro dark</span>
        <span>${darkness || 'Unavailable'}</span>
      </div>
      ${hasCloud ? '' : '<p class="tonight-chart-note">Hourly cloud forecast unavailable</p>'}
    </section>
    <details class="tonight-details tonight-hourly-values">
      <summary>All hourly values</summary>
      <table class="tonight-hour-table">
        <thead><tr><th scope="col">Local time</th><th scope="col">Cloud</th><th scope="col">Temp.</th></tr></thead>
        <tbody>${hours.map((hour, index) => `
          <tr>
            <th scope="row"><button type="button" class="tonight-hour-button" data-night-index="${nightIndex}" data-hour-index="${index}" aria-label="Forecast details for ${formatTime(hour.time)}">${formatTime(hour.time)}</button></th>
            <td>${formatCloud(hour.cloud)}</td>
            <td>${formatTemp(hour.temp)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </details>`

  const plot = container.querySelector('.tonight-chart-plot')
  const scrubber = plot.querySelector('input')
  const timeLabel = container.querySelector('#tonight-selected-time')
  const cloudLabel = container.querySelector('#tonight-selected-cloud')
  const temperatureLabel = container.querySelector('#tonight-selected-temp')
  const cursor = container.querySelector('.tonight-chart-cursor')
  const dot = container.querySelector('.tonight-chart-dot')

  let selectedIndex

  function selectHour(index, manual = false) {
    if (index === selectedIndex && !manual) return
    selectedIndex = index
    scrubber.value = index
    const hour = hours[index]
    const time = hour ? formatTime(hour.time) : '—'
    const cloud = hour?.cloud
    const temp = hour?.temp
    const hasSelectedCloud = Number.isFinite(cloud)
    timeLabel.textContent = time
    cloudLabel.textContent = formatCloud(cloud)
    temperatureLabel.textContent = formatTemp(temp)
    scrubber.setAttribute('aria-valuetext', `${time}, ${hasSelectedCloud ? `${formatCloud(cloud)} cloud cover` : 'cloud forecast unavailable'}, ${Number.isFinite(temp) ? formatTemp(temp) : 'temperature unavailable'}`)

    const x = `${hourPosition(index, hours.length)}%`
    cursor.style.left = x
    dot.style.left = x
    dot.hidden = !hasSelectedCloud
    if (hasSelectedCloud) dot.style.top = `${100 - cloud}%`

    if (hour) onSelect(index, manual)
  }

  scrubber.addEventListener('input', () => selectHour(Number(scrubber.value), true))

  function scrub(event) {
    const { left, width } = plot.getBoundingClientRect()
    if (!width) return
    const fraction = Math.max(0, Math.min(1, (event.clientX - left) / width))
    const index = Math.round(fraction * (hours.length - 1))
    if (index !== selectedIndex || event.type === 'pointerdown') selectHour(index, true)
  }

  plot.addEventListener('pointerdown', (event) => {
    if (scrubber.disabled || !event.isPrimary || event.button !== 0) return
    plot.setPointerCapture(event.pointerId)
    scrub(event)
  })
  plot.addEventListener('pointermove', (event) => {
    if (plot.hasPointerCapture(event.pointerId)) scrub(event)
  })
  return { selectHour }
}

function hourPosition(index, count) {
  return count > 1 ? 100 * index / (count - 1) : 0
}

function renderPlot(hours, formatTime, astroStart, astroEnd) {
  const first = hours[0]?.time
  const last = hours.at(-1)?.time
  const positionOf = (date) => Math.max(0, Math.min(100, 100 * (date - first) / (last - first)))
  const start = astroStart && last > first ? positionOf(astroStart) : 0
  const end = astroEnd && last > first ? positionOf(astroEnd) : 0
  const ticks = [100, 75, 50, 25, 0]
  const labelCount = Math.min(5, hours.length)
  const labels = Array.from({ length: labelCount }, (_, i) => {
    const index = labelCount > 1 ? Math.round(i * (hours.length - 1) / (labelCount - 1)) : 0
    return `<span style="--time-position: ${hourPosition(index, hours.length)}%">${formatTime(hours[index].time)}</span>`
  })

  let path = ''
  let hasPrevious = false
  const points = []
  hours.forEach(({ cloud }, index) => {
    if (!Number.isFinite(cloud)) {
      hasPrevious = false
      return
    }
    const x = hourPosition(index, hours.length)
    const y = 100 - cloud
    path += `${hasPrevious ? 'L' : 'M'} ${x} ${y} `
    hasPrevious = true
    points.push(`<span class="tonight-chart-point" style="left: ${x}%; top: ${y}%"></span>`)
  })

  return `
    <div class="tonight-chart-grid">
      <div class="tonight-chart-y" aria-hidden="true">${ticks.map((tick) => `<span>${tick === 100 ? '100%' : tick}</span>`).join('')}</div>
      <div class="tonight-chart-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <rect class="tonight-chart-dark" x="${start}" width="${Math.max(0, end - start)}" y="0" height="100" />
          ${ticks.map((tick) => `<line class="tonight-chart-gridline" x1="0" x2="100" y1="${100 - tick}" y2="${100 - tick}" vector-effect="non-scaling-stroke" />`).join('')}
          <path class="tonight-chart-line" d="${path}" vector-effect="non-scaling-stroke" />
        </svg>
        ${points.join('')}
        <span class="tonight-chart-cursor" aria-hidden="true"></span>
        <span class="tonight-chart-dot" aria-hidden="true" hidden></span>
        <input type="range" min="0" max="${Math.max(0, hours.length - 1)}" value="0" step="1" aria-label="Select forecast hour" ${hours.length < 2 ? 'disabled' : ''}>
      </div>
      <div class="tonight-chart-x" aria-hidden="true">${labels.join('')}</div>
    </div>`
}
