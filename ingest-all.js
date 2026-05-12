import { ingestSatellite } from "./satellite.js";
import { ingestGFS } from "./gfs.js";
import { ingestICON } from "./icon.js";
import { computeAstronomy } from "./astronomy.js";

/**
 * High-level ingestion wrapper.
 * NOTE: endpoints are placeholders; you’ll wire real ones later.
 */
export async function ingestAll({ lat, lon, date }) {
  const [satellite, gfs, icon, astronomy] = await Promise.all([
    ingestSatellite({ lat, lon, date }),
    ingestGFS({ lat, lon, date }),
    ingestICON({ lat, lon, date }),
    computeAstronomy({ lat, lon, date })
  ]);

  return {
    satellite,
    gfs,
    icon,
    astronomy
  };
}