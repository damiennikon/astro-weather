// engine/ingestion.js
import { getCloudCoverForLocation } from "../ingestion/satellite.js";

export async function runIngestion() {
  const results = {
    satellite: null,
    models: null,
    astronomy: null
  };

  try {
    // Satellite cloud ingestion
    const sat = await getCloudCoverForLocation();
    results.satellite = {
      cloudPercent: sat.cloudPercent,
      timestamp: sat.timestamp,
      confidence: sat.confidence
    };
  } catch (err) {
    console.error("Satellite ingestion failed:", err);
    results.satellite = { cloudPercent: null, confidence: 0 };
  }

  // Model ingestion (placeholder for now)
  results.models = {
    gfs: null,
    icon: null
  };

  // Astronomy ingestion (placeholder)
  results.astronomy = null;

  return results;
}