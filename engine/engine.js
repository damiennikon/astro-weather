import { runIngestion } from "./ingestion.js";
import { fuseData } from "./fusion.js";
import { updateUI } from "../ui/update.js";

export async function runEngine() {
  const ingestion = await runIngestion();
  const fused = fuseData(ingestion);
  updateUI(fused);
}