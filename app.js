// app.js

const LOGANHOLME_LAT = -27.6833;
const LOGANHOLME_LON = 153.1833;

let currentLat = LOGANHOLME_LAT;
let currentLon = LOGANHOLME_LON;

let weatherWorker;

function debounce(func, delay) {
    let timeoutId;
    return function (...args) {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

document.addEventListener('DOMContentLoaded', () => {
    initServiceWorker();
    initWeatherWorker();
    initLocationUI();
    initConfidenceModal();
    initSatelliteModal();
});

function initConfidenceModal() {
    const modalHtml = `
        <div id="conf-modal" class="conf-modal-overlay" onclick="closeConfidenceModal(event)">
            <div class="conf-modal-content" onclick="event.stopPropagation()">
                <h3 id="conf-modal-title">Model Confidence</h3>
                <p id="conf-modal-desc"></p>
                <table class="conf-table">
                    <thead>
                        <tr>
                            <th>Model</th>
                            <th>Low</th>
                            <th>Mid</th>
                            <th>High</th>
                        </tr>
                    </thead>
                    <tbody id="conf-modal-tbody">
                    </tbody>
                </table>
                <button class="conf-modal-close-btn" onclick="closeConfidenceModal(null, true)">Close</button>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

window.openConfidenceModal = function(index) {
    const item = window.currentForecastData[index];
    if (!item) return;

    let explanation = "Confidence data is currently unavailable.";
    if (item.modelAgreement === 'Models Agree') {
        explanation = "High Confidence: ICON, GFS, and ECMWF models are forecasting nearly identical conditions. This forecast is highly reliable.";
    } else if (item.modelAgreement === 'Models Mixed') {
        explanation = "Medium Confidence: The models show slight disagreement. Actual conditions may vary slightly from this forecast.";
    } else if (item.modelAgreement === 'Models Disagree') {
        explanation = "Low Confidence: The models are predicting significantly different conditions. The forecast is highly unstable and could change rapidly.";
    }

    document.getElementById('conf-modal-desc').innerText = explanation;

    let tbody = '';
    const m = item.rawModels || {};
    const icon = m.icon || { low: 'N/A', mid: 'N/A', high: 'N/A' };
    const gfs = m.gfs || { low: 'N/A', mid: 'N/A', high: 'N/A' };
    const ecmwf = m.ecmwf || { low: 'N/A', mid: 'N/A', high: 'N/A' };

    const formatVal = (val) => val === 'N/A' || val == null ? 'N/A' : Math.round(val) + '%';

    tbody += `<tr><td>ICON</td><td>${formatVal(icon.low)}</td><td>${formatVal(icon.mid)}</td><td>${formatVal(icon.high)}</td></tr>`;
    tbody += `<tr><td>GFS</td><td>${formatVal(gfs.low)}</td><td>${formatVal(gfs.mid)}</td><td>${formatVal(gfs.high)}</td></tr>`;
    tbody += `<tr><td>ECMWF</td><td>${formatVal(ecmwf.low)}</td><td>${formatVal(ecmwf.mid)}</td><td>${formatVal(ecmwf.high)}</td></tr>`;

    document.getElementById('conf-modal-tbody').innerHTML = tbody;

    document.getElementById('conf-modal').style.display = 'flex';
};

window.closeConfidenceModal = function(event, force = false) {
    if (force || event.target.id === 'conf-modal') {
        document.getElementById('conf-modal').style.display = 'none';
    }
};

function initServiceWorker() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js')
                .then(registration => {
                    console.log('ServiceWorker registered with scope:', registration.scope);
                })
                .catch(err => {
                    console.error('ServiceWorker registration failed:', err);
                });
        });
    } else {
        console.warn('Service workers are not supported in this browser.');
    }
}

function initWeatherWorker(lat = LOGANHOLME_LAT, lon = LOGANHOLME_LON) {
    currentLat = lat;
    currentLon = lon;
    const forecastContainer = document.getElementById('forecast-container');

    if (window.Worker) {
        weatherWorker = new Worker('./weatherWorker.js');

        // Listen for messages from the web worker
        weatherWorker.onmessage = function (event) {
            const response = event.data;
            console.log('Received data from weatherWorker:', response);

            if (response.status === "error") {
                forecastContainer.innerHTML = `<p style="color: red; text-align: center;">Error: ${response.message}</p>`;
                return;
            }

            // Render the forecast data
            if (response.status === "success") {
                renderForecast(response.forecast);
            }
        };

        weatherWorker.onerror = function (error) {
            console.error('Error in weatherWorker:', error);
            forecastContainer.innerHTML = `<p style="color: red; text-align: center;">Failed to process weather data.</p>`;
        };

        // Send a postMessage to the Web Worker with the coordinates upon load
        weatherWorker.postMessage({
            lat: lat,
            lon: lon
        });
    } else {
        forecastContainer.innerHTML = `<p style="color: red; text-align: center;">Web Workers are not supported in your browser. Cannot load forecast.</p>`;
    }
}

function renderForecast(forecastArray) {
    const container = document.getElementById('forecast-container');

    // Empty State
    if (!Array.isArray(forecastArray) || forecastArray.length === 0) {
        container.innerHTML = `
            <div class="day-card empty-state">
                <h2 class="card-header">No Data</h2>
                <div class="empty-message">No forecast data available for the night hours.</div>
            </div>`;
        return;
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
    // Filter to future and TRUE ASTRONOMICAL DARKNESS
    const futureForecast = forecastArray.filter(item => new Date(item.timestamp) >= cutoff && item.isAstroDark);
    window.currentForecastData = futureForecast;

    // Ephemeris Banner Logic
    let ephemerisHtml = '';
    if (futureForecast.length > 0) {
        const firstForecastItem = futureForecast[0];
        const targetDateStr = firstForecastItem.timestamp.split('T')[0];
        const localNoon = new Date(targetDateStr + 'T12:00:00');
        
        let mRise = 'N/A';
        let mSet = 'N/A';
        let gcRise = 'Not Visible';
        let gcSet = 'Not Visible';
        let darkStart = 'N/A';
        let darkEnd = 'N/A';
        let gcEndLabel = 'Sets';

        if (window.Astronomy) {
            const observer = new Astronomy.Observer(currentLat, currentLon, 0);
            
            const formatAstronomyTime = (astroTime) => {
                if (!astroTime || !astroTime.date) return 'N/A';
                return new Date(astroTime.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            };
            
            // Moon Transit
            const moonriseObj = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, +1, localNoon, 1);
            const moonsetObj = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, -1, localNoon, 1);
            
            if (moonriseObj) mRise = formatAstronomyTime(moonriseObj);
            else mRise = "Already up/down";
            
            if (moonsetObj) mSet = formatAstronomyTime(moonsetObj);
            else mSet = "Stays up/down";
            
            if (!moonriseObj && !moonsetObj) {
                const testAlt = Astronomy.Horizon(localNoon, observer, Astronomy.Body.Moon, 'normal').altitude;
                if (testAlt > 0) { mRise = "Up all day"; mSet = "Up all day"; }
                else { mRise = "Below horizon"; mSet = "Below horizon"; }
            }

            // True Darkness (Astronomical Twilight -18 deg)
            const sunDarkStartObj = Astronomy.SearchAltitude(Astronomy.Body.Sun, observer, -1, localNoon, 1, -18);
            const sunDarkEndObj = Astronomy.SearchAltitude(Astronomy.Body.Sun, observer, +1, localNoon, 1, -18);

            if (sunDarkStartObj) darkStart = formatAstronomyTime(sunDarkStartObj);
            else darkStart = "Doesn't get dark";
            
            if (sunDarkEndObj) darkEnd = formatAstronomyTime(sunDarkEndObj);
            else darkEnd = "Doesn't get light";
            
            if (!sunDarkStartObj && !sunDarkEndObj) {
                const testAlt = Astronomy.Horizon(localNoon, observer, Astronomy.Body.Sun, 'normal').altitude;
                if (testAlt < -18) { darkStart = "Dark all night"; darkEnd = "Dark all night"; }
                else { darkStart = "No true darkness"; darkEnd = "No true darkness"; }
            }

            // Galactic Center
            let foundGcRise = null;
            let foundGcSet = null;

            // Search for Rise (Visible) starting from Local Midnight (beginning of current day)
            const localMidnight = new Date(targetDateStr + 'T00:00:00');
            let t1 = new Astronomy.AstroTime(localMidnight);
            let alt1 = Astronomy.Horizon(t1, observer, 17.76, -29.0, 'normal').altitude - 10;
            
            for (let i = 1; i <= 24; i++) {
                let t2 = t1.AddDays(1 / 24);
                let alt2 = Astronomy.Horizon(t2, observer, 17.76, -29.0, 'normal').altitude - 10;
                
                if (alt1 < 0 && alt2 >= 0) {
                    foundGcRise = Astronomy.Search((t) => Astronomy.Horizon(t, observer, 17.76, -29.0, 'normal').altitude - 10, t1, t2);
                    break;
                }
                t1 = t2;
                alt1 = alt2;
            }

            // Search for Set starting from the found Rise time (or Noon if not found)
            let searchStart = foundGcRise ? foundGcRise : new Astronomy.AstroTime(localNoon);
            let tStartSet = searchStart;
            let altStartSet = Astronomy.Horizon(tStartSet, observer, 17.76, -29.0, 'normal').altitude - 10;

            for (let i = 1; i <= 24; i++) {
                let t2 = tStartSet.AddDays(1 / 24);
                let alt2 = Astronomy.Horizon(t2, observer, 17.76, -29.0, 'normal').altitude - 10;
                
                if (altStartSet >= 0 && alt2 < 0) {
                    foundGcSet = Astronomy.Search((t) => Astronomy.Horizon(t, observer, 17.76, -29.0, 'normal').altitude - 10, tStartSet, t2);
                    break;
                }
                tStartSet = t2;
                altStartSet = alt2;
            }

            // Apply Morning Twilight Cap to Milky Way
            if (foundGcSet && sunDarkEndObj) {
                const gcSetDate = new Date(foundGcSet.date);
                const sunEndDate = new Date(sunDarkEndObj.date);
                if (sunEndDate < gcSetDate) {
                    foundGcSet = sunDarkEndObj;
                    gcEndLabel = "Fades";
                }
            }

            if (foundGcRise) gcRise = formatAstronomyTime(foundGcRise);
            if (foundGcSet) gcSet = formatAstronomyTime(foundGcSet);
            
            if (!foundGcRise && !foundGcSet) {
                 const testAlt = Astronomy.Horizon(new Astronomy.AstroTime(localMidnight), observer, 17.76, -29.0, 'normal').altitude;
                 if (testAlt > 10) { gcRise = "Visible All Night"; gcSet = "Visible All Night"; }
            }
        }

        ephemerisHtml = `
            <div class="ephemeris-banner">
                <div class="ephemeris-block">
                    <span class="ephemeris-title">🌑 True Darkness</span>
                    <span class="ephemeris-data">Starts: ${darkStart} | Ends: ${darkEnd}</span>
                </div>
                <div class="ephemeris-block">
                    <span class="ephemeris-title">🌕 Moon Transit</span>
                    <span class="ephemeris-data">Rise: ${mRise} | Set: ${mSet}</span>
                </div>
                <div class="ephemeris-block">
                    <span class="ephemeris-title">🌌 Milky Way Core</span>
                    <span class="ephemeris-data">Visible: ${gcRise} | ${gcEndLabel}: ${gcSet}</span>
                </div>
            </div>
        `;
    }

    // Group by Night Date
    const nights = {};
    futureForecast.forEach(item => {
        let nightDateString = 'Unknown Date';
        if (item.timestamp) {
            const d = new Date(item.timestamp);
            const nightDate = new Date(d.getTime());
            // A "night" spans across midnight. If hour < 12 (noon), shift to previous date's night.
            if (nightDate.getHours() < 12) {
                nightDate.setDate(nightDate.getDate() - 1);
            }
            nightDateString = nightDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        }

        if (!nights[nightDateString]) {
            nights[nightDateString] = [];
        }
        nights[nightDateString].push(item);
    });

    let html = '';
    let modalsHtml = '';

    let nightIndex = 0;

    for (const [nightName, hoursData] of Object.entries(nights)) {
        nightIndex++;
        const modalId = `modal-${nightIndex}`;

        let totalCloud = 0;
        let validCloudCount = 0;
        let worstVerdictScore = 5;
        let validVerdictCount = 0;
        let hasUncertainHour = false;
        let maxMoon = 0;

        let hoursHtml = '';

        hoursData.forEach(item => {
            const index = window.currentForecastData.indexOf(item);
            if (item.isUncertain) hasUncertainHour = true;
            maxMoon = Math.max(maxMoon, item.moonIllumination ?? 0);
            // Using worker payload values
            let vetoReason = item.vetoReason;
            let verdictClass = "verdict-unknown";
            let verdictScore = 0; 

            if (item.verdictTier === "Excellent") {
                verdictClass = "verdict-excellent";
                verdictScore = 4;
            } else if (item.verdictTier === "Good") {
                verdictClass = "verdict-good";
                verdictScore = 3;
            } else if (item.verdictTier === "Marginal") {
                verdictClass = "verdict-marginal";
                verdictScore = 2;
            } else if (item.verdictTier === "Poor") {
                verdictClass = "verdict-poor";
                verdictScore = 1;
            }

            // Accumulators
            const maxCloud = Math.max(item.cloudLow ?? 0, item.cloudMid ?? 0, item.cloudHigh ?? 0);
            totalCloud += maxCloud;
            validCloudCount++;

            if (verdictScore < worstVerdictScore) {
                worstVerdictScore = verdictScore;
            }
            validVerdictCount++;

            let timeString = 'N/A';
            if (item.timestamp) {
                const dateObj = new Date(item.timestamp);
                timeString = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }

            const tempStr = item.temp != null ? `${Math.round(item.temp)}°C` : 'N/A';
            const humStr = item.humidity != null ? `${Math.round(item.humidity)}%` : 'N/A';
            const windStr = item.wind != null ? `${Math.round(item.wind)} km/h` : 'N/A';
            
            // Strictly use nullish coalescing ?? 'N/A' as requested
            const cloudLowStr = (item.cloudLow != null ? `${Math.round(item.cloudLow)}%` : null) ?? 'N/A';
            const cloudMidStr = (item.cloudMid != null ? `${Math.round(item.cloudMid)}%` : null) ?? 'N/A';
            const cloudHighStr = (item.cloudHigh != null ? `${Math.round(item.cloudHigh)}%` : null) ?? 'N/A';
            
            const moonStr = item.moonIllumination != null 
                ? `${Math.round(item.moonIllumination * 100)}% ${item.isMoonAboveHorizon ? '↑' : '↓'}` 
                : 'N/A';

            // Confidence Styling (Not strictly used in new HTML but kept if needed)
            let confColor = '#ffffff';
            if (item.modelAgreement === 'Models Agree') confColor = '#4caf50';
            else if (item.modelAgreement === 'Models Mixed') confColor = '#fbc02d';
            else if (item.modelAgreement === 'Models Disagree') confColor = '#f44336';

            let vetoHtml = vetoReason ? `<div class="veto-text">${vetoReason}</div>` : '';
            let verdictDisplayName = item.verdictTier;
            if (item.isUncertain) {
                verdictDisplayName += ' ⚠';
            }

            hoursHtml += `
                <div class="hour-block">
                    <div class="verdict-badge ${verdictClass}">${verdictDisplayName}</div>
                    ${vetoHtml}
                    <div class="hour-time">${timeString}</div>
                    <div class="hour-metric">
                        <span class="metric-label">🌕 Moon</span>
                        <span class="metric-value">${moonStr}</span>
                    </div>
                    <div class="hour-metric">
                        <span class="metric-label">☁ Low</span>
                        <span class="metric-value">${cloudLowStr}</span>
                    </div>
                    <div class="hour-metric">
                        <span class="metric-label">☁ Mid</span>
                        <span class="metric-value">${cloudMidStr}</span>
                    </div>
                    <div class="hour-metric">
                        <span class="metric-label">☁ High</span>
                        <span class="metric-value">${cloudHighStr}</span>
                    </div>
                    <div class="hour-metric">
                        <span class="metric-label">Temp</span>
                        <span class="metric-value">${tempStr}</span>
                    </div>
                    <div class="hour-metric">
                        <span class="metric-label">Hum</span>
                        <span class="metric-value">${humStr}</span>
                    </div>
                    <div class="hour-metric">
                        <span class="metric-label">Wind</span>
                        <span class="metric-value">${windStr}</span>
                    </div>
                    <div class="hour-metric">AGREEMENT<br>${item.modelAgreement ?? 'N/A'} <span style="cursor:pointer; margin-left:6px; opacity:0.8; font-size:0.9em;" onclick="openConfidenceModal(${index})">ⓘ</span></div>
                </div>
            `;
        });

        const avgCloud = validCloudCount > 0 ? Math.round(totalCloud / validCloudCount) : 'N/A';
        
        let avgTransStr = 'Unknown';
        let summaryClass = '';
        if (validVerdictCount > 0) {
            if (worstVerdictScore === 4) { avgTransStr = "Excellent"; summaryClass = "verdict-excellent"; }
            else if (worstVerdictScore === 3) { avgTransStr = "Good"; summaryClass = "verdict-good"; }
            else if (worstVerdictScore === 2) { avgTransStr = "Marginal"; summaryClass = "verdict-marginal"; }
            else if (worstVerdictScore === 1) { avgTransStr = "Poor"; summaryClass = "verdict-poor"; }
            
            if (hasUncertainHour) {
                avgTransStr += ' ⚠ Uncertain';
            }
        }

        // Summary Card
        html += `
            <div class="day-card" onclick="openModal('${modalId}')">
                <h2 class="card-header">${nightName}</h2>
                <div class="card-summary">
                    <div class="summary-item">
                        <span class="summary-label">Avg. Cloud:</span>
                        <span class="summary-value">${avgCloud}%</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Max Moon:</span>
                        <span class="summary-value">${Math.round(maxMoon * 100)}%</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Night Rating:</span>
                        <span class="summary-value ${summaryClass}">${avgTransStr}</span>
                    </div>
                </div>
                <div class="card-action">Tap for details ➡</div>
            </div>
        `;

        // Modal for Detail View
        modalsHtml += `
            <div id="${modalId}" class="modal-overlay" onclick="closeModal(event, '${modalId}')">
                <div class="modal-content" onclick="event.stopPropagation()">
                    <div class="modal-header">
                        <h2>${nightName}</h2>
                        <button class="close-btn" onclick="closeModal(null, '${modalId}')">&times;</button>
                    </div>
                    <div class="scroll-hint">Swipe to see hourly forecast &rarr;</div>
                    <div class="horizontal-scroll-container">
                        ${hoursHtml}
                    </div>
                </div>
            </div>
        `;
    }

    container.innerHTML = ephemerisHtml + html + modalsHtml;
}

// Global functions for modal interactions
window.openModal = function (id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden'; // Prevent background scrolling
    }
}

window.closeModal = function (event, id) {
    if (event && event.target && event.target.id !== id && !event.target.classList.contains('close-btn')) return; // Only close if clicking the overlay or close btn
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

function initLocationUI() {
    const searchBtn = document.getElementById('search-btn');
    const locateBtn = document.getElementById('locate-btn');
    const searchInput = document.getElementById('location-search');
    const locationLabel = document.getElementById('location-label');
    const suggestionsList = document.getElementById('suggestions-list');

    if (!searchBtn || !locateBtn || !searchInput || !locationLabel || !suggestionsList) return;

    // Autocomplete Logic
    const fetchSuggestions = debounce(async (query) => {
        if (query.length < 3) {
            suggestionsList.innerHTML = '';
            suggestionsList.classList.add('hidden');
            return;
        }

        try {
            const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&countryCode=AU`);
            const data = await response.json();

            suggestionsList.innerHTML = '';

            if (data.results && data.results.length > 0) {
                data.results.forEach(result => {
                    const li = document.createElement('li');
                    const admin1 = result.admin1 ? `, ${result.admin1}` : '';
                    const country = result.country ? `, ${result.country}` : '';
                    const displayName = `${result.name}${admin1}${country}`;
                    li.textContent = displayName;
                    
                    li.addEventListener('click', () => {
                        const newLat = result.latitude;
                        const newLon = result.longitude;
                        currentLat = newLat;
                        currentLon = newLon;
                        searchInput.value = displayName;
                        locationLabel.innerText = `${displayName} Forecast`;
                        if (weatherWorker) {
                            weatherWorker.postMessage({ lat: newLat, lon: newLon });
                        }
                        suggestionsList.classList.add('hidden');
                    });
                    
                    suggestionsList.appendChild(li);
                });
                suggestionsList.classList.remove('hidden');
            } else {
                suggestionsList.classList.add('hidden');
            }
        } catch (error) {
            console.error("Geocoding autocomplete error:", error);
        }
    }, 300);

    searchInput.addEventListener('input', (e) => {
        fetchSuggestions(e.target.value.trim());
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-wrapper')) {
            suggestionsList.classList.add('hidden');
        }
    });

    searchBtn.addEventListener('click', async () => {
        const query = searchInput.value.trim();
        if (!query) return;

        try {
            searchBtn.disabled = true;
            searchBtn.textContent = "Searching...";
            const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&countryCode=AU`);
            const data = await response.json();

            if (data.results && data.results.length > 0) {
                const result = data.results[0];
                const newLat = result.latitude;
                const newLon = result.longitude;
                currentLat = newLat;
                currentLon = newLon;
                locationLabel.innerText = `${result.name} Forecast`;
                if (weatherWorker) {
                    weatherWorker.postMessage({ lat: newLat, lon: newLon });
                }
            } else {
                alert("Location not found.");
            }
        } catch (error) {
            console.error("Geocoding error:", error);
            alert("Failed to search location.");
        } finally {
            searchBtn.disabled = false;
            searchBtn.textContent = "Search";
        }
    });

    locateBtn.addEventListener('click', () => {
        if (!navigator.geolocation) {
            alert("Geolocation is not supported by your browser.");
            return;
        }

        locateBtn.disabled = true;
        locateBtn.textContent = "Locating...";
        locationLabel.innerText = "Locating...";

        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const newLat = position.coords.latitude;
                const newLon = position.coords.longitude;
                currentLat = newLat;
                currentLon = newLon;
                
                try {
                    const geoUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${newLat}&lon=${newLon}`;
                    const response = await fetch(geoUrl);
                    const data = await response.json();
                    
                    if (data && data.address) {
                        const locationName = data.address.suburb || data.address.city || data.address.town || data.address.village || "Current Location";
                        locationLabel.innerText = `${locationName} Forecast`;
                    } else {
                        locationLabel.innerText = "Current GPS Location";
                    }
                } catch (error) {
                    console.error("Reverse geocoding error:", error);
                    locationLabel.innerText = "Current GPS Location";
                }
                
                if (weatherWorker) {
                    weatherWorker.postMessage({ lat: newLat, lon: newLon });
                }
                locateBtn.disabled = false;
                locateBtn.textContent = "📍 Locate Me";
            },
            (error) => {
                console.error("Geolocation error:", error);
                alert("Location permission denied or unavailable.");
                locateBtn.disabled = false;
                locateBtn.textContent = "📍 Locate Me";
                locationLabel.innerText = "Location Unknown";
            }
        );
    });
}

function initSatelliteModal() {
    const satBtn = document.getElementById('satellite-btn');
    if (satBtn) {
        satBtn.addEventListener('click', () => {
            const iframe = document.getElementById('satellite-iframe');
            if (iframe) {
                iframe.src = `https://embed.windy.com/embed2.html?lat=${currentLat}&lon=${currentLon}&zoom=5&overlay=satellite`;
            }
            document.getElementById('satellite-modal').classList.add('active');
            document.body.style.overflow = 'hidden';
        });
    }
}

window.closeSatelliteModal = function(event, force = false) {
    if (force || (event && event.target && event.target.id === 'satellite-modal')) {
        document.getElementById('satellite-modal').classList.remove('active');
        document.body.style.overflow = '';
    }
};
