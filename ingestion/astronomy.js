/**
 * Simple local astronomy calculations.
 * These are approximate but good enough for scoring.
 */

export async function computeAstronomy({ lat, lon, date }) {
  const hours = buildNightHours(date);

  const moonPhase = approximateMoonPhase(date);
  const series = hours.map((time) => {
    const t = new Date(time);
    return {
      time,
      moonPhase,
      moonAltitude: approximateMoonAltitude(lat, lon, t),
      sunAltitude: approximateSunAltitude(lat, lon, t)
    };
  });

  return {
    hours: series
  };
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

// Very rough moon phase: 0..1
function approximateMoonPhase(date) {
  const synodicMonth = 29.53058867;
  const knownNewMoon = new Date("2000-01-06T18:14:00Z").getTime();
  const daysSince = (date.getTime() - knownNewMoon) / (1000 * 60 * 60 * 24);
  const phase = (daysSince % synodicMonth) / synodicMonth;
  return (phase + 1) % 1;
}

// Extremely simplified altitude approximations
function approximateSunAltitude(lat, lon, date) {
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60;
  const localHour = (hours + lon / 15 + 24) % 24;
  const dayFraction = localHour / 24;
  const altitude = Math.sin(dayFraction * 2 * Math.PI) * 60 - 10;
  return altitude;
}

function approximateMoonAltitude(lat, lon, date) {
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60;
  const localHour = (hours + lon / 15 + 24) % 24;
  const dayFraction = localHour / 24;
  const altitude = Math.sin((dayFraction + 0.3) * 2 * Math.PI) * 50 - 5;
  return altitude;
}