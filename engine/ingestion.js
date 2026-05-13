// engine/ingestion.js
import { getCloudCoverForLocation } from "../ingestion/satellite.js";
import { getGFS } from "../ingestion/gfs.js";
import { getICON } from "../ingestion/icon.js";

export async function runIngestion() {
  const results = {
    satellite: null,
    gfs: null,
    icon: null
  };

  try {
    results.satellite = await getCloudCoverForLocation();
  } catch (e) {
    console.warn("Satellite failed", e);
  }

  try {
    results.gfs = await getGFS(-27.6830, 153.1894);
  } catch (e) {
    console.warn("GFS failed", e);
  }

  try {
    results.icon = await getICON(-27.6830, 153.1894);
  } catch (e) {
    console.warn("ICON failed", e);
  }

  return results;
}