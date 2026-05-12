/**
 * Preprocess bundle:
 * - time alignment
 * - normalization
 * - derived metrics
 */

export function preprocessBundle(raw, { lat, lon, date }) {
  const hours = buildNightHours(date);

  return hours.map((time, idx) => {
    const satHour = raw.satellite.hours[idx];
    const gfsHour = raw.gfs.hours[idx];
    const iconHour = raw.icon.hours[idx];
    const astroHour = raw.astronomy.hours[idx];

    const dewSpread = gfsHour.temp - gfsHour.dewPoint;
    const fogRisk =
      dewSpread < 2 && gfsHour.humidity > 95 ? 0.8 : 0.1;

    return {
      time,
      cloud: {
        sat: satHour.cloudPercent,
        gfs: gfsHour.cloud,
        icon: iconHour.cloud
      },
      humidity: {
        gfs: gfsHour.humidity,
        icon: iconHour.humidity
      },
      dewSpread,
      wind: {
        surface: gfsHour.windSpeed,
        upper: iconHour.windSpeed
      },
      fogRisk,
      cloudMotion: raw.satellite.motionVector,
      astronomy: {
        moonPhase: astroHour.moonPhase,
        moonAltitude: astroHour.moonAltitude,
        sunAltitude: astroHour.sunAltitude
      },
      confidence: 0.7 // base, adjusted later
    };
  });
}

function buildNightHours(date) {
  const d = new Date(date);
  d.setHours(17, 0, 0, 0);
  const hours = [];
  for (let i = 0; i <= 14; i++) {
    const h = new Date(d.getTime() + i * 60 * 60 * 1000);
    hours.push(h.toISOString());
  }
  return hours;
}