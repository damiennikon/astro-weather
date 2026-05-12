/**
 * Astro metrics layer.
 */

export function buildAstroMetrics(hours, { bortle }) {
  return hours.map((h) => {
    const cloudScore = cloudToScore(h.correctedCloud);
    const transparencyScore = h.correctedTransparency;
    const dewScore = dewToScore(h.fusedDewSpread);
    const seeingScore = seeingToScore(h.wind.surface, h.wind.upper);
    const moonPenalty = moonPenaltyScore(
      h.astronomy.moonPhase,
      h.astronomy.moonAltitude,
      bortle
    );

    const astroScore = computeAstroScore({
      cloudScore,
      transparencyScore,
      dewScore,
      seeingScore,
      moonPenalty
    });

    return {
      ...h,
      cloudScore,
      transparencyScore,
      dewScore,
      seeingScore,
      moonPenalty,
      astroScore
    };
  });
}

function cloudToScore(cloudPercent) {
  const score = 10 - cloudPercent / 10;
  return clamp(score, 0, 10);
}

function dewToScore(dewSpread) {
  if (dewSpread >= 5) return 9;
  if (dewSpread >= 3) return 7;
  if (dewSpread >= 1) return 5;
  if (dewSpread >= 0) return 3;
  return 1;
}

function seeingToScore(surfaceWind, upperWind) {
  const shear = Math.abs(upperWind - surfaceWind);
  let score = 8 - shear / 2;
  return clamp(score, 0, 10);
}

function moonPenaltyScore(phase, altitude, bortle) {
  if (altitude < 0) return 0;
  const brightness = phase;
  const bortleFactor = (9 - bortle) / 8;
  let penalty = brightness * bortleFactor * 10;
  return clamp(penalty, 0, 10);
}

function computeAstroScore({
  cloudScore,
  transparencyScore,
  dewScore,
  seeingScore,
  moonPenalty
}) {
  const base =
    cloudScore * 0.5 +
    transparencyScore * 0.2 +
    dewScore * 0.15 +
    seeingScore * 0.1;

  const penalty = moonPenalty * 0.05;
  return clamp(base - penalty, 0, 10);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}