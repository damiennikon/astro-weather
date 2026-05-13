import { runIngestion } from "./ingestion.js";
import { fuseData } from "./fusion.js";

export async function runEngine() {
  const ingestion = await runIngestion();
  const fused = fuseData(ingestion);
  return fused;   // ⭐ THIS WAS MISSING
}