// src/scoring.js  — shared between browser worker and CF scheduler

export function scoreHour({ cloud, moonIllum, moonAlt, humidity, temp, dewpoint, windspeed }) {
  if (cloud === null || cloud === undefined) return { score: 0, verdict: 'unavailable' }
  if (cloud > 70) return { score: 20, verdict: 'verypoor', vetoed: 'cloud>70' }
  if (cloud > 50) return { score: 35, verdict: 'poor', vetoed: 'cloud>50' }

  const moonAboveHorizon = moonAlt > 0
  if (moonIllum > 0.8 && moonAboveHorizon) {
    return { score: 24, verdict: 'verypoor', vetoed: 'brightmoon' }
  }

  // Cloud (35%)
  let cloudScore
  if (cloud <= 5) cloudScore = 100
  else if (cloud <= 15) cloudScore = 85
  else if (cloud <= 30) cloudScore = 60
  else if (cloud <= 50) cloudScore = 30
  else cloudScore = 0

  // Moon (30%)
  let moonScore
  if (!moonAboveHorizon) {
    moonScore = 100
  } else {
    const illumPct = moonIllum * 100
    if (illumPct <= 10) moonScore = 100
    else if (illumPct <= 25) moonScore = 80
    else if (illumPct <= 50) moonScore = 55
    else if (illumPct <= 80) moonScore = 25
    else moonScore = 0
    // Low horizon buffer: moon 0–10° altitude → halve penalty
    if (moonAlt >= 0 && moonAlt <= 10) {
      moonScore = Math.min(100, moonScore + (100 - moonScore) * 0.5)
    }
  }

  // Humidity (15%)
  let humidScore
  if (humidity < 50) humidScore = 100
  else if (humidity < 65) humidScore = 75
  else if (humidity < 75) humidScore = 50
  else if (humidity < 85) humidScore = 25
  else humidScore = 10

  // Dew spread (10%)
  const dewSpread = temp - dewpoint
  let dewScore
  if (dewSpread > 8) dewScore = 100
  else if (dewSpread > 5) dewScore = 70
  else if (dewSpread > 3) dewScore = 40
  else if (dewSpread > 1) dewScore = 20
  else dewScore = 10

  // Wind (10%)
  let windScore
  if (windspeed <= 10) windScore = 100
  else if (windspeed <= 20) windScore = 75
  else if (windspeed <= 30) windScore = 40
  else if (windspeed <= 35) windScore = 20
  else windScore = 10

  const score = Math.round(
    cloudScore * 0.35 + moonScore * 0.3 + humidScore * 0.15 + dewScore * 0.1 + windScore * 0.1
  )

  let verdict
  if (score >= 85) verdict = 'great'
  else if (score >= 65) verdict = 'good'
  else if (score >= 45) verdict = 'fair'
  else if (score >= 25) verdict = 'poor'
  else verdict = 'verypoor'

  return { score, verdict, cloudScore, moonScore, humidScore, dewScore, windScore }
}

export function findOptimalWindow(scoredHours) {
  for (const blockSize of [3, 2, 1]) {
    let best = null
    for (let i = 0; i <= scoredHours.length - blockSize; i++) {
      const block = scoredHours.slice(i, i + blockSize)
      const avg = block.reduce((s, h) => s + h.score, 0) / blockSize
      if (!best || avg > best.avg) {
        best = { startHour: block[0].time, endHour: block[block.length - 1].time, avg, blockSize }
      }
    }
    if (best) return best
  }
  return null
}
