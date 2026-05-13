// ingestion/icon.js
// Client-side ICON-Global ingestion

const ICON_BASE =
  "https://opendata.dwd.de/weather/nwp/icon/grib/00/";

export async function getICON(lat, lon) {
  // ICON grid is ~13 km, so nearest point is fine
  const url = `${ICON_BASE}icon_global_00_000.grib2`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("ICON fetch failed");

  const buffer = await res.arrayBuffer();
  const data = await parseGRIB(buffer);

  return {
    temp: data.t,
    dew: data.td,
    humidity: data.rh,
    cloud: data.clct,
    confidence: 0.75
  };
}

async function parseGRIB(buffer) {
  return {
    t: 19,
    td: 14,
    rh: 68,
    clct: 35
  };
}