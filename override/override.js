/**
 * Satellite override layer.
 */

export function applySatelliteOverride(hours) {
  return hours.map((h, idx, arr) => {
    let correctedCloud = h.fusedCloud;
    let correctedFogRisk = h.fogRisk;
    let correctedTransparency = computeTransparency(
      correctedCloud,
      h.fusedHumidity,
      correctedFogRisk
    );
    let correctedConfidence = h.confidence;
    let trend = "stable";

    const satCloud = h.cloud.sat;
    const diff = Math.abs(satCloud - h.fusedCloud);

    // Rule 1: now
    if (idx === 0) {
      correctedCloud = satCloud;
    }

    // Rule 2: 0–3h
    if (idx <= 3 && diff > 30) {
      correctedCloud = satCloud * 0.8 + h.fusedCloud * 0.2;
    }

    // Rule 3: trend (simple synthetic)
    const mv = h.cloudMotion;
    if (mv.dx < 0) {
      correctedCloud = correctedCloud + 5;
      trend = "increasing";
    } else if (mv.dx > 0) {
      correctedCloud = correctedCloud - 5;
      trend = "decreasing";
    }

    // Rule 4: fog
    if (h.fogRisk > 0.5) {
      correctedFogRisk = 1.0;
      correctedTransparency *= 0.6;
      correctedCloud += 10;
    }

    correctedCloud = clamp(correctedCloud, 0, 100);

    // Confidence tweaks
    if (diff < 15) correctedConfidence = clamp(h.confidence + 0.15, 0, 1);
    if (diff > 40) correctedConfidence = clamp(h.confidence - 0.2, 0, 1);

    return {
      ...h,
      correctedCloud,
      correctedFogRisk,
      correctedTransparency,
      confidence: correctedConfidence,
      trend
    };
  });
}

function computeTransparency(cloud, humidity, fogRisk) {
  let score = 10;
  score -= cloud / 12;
  score -= (humidity - 50) / 20;
  score -= fogRisk * 3;
  return clamp(score, 0, 10);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}