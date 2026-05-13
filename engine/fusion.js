// engine/fusion.js
export function fuseData(ing) {
  const sat = ing.satellite;
  const gfs = ing.gfs;
  const icon = ing.icon;

  const cloud = weighted([
    [sat?.cloudPercent, 0.6],
    [gfs?.cloud, 0.2],
    [icon?.cloud, 0.2]
  ]);

  const temp = weighted([
    [gfs?.temp, 0.5],
    [icon?.temp, 0.5]
  ]);

  const dew = weighted([
    [gfs?.dew, 0.5],
    [icon?.dew, 0.5]
  ]);

  const humidity = weighted([
    [gfs?.humidity, 0.5],
    [icon?.humidity, 0.5]
  ]);

  const transparency = 10 - cloud / 10;
  const seeing = 10 - (humidity / 10 + cloud / 20);

  return {
    cloud,
    temp,
    dew,
    humidity,
    transparency,
    seeing,
    confidence: 0.9
  };
}

function weighted(values) {
  let sum = 0;
  let wsum = 0;
  for (const [v, w] of values) {
    if (v != null) {
      sum += v * w;
      wsum += w;
    }
  }
  return wsum > 0 ? sum / wsum : null;
}