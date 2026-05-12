/**
 * Placeholder Himawari-8 ingestion.
 * For now, returns synthetic but structured data so the engine runs.
 * You can later replace this with real tile-based ingestion.
 */
export async function ingestSatellite({ lat, lon, date }) {
  const hours = buildNightHours(date);

  const cloudSeries = hours.map((time, idx) => {
    // Simple synthetic pattern: clearer late at night
    const base = 60 - idx * 3;
    return {
      time,
      cloudPercent: clamp(base + noise(10), 0, 100)
    };
  });

  return {
    hours: cloudSeries,
    motionVector: { dx: -2, dy: 1 } // synthetic west-to-east
  };
}

function buildNightHours(date) {
  const d = new Date(date);
  d.setHours(17, 0, 0, 0); // 5pm
  const hours = [];
  for (let i = 0; i <= 14; i++) {
    const h = new Date(d.getTime() + i * 60 * 60 * 1000);
    hours.push(h.toISOString());
  }
  return hours;
}

function noise(range) {
  return (Math.random() - 0.5) * 2 * range;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}