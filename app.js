// app.js
import { buildNightForecast, buildMultiNightForecast } from "./engine/forecast.js";
import { runEngine } from "./engine/engine.js";   // ⭐ NEW — import the engine

const els = {
  mainScore: document.getElementById("main-score"),
  trendLabel: document.getElementById("trend-label"),
  cloudVal: document.getElementById("cloud-val"),
  transparencyVal: document.getElementById("transparency-val"),
  dewVal: document.getElementById("dew-val"),
  seeingVal: document.getElementById("seeing-val"),
  moonPhaseVal: document.getElementById("moon-phase-val"),
  moonAltVal: document.getElementById("moon-alt-val"),
  moonPenaltyVal: document.getElementById("moon-penalty-val"),
  tonightSummary: document.getElementById("tonight-summary"),
  bestWindow: document.getElementById("best-window"),
  confidenceLabel: document.getElementById("confidence-label"),
  hourlyPanel: document.getElementById("hourly-panel"),
  hourlyList: document.getElementById("hourly-list"),
  toggleHourlyBtn: document.getElementById("toggle-hourly-btn"),
  nightCards: document.getElementById("night-cards"),
  refreshBtn: document.getElementById("refresh-btn"),
  locationLabel: document.getElementById("location-label"),
  bortleBadge: document.getElementById("bortle-badge")
};

let currentLat = -27.47; // Brisbane default
let currentLon = 153.03;
let currentBortle = 4;
let currentNightForecast = null;
let multiNightForecast = null;

function setLoadingState(isLoading) {
  els.refreshBtn.disabled = isLoading;
  els.refreshBtn.textContent = isLoading ? "Updating…" : "Update Forecast";
}

function formatHourLocal(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function renderMainNight(night) {
  els.mainScore.textContent = Math.round(night.nightAstroScore ?? 0);
  els.trendLabel.textContent = night.trend || "—";

  els.cloudVal.textContent = `${Math.round(night.avgCloud ?? 0)}%`;
  els.transparencyVal.textContent = `${night.avgTransparency?.toFixed(1) ?? "--"}/10`;
  els.dewVal.textContent = `${night.avgDew?.toFixed(1) ?? "--"}/10`;
  els.seeingVal.textContent = `${night.avgSeeing?.toFixed(1) ?? "--"}/10`;

  els.moonPhaseVal.textContent = `${Math.round((night.moonPhase ?? 0) * 100)}%`;
  els.moonAltVal.textContent = `${Math.round(night.moonAlt ?? 0)}°`;
  els.moonPenaltyVal.textContent = `${(night.moonPenalty ?? 0).toFixed(1)}/10`;

  els.tonightSummary.textContent = night.summary || "No summary available.";
  els.bestWindow.textContent = `Best window: ${night.bestWindow || "--"}`;
  els.confidenceLabel.textContent = `Confidence: ${Math.round(
    (night.confidence ?? 0) * 100
  )}%`;
}

function renderHourly(hours) {
  els.hourlyList.innerHTML = "";
  hours.forEach((h) => {
    const row = document.createElement("div");
    row.className = "hour-row";

    const time = document.createElement("div");
    time.className = "hour-time";
    time.textContent = formatHourLocal(h.time);

    const metrics = document.createElement("div");
    metrics.className = "hour-metrics";

    const pillCloud = document.createElement("span");
    pillCloud.className = "hour-metric-pill";
    pillCloud.textContent = `Cloud ${Math.round(h.correctedCloud)}%`;

    const pillTrans = document.createElement("span");
    pillTrans.className = "hour-metric-pill";
    pillTrans.textContent = `Transp ${h.transparencyScore.toFixed(1)}/10`;

    const pillDew = document.createElement("span");
    pillDew.className = "hour-metric-pill";
    pillDew.textContent = `Dew ${h.dewScore.toFixed(1)}/10`;

    const pillSeeing = document.createElement("span");
    pillSeeing.className = "hour-metric-pill";
    pillSeeing.textContent = `Seeing ${h.seeingScore.toFixed(1)}/10`;

    const pillConf = document.createElement("span");
    pillConf.className = "hour-metric-pill";
    pillConf.textContent = `Conf ${Math.round(h.confidence * 100)}%`;

    metrics.append(
      pillCloud,
      pillTrans,
      pillDew,
      pillSeeing,
      pillConf
    );

    const score = document.createElement("div");
    score.className = "hour-score";
    score.textContent = h.astroScore.toFixed(1);

    row.append(time, metrics, score);
    els.hourlyList.appendChild(row);
  });
}

function renderNightCards(nights) {
  els.nightCards.innerHTML = "";
  nights.forEach((night, idx) => {
    const card = document.createElement("div");
    card.className = "night-card";
    card.dataset.index = idx.toString();

    const date = document.createElement("div");
    date.className = "night-date";
    date.textContent = formatDateShort(night.date);

    const score = document.createElement("div");
    score.className = "night-score";
    score.textContent = Math.round(night.nightAstroScore ?? 0);

    const tag = document.createElement("div");
    tag.className = "night-tag";
    tag.textContent = night.summaryTag || "—";

    card.append(date, score, tag);
    card.addEventListener("click", () => {
      currentNightForecast = night;
      renderMainNight(night);
      renderHourly(night.hours);
    });

    els.nightCards.appendChild(card);
  });
}

async function refreshForecast() {
  try {
    setLoadingState(true);

    // ⭐ NEW — run the satellite/model engine first
    const engineOutput = await runEngine();
    console.log("Engine output:", engineOutput);

    // Your existing multi-night forecast logic
    const multi = await buildMultiNightForecast({
      lat: currentLat,
      lon: currentLon,
      bortle: currentBortle
    });

    multiNightForecast = multi;
    const tonight = multi[0];

    currentNightForecast = tonight;
    renderMainNight(tonight);
    renderHourly(tonight.hours);
    renderNightCards(multi);
  } catch (err) {
    console.error("Forecast error", err);
    els.tonightSummary.textContent = "Error loading forecast.";
  } finally {
    setLoadingState(false);
  }
}

function initLocation() {
  if (!navigator.geolocation) {
    els.locationLabel.textContent = "Location: Brisbane (default)";
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      currentLat = pos.coords.latitude;
      currentLon = pos.coords.longitude;
      els.locationLabel.textContent = `Location: ${currentLat.toFixed(
        2
      )}, ${currentLon.toFixed(2)}`;
    },
    () => {
      els.locationLabel.textContent = "Location: Brisbane (default)";
    }
  );
}

function initUI() {
  els.toggleHourlyBtn.addEventListener("click", () => {
    const collapsed = els.hourlyPanel.classList.toggle("collapsed");
    els.toggleHourlyBtn.textContent = collapsed ? "Show hourly" : "Hide hourly";
  });

  els.refreshBtn.addEventListener("click", () => {
    refreshForecast();
  });

  els.bortleBadge.textContent = `Bortle: ${currentBortle}`;
}

// ⭐ Boot sequence
document.addEventListener("DOMContentLoaded", () => {
  initLocation();
  initUI();
  refreshForecast();   // your original forecast engine
  runEngine();         // ⭐ NEW — satellite ingestion engine
});