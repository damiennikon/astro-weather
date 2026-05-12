/**
 * Model fusion layer.
 */

export function fuseModels(hours) {
  const now = new Date();

  return hours.map((h) => {
    const t = new Date(h.time);
    const hoursAhead = (t.getTime() - now.getTime()) / (1000 * 60 * 60);

    const weights = getWeights(hoursAhead);

    const fusedCloud =
      h.cloud.sat * weights.sat +
      h.cloud.icon * weights.icon +
      h.cloud.gfs * weights.gfs;

    const fusedHumidity =
      h.humidity.icon * 0.6 + h.humidity.gfs * 0.4;

    const fusedDewSpread = h.dewSpread;
    const fusedWind =
      h.wind.surface * 0.6 + h.wind.upper * 0.4;

    return {
      ...h,
      fusedCloud,
      fusedHumidity,
      fusedDewSpread,
      fusedWind
    };
  });
}

function getWeights(hoursAhead) {
  if (hoursAhead <= 6) {
    return { sat: 0.7, icon: 0.2, gfs: 0.1 };
  }
  if (hoursAhead <= 12) {
    return { sat: 0.4, icon: 0.35, gfs: 0.25 };
  }
  if (hoursAhead <= 48) {
    return { sat: 0.0, icon: 0.6, gfs: 0.4 };
  }
  return { sat: 0.0, icon: 0.3, gfs: 0.7 };
}