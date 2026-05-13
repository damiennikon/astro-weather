// engine/fusion.js
export function fuseData(ing) {
  const sat = ing.satellite;
  const gfs = ing.gfs;
  const icon = ing.icon;

  // Cloud fusion
  const cloud = weightedAverage([
    [sat?.cloudPercent, 0.6],
    [gfs?.cloud, 0.2],
    [icon?.cloud, 0.2]
  ]);

  // Temperature fusion
  const temp = weightedAverage([
    [gfs?.temp, 0.5],
    [icon?.temp, 0.5]
  ]);

  // Dew point fusion
  const dew = weightedAverage([
    [gfs?.dew, 0.5],
    [icon?.dew, 0.5]
  ]);

  // Transparency (derived)
  const transparency = 10 - cloud / 10;

  // Seeing (placeholder)
  const seeing = 7 - (windToSeeing(gfs?.wind || 5) / 2);

  return {
    cloud,
    temp,
    dew,
    transparency,
    seeing,
    confidence: 0.8
  };
}

function weightedAverage(values) {
  let sum = 0;
  let weight = 0;
  for (const [v, w] of values) {
    if (v != null) {
      sum += v * w;
      weight += w;
    }
  }
  return weight > 0 ? sum / weight : null;
}

function windToSeeing(w) {
  return Math.min(10, Math.max(1, w));
}