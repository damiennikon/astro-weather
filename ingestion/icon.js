// ingestion/icon.js
// ICON-Global JSON ingestion via Open-Meteo

export async function getICON(lat, lon) {
  const url = `https://api.open-meteo.com/v1/icon?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,dewpoint_2m,relative_humidity_2m,cloudcover,windspeed_10m&forecast_days=1`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("ICON JSON fetch failed");

  const data = await res.json();

  return {
    temp: data.hourly.temperature_2m[0],
    dew: data.hourly.dewpoint_2m[0],
    humidity: data.hourly.relative_humidity_2m[0],
    cloud: data.hourly.cloudcover[0],
    wind: data.hourly.windspeed_10m[0],
    confidence: 0.85
  };
}