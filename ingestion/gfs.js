// ingestion/gfs.js
// Client-side GFS 0.25° ingestion

const GFS_BASE =
  "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl";

export async function getGFS(lat, lon) {
  // Round to nearest 0.25° grid
  const latR = Math.round(lat * 4) / 4;
  const lonR = Math.round(lon * 4) / 4;

  const params = new URLSearchParams({
    file: "gfs.t00z.pgrb2.0p25.f000",
    lev_2_m_above_ground: "on",
    lev_surface: "on",
    var_TMP: "on",
    var_DPT: "on",
    var_RH: "on",
    var_TCDC: "on",
    subregion: "",
    leftlon: lonR,
    rightlon: lonR,
    toplat: latR,
    bottomlat: latR,
    dir: "/gfs.20250101/00" // placeholder — we will auto‑detect cycle next
  });

  const url = `${GFS_BASE}?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("GFS fetch failed");

  const blob = await res.arrayBuffer();
  const data = await parseGRIB(blob);

  return {
    temp: data.TMP,
    dew: data.DPT,
    humidity: data.RH,
    cloud: data.TCDC,
    confidence: 0.7
  };
}

// Placeholder GRIB parser — we will replace with a real one
async function parseGRIB(buffer) {
  return {
    TMP: 20,
    DPT: 15,
    RH: 70,
    TCDC: 40
  };
}