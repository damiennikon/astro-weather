// ingestion/satellite.js
// Client-side Himawari‑8 Band 13 ingestion for Loganholme (27.6830° S, 153.1894° E)

const HIMAWARI_BASE = "https://himawari8.nict.go.jp/img/D531106"; 
// Band 13 (IR 10.4µm), 550px tiles, 4x4 grid → 2200×2200 composite

// Your location
const USER_LAT = -27.6830;
const USER_LON = 153.1894;

// Convert degrees → radians
const toRad = (d) => (d * Math.PI) / 180;

// Himawari projection constants
const SUB_LON = 140.0; // Himawari's geostationary longitude
const R_EQ = 6378.137; // Earth equatorial radius (km)
const R_POL = 6356.7523; // Earth polar radius (km)
const SAT_HEIGHT = 42164.0; // Satellite height from Earth's center (km)
const H = SAT_HEIGHT - R_EQ;

// Convert lat/lon → Himawari pixel coordinates
function latLonToPixel(lat, lon, size = 2200) {
  const latRad = toRad(lat);
  const lonRad = toRad(lon - SUB_LON);

  const cosLat = Math.cos(latRad);
  const sinLat = Math.sin(latRad);

  const r = R_POL / R_EQ;
  const e2 = 1 - r * r;

  const phi = Math.atan((r * r) * Math.tan(latRad));
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const Sd = Math.sqrt(
    (SAT_HEIGHT * SAT_HEIGHT) -
    (R_EQ * R_EQ) * (cosPhi * cosPhi * Math.cos(lonRad) * Math.cos(lonRad) + sinPhi * sinPhi)
  );

  const Sn = R_EQ / Math.sqrt(1 - e2 * sinLat * sinLat);

  const Sx = SAT_HEIGHT - Sn * cosLat * Math.cos(lonRad);
  const Sy = -Sn * cosLat * Math.sin(lonRad);
  const Sz = Sn * sinLat;

  const x = Math.atan(Sy / Sx);
  const y = Math.asin(Sz / Sd);

  // Normalized projection → pixel coordinates
  const px = ((x / (10.5 * Math.PI / 180)) + 1) * 0.5 * size;
  const py = ((1 - (y / (10.5 * Math.PI / 180))) * 0.5) * size;

  return { px, py };
}

// Convert brightness temperature → cloud probability
function brightnessToCloud(bt) {
  if (bt < 210) return 100; // Very cold → thick cloud
  if (bt < 230) return 80;
  if (bt < 250) return 50;
  if (bt < 270) return 20;
  return 5; // Warm → clear sky
}

// Fetch the latest Himawari tile (4x4 grid → 2200px)
async function fetchLatestComposite() {
  const now = new Date();
  now.setMinutes(Math.floor(now.getMinutes() / 10) * 10); // Himawari updates every 10 min

  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");

  const timestamp = `${yyyy}/${mm}/${dd}/${hh}${min}00`;

  const tileSize = 550;
  const grid = 4;
  const canvas = document.createElement("canvas");
  canvas.width = tileSize * grid;
  canvas.height = tileSize * grid;
  const ctx = canvas.getContext("2d");

  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      const url = `${HIMAWARI_BASE}/${tileSize}/${grid}/${timestamp}_${tx}_${ty}.png`;

      try {
        const img = await loadImage(url);
        ctx.drawImage(img, tx * tileSize, ty * tileSize);
      } catch (e) {
        console.warn("Tile failed:", url);
      }
    }
  }

  return canvas;
}

// Helper to load an image
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// Main function: get cloud % for your location
export async function getCloudCoverForLocation() {
  const composite = await fetchLatestComposite();
  const ctx = composite.getContext("2d");

  const { px, py } = latLonToPixel(USER_LAT, USER_LON, composite.width);

  const pixel = ctx.getImageData(Math.floor(px), Math.floor(py), 1, 1).data;
  const brightness = pixel[0]; // IR brightness temperature approx

  const cloudPercent = brightnessToCloud(brightness);

  return {
    cloudPercent,
    timestamp: new Date(),
    confidence: 0.85 // baseline confidence for satellite-only
  };
}