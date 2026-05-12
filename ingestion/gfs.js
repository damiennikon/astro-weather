/**
 * Placeholder GFS ingestion.
 * Replace with real GFS API/GRIB decoding later.
 */
export async function ingestGFS({ lat, lon, date }) {
  const hours = buildNightHours(date);

  return {
    hours: hours.map((time, idx) => {
      const baseCloud = 50 + Math.sin(idx / 3) * 20;
      const humidity = 70 + Math.cos(idx / 4) * 15;
      const temp = 15 - idx * 0.5;
      const dewPoint = temp - (3 + Math.sin(idx / 2));

      return {
        time,
        cloud: clamp(baseCloud + noise(10), 0, 100),
        humidity: clamp(humidity + noise(5), 0, 100),
        temp,
        dewPoint,
        windSpeed: 3 + Math.abs(Math.sin(idx / 2) * 4),
        windDir: 180 + idx * 5
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