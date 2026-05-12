import { ingestAll } from "../ingestion/ingest-all.js";
import { preprocessBundle } from "../preprocessing/preprocess.js";
import { fuseModels } from "../fusion/fuse.js";
import { applySatelliteOverride } from "../override/override.js";
import { buildAstroMetrics } from "../metrics/metrics.js";

/**
 * Build forecast for a single night (5pm–7am local).
 */
export async function buildNightForecast({ lat, lon, bortle, date = new Date() }) {
  // 1. Ingest raw data
  const raw = await ingestAll({ lat, lon, date });

  // 2. Preprocess (time align, normalize, derive metrics)
  const preprocessedHours = preprocessBundle(raw, { lat, lon, date });

  // 3. Fuse models
  const fusedHours = fuseModels(preprocessedHours);

  // 4. Satellite override
  const overriddenHours = applySatelliteOverride(fusedHours);

  // 5. Astro metrics
  const astroHours = buildAstroMetrics(overriddenHours, { bortle });

  // 6. Night-level summary
  const nightSummary = summarizeNight(astroHours);

  return {
    date: date.toISOString(),
    ...nightSummary,
    hours: astroHours
  };
}

/**
 * Build multi-night forecast (e.g., 7 nights).
 */
export async function buildMultiNightForecast({ lat, lon, bortle, nights = 7 }) {
  const results = [];
  const base = new Date();

  for (let i = 0; i < nights; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const night = await buildNightForecast({ lat, lon, bortle, date: d });
    results.push(night);
  }

  return results;
}

function summarizeNight(hours) {
  if (!hours || hours.length === 0) {
    return {
      nightAstroScore: 0,
      avgCloud: 0,
      avgTransparency: 0,
      avgDew: 0,
      avgSeeing: 0,
      moonPhase: 0,
      moonAlt: 0,
      moonPenalty: 0,
      bestWindow: "--",
      trend: "—",
      confidence: 0,
      summary: "No data.",
      summaryTag: "No data"
    };
  }

  const scores = hours.map((h) => h.astroScore);
  const clouds = hours.map((h) => h.correctedCloud);
  const trans = hours.map((h) => h.transparencyScore);
  const dew = hours.map((h) => h.dewScore);
  const seeing = hours.map((h) => h.seeingScore);
  const conf = hours.map((h) => h.confidence);

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const bestHour = hours.reduce((best, h) =>
    h.astroScore > best.astroScore ? h : best
  );
  const worstHour = hours.reduce((worst, h) =>
    h.astroScore < worst.astroScore ? h : worst
  );

  const nightAstroScore = avg(scores);
  const avgCloud = avg(clouds);
  const avgTransparency = avg(trans);
  const avgDew = avg(dew);
  const avgSeeing = avg(seeing);
  const confidence = avg(conf);

  const first = hours[0];
  const moonPhase = first.astronomy.moonPhase;
  const moonAlt = first.astronomy.moonAltitude;
  const moonPenalty = first.moonPenalty;

  const trend =
    bestHour.time > worstHour.time ? "improving" : "worsening";

  const summaryTag =
    nightAstroScore >= 8
      ? "Excellent"
      : nightAstroScore >= 6
      ? "Good"
      : nightAstroScore >= 4
      ? "Mixed"
      : "Poor";

  const summary = buildNightSummary({
    nightAstroScore,
    bestHour,
    worstHour,
    avgCloud,
    avgTransparency
  });

  const bestWindow = `${toLocalHM(bestHour.time)}–${toLocalHM(
    new Date(new Date(bestHour.time).getTime() + 2 * 60 * 60 * 1000)
  )}`;

  return {
    nightAstroScore,
    avgCloud,
    avgTransparency,
    avgDew,
    avgSeeing,
    moonPhase,
    moonAlt,
    moonPenalty,
    bestWindow,
    trend,
    confidence,
    summary,
    summaryTag
  };
}

function toLocalHM(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function buildNightSummary({ nightAstroScore, bestHour, avgCloud, avgTransparency }) {
  if (nightAstroScore >= 8) {
    return `Excellent night for astrophotography. Best around ${toLocalHM(
      bestHour.time
    )}. Cloud ${Math.round(avgCloud)}%, transparency ${avgTransparency.toFixed(
      1
    )}/10.`;
  }
  if (nightAstroScore >= 6) {
    return `Good night overall. Some cloud, but useful windows near ${toLocalHM(
      bestHour.time
    )}.`;
  }
  if (nightAstroScore >= 4) {
    return `Mixed conditions. Check hourly detail for short clear gaps.`;
  }
  return `Poor conditions for deep-sky work. Consider visual observing or planning instead.`;
}