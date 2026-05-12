/**
 * Placeholder ICON ingestion.
 * Replace with real ICON data later.
 */
export async function ingestICON({ lat, lon, date }) {
  const hours = buildNightHours(date);

  return {
    hours: hours.map((time, idx) => {
      const baseCloud = 55 + Math.cos(idx / 2.5) * 25;
      const humidity = 65 + Math.sin(idx / 3.5) * 20;

      return {
        time,
        cloud: clamp(baseCloud + noise(8), 0, 100),
        humidity: clamp(humidity + noise(5), 0, 100),
        windSpeed: 2 + Math.abs(Math.cos(idx / 2) * 3),
        windDir: 200 + idx * 3
      };
    })
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

function noise(range) {
  return (Math.random() - 0.5) * 2 * range;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}