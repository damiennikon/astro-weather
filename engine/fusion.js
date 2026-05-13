// engine/fusion.js
export function fuseData(ingestion) {
  const { satellite } = ingestion;

  // Basic v1 fusion: satellite-only
  const cloud = satellite?.cloudPercent ?? 100;

  // Simple scoring: clear sky = high score
  const nightScore = Math.max(0, 100 - cloud);

  return {
    nightScore,
    cloudPercent: cloud,
    confidence: satellite?.confidence ?? 0
  };
}