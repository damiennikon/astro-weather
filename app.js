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
    initRedMode();
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

function initRedMode() {
    const redModeBtn = document.getElementById('red-mode-btn');
    if (!redModeBtn) return;
    
    if (localStorage.getItem('redMode') === 'true') {
        document.body.classList.add('red-mode');
    }
    
    redModeBtn.addEventListener('click', () => {
        document.body.classList.toggle('red-mode');
        localStorage.setItem('redMode', document.body.classList.contains('red-mode'));
    });
}

window.openConfidenceModal = function(index) {
    const item = window.currentForecastData[index];
    if (!item) return;

    let explanation = "Confidence data is currently unavailable.";
    if (item.modelAgreement === 'Models Agree') {
        explanation = "High Confidence: ICON, UKMO, and ECMWF models are forecasting nearly identical conditions. This forecast is highly reliable.";
    } else if (item.modelAgreement === 'Models Mixed') {
        explanation = "Medium Confidence: The models show slight disagreement. Actual conditions may vary slightly from this forecast.";
    } else if (item.modelAgreement === 'Models Disagree') {
        explanation = "Low Confidence: The models are predicting significantly different conditions. The forecast is highly unstable and could change rapidly.";
    }

    document.getElementById('conf-modal-desc').innerText = explanation;

    let tbody = '';
    const m = item.rawModels || {};
    const icon = m.icon || { low: 'N/A', mid: 'N/A', high: 'N/A' };
    const ukmo = m.ukmo || { low: 'N/A', mid: 'N/A', high: 'N/A' };
    const ecmwf = m.ecmwf || { low: 'N/A', mid: 'N/A', high: 'N/A' };

    const formatVal = (val) => val === 'N/A' || val == null ? 'N/A' : Math.round(val) + '%';

    tbody += `<tr><td>ICON</td><td>${formatVal(icon.low)}</td><td>${formatVal(icon.mid)}</td><td>${formatVal(icon.high)}</td></tr>`;
    tbody += `<tr><td>UKMO</td><td>${formatVal(ukmo.low)}</td><td>${formatVal(ukmo.mid)}</td><td>${formatVal(ukmo.high)}</td></tr>`;
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
                    
                    registration.addEventListener('updatefound', () => {
                        const newWorker = registration.installing;
                        if (!newWorker) return;

                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                showUpdateBanner(newWorker);
                            }
                        });
                    });
                })
                .catch(err => {
                    console.error('ServiceWorker registration failed:', err);
                });

            let refreshing = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (!refreshing) {
                    refreshing = true;
                    window.location.reload();
                }
            });
        });
    } else {
        console.warn('Service workers are not supported in this browser.');
    }
}

function showUpdateBanner(worker) {
    const banner = document.getElementById('update-banner');
    const updateBtn = document.getElementById('update-btn');
    if (banner && updateBtn) {
        banner.classList.remove('hidden');
        updateBtn.onclick = () => {
            banner.classList.add('hidden');
            worker.postMessage({ action: 'skipWaiting' });
        };
    }
}

function initWeatherWorker(lat = LOGANHOLME_LAT, lon = LOGANHOLME_LON) {
    currentLat = lat;
    currentLon = lon;
    const forecastContainer = document.getElementById('forecast-container');

    if (window.Worker) {
        weatherWorker = new Worker('./weatherWorker.js');

        weatherWorker.onmessage = function (event) {
            const response = event.data;
            console.log('Received data from weatherWorker:', response);

            if (response.status === "error") {
                forecastContainer.innerHTML = `<p style="color: red; text-align: center;">Error: ${response.message}</p>`;
                return;
            }

            if (response.status === "success") {
                if (response.utcOffsetSeconds !== undefined) {
                    window.currentUtcOffsetSeconds = response.utcOffsetSeconds;
                }
                renderForecast(response.forecast);
            }
        };

        weatherWorker.onerror = function (error) {
            console.error('Error in weatherWorker:', error);
            forecastContainer.innerHTML = `<p style="color: red; text-align: center;">Failed to process weather data.</p>`;
        };
    } else {
        forecastContainer.innerHTML = `<p style="color: red; text-align: center;">Web Workers are not supported in your browser. Cannot load forecast.</p>`;
    }
}

function renderForecast(forecastArray) {
    const container = document.getElementById('forecast-container');

    if (!Array.isArray(forecastArray) || forecastArray.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h2>No Data</h2>
                <div class="empty-message">No forecast data available for the night hours.</div>
            </div>`;
        return;
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
    const futureForecast = forecastArray.filter(item => new Date(item.timestamp) >= cutoff && item.isAstroDark);
    window.currentForecastData = futureForecast;

    let ephemerisHtml = '<div id="ephemeris-container"></div>';
    
    const astronomyFailedAny = forecastArray.some(item => item.astronomyFailed);
    if (astronomyFailedAny) {
        ephemerisHtml = `<div class="warning-banner" style="background-color: #ff9800; color: #fff; padding: 10px; text-align: center; font-weight: bold; margin-bottom: 15px; border-radius: 4px;">⚠️ Astronomy data unavailable — scores may be inaccurate</div>` + ephemerisHtml;
    }

    const nights = {};
    futureForecast.forEach(item => {
        let nightDateString = 'Unknown Date';
        if (item.timestamp) {
            const [datePart, timePart] = item.timestamp.split('T');
            const [year, month, day] = datePart.split('-').map(Number);
            const hour = parseInt(timePart.split(':')[0], 10);
            
            let nightDate = new Date(Date.UTC(year, month - 1, day));
            if (hour < 12) {
                nightDate = new Date(Date.UTC(year, month - 1, day - 1));
            }
            nightDateString = nightDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
        }

        if (!nights[nightDateString]) {
            nights[nightDateString] = [];
        }
        nights[nightDateString].push(item);
    });

    let mainHtml = '';
    let outlookHtml = '<h2 class="outlook-header">7-Day Outlook</h2>';
    let modalsHtml = '';

    let nightIndex = 0;

    for (const [nightName, hoursData] of Object.entries(nights)) {
        nightIndex++;
        const isFirstNight = nightIndex === 1;
        
        let totalCloud = 0, totalHum = 0, totalDew = 0, totalTemp = 0, totalWind = 0;
        let validCloudCount = 0, validHumCount = 0, validDewCount = 0, validTempCount = 0, validWindCount = 0;
        
        let totalScore = 0;
        let validScoreCount = 0;
        let worstVerdictScore = Infinity;
        let hasUncertainHour = false;
        let maxMoon = 0;

        const getCondText = (val, thresholds) => {
            if (val == null || isNaN(val)) return { text: '-', class: '' };
            if (val <= thresholds.great) return { text: 'Great', class: 'cond-great' };
            if (val <= thresholds.fair) return { text: 'Fair', class: 'cond-fair' };
            return { text: 'Poor', class: 'cond-poor' };
        };
        const getCondTextInverted = (val, thresholds) => {
            if (val == null || isNaN(val)) return { text: '-', class: '' };
            if (val >= thresholds.great) return { text: 'Great', class: 'cond-great' };
            if (val >= thresholds.fair) return { text: 'Fair', class: 'cond-fair' };
            return { text: 'Poor', class: 'cond-poor' };
        };

        let hoursHtml = '';

        hoursData.forEach(item => {
            const index = window.currentForecastData.indexOf(item);
            if (item.isUncertain) hasUncertainHour = true;
            maxMoon = Math.max(maxMoon, item.moonIllumination ?? 0);
            
            const hourlyDisplayScore = item.score != null ? Math.round(item.score) : 0;
            
            let verdictClass = "dot-unknown";
            if (hourlyDisplayScore >= 85) verdictClass = "dot-great"; 
            else if (hourlyDisplayScore >= 65) verdictClass = "dot-good"; 
            else if (hourlyDisplayScore >= 45) verdictClass = "dot-fair"; 
            else if (hourlyDisplayScore >= 25) verdictClass = "dot-poor"; 
            else verdictClass = "dot-very-poor"; 

            const maxCloud = Math.max(item.cloudLow ?? 0, item.cloudMid ?? 0, item.cloudHigh ?? 0);
            totalCloud += maxCloud;
            validCloudCount++;
            
            if (item.humidity != null) { totalHum += item.humidity; validHumCount++; }
            if (item.dewPoint != null) { totalDew += item.dewPoint; validDewCount++; }
            if (item.temp != null) { totalTemp += item.temp; validTempCount++; }
            if (item.wind != null) { totalWind += item.wind; validWindCount++; }

            if (item.score != null) {
                totalScore += item.score;
                validScoreCount++;
            }
            
            let verdictScore = 0;
            if (item.verdictTier === "Great" || item.verdictTier === "Excellent") verdictScore = 4;
            else if (item.verdictTier === "Good") verdictScore = 3;
            else if (item.verdictTier === "Fair" || item.verdictTier === "Marginal") verdictScore = 2;
            else if (item.verdictTier === "Poor") verdictScore = 1;
            
            if (verdictScore > 0 && verdictScore < worstVerdictScore) {
                worstVerdictScore = verdictScore;
            }

            let timeString = 'N/A';
            if (item.timestamp) {
                const dateObj = new Date(item.timestamp);
                timeString = dateObj.toLocaleTimeString([], { hour: 'numeric', hour12: true });
            }

            const tempStr = item.temp != null ? `${Math.round(item.temp)}°C` : '-';
            const windStr = item.wind != null ? `${Math.round(item.wind)}` : '-';
            const cloudStr = maxCloud != null ? `${Math.round(maxCloud)}%` : '-';
            const dewStr = item.dewPoint != null ? `${Math.round(item.dewPoint)}°C` : '-';

            hoursHtml += `
                <div class="hourly-card" onclick="openConfidenceModal(${index})">
                    <div class="hourly-time">${timeString}</div>
                    <div class="hourly-score-dot ${verdictClass}"></div>
                    <div class="hourly-metric-row">Cloud <span class="val">${cloudStr}</span></div>
                    <div class="hourly-metric-row">Temp <span class="val">${tempStr}</span></div>
                    <div class="hourly-metric-row">Wind <span class="val">${windStr}</span></div>
                    <div class="hourly-metric-row">Dew <span class="val">${dewStr}</span></div>
                </div>
            `;
        });

        const avgCloud = validCloudCount > 0 ? Math.round(totalCloud / validCloudCount) : null;
        const avgHum = validHumCount > 0 ? Math.round(totalHum / validHumCount) : null;
        const avgDew = validDewCount > 0 ? Math.round(totalDew / validDewCount) : null;
        const avgTemp = validTempCount > 0 ? Math.round(totalTemp / validTempCount) : null;
        const avgWind = validWindCount > 0 ? Math.round(totalWind / validWindCount) : null;
        const maxMoonPct = Math.round(maxMoon * 100);

        const avgScore = validScoreCount > 0 ? (totalScore / validScoreCount) : 0;
        const displayScore = Math.round(avgScore);
        
        let avgTransStr = 'Unknown';
        let scoreLabel = 'Unknown';
        
        if (validScoreCount > 0) {
            if (displayScore >= 85) { avgTransStr = "Great conditions expected."; scoreLabel = "Great"; }
            else if (displayScore >= 65) { avgTransStr = "Good conditions expected."; scoreLabel = "Good"; }
            else if (displayScore >= 45) { avgTransStr = "Fair conditions, proceed with caution."; scoreLabel = "Fair"; }
            else if (displayScore >= 25) { avgTransStr = "Poor conditions. Not recommended."; scoreLabel = "Poor"; }
            else { avgTransStr = "Very poor conditions. Avoid."; scoreLabel = "Very Poor"; }
            
            if (hasUncertainHour) {
                avgTransStr += ' Models are uncertain.';
            }

            if (maxMoonPct > 60) {
                avgTransStr += ' <span style="color: var(--accent-gold);">⚠️ Note: High lunar illumination will reduce sky contrast, affecting the visibility of the Milky Way and fainter celestial targets.</span>';
            }
        }

        const getScoreColor = (scoreValue) => {
            if (scoreValue >= 85) return '#4caf50'; 
            if (scoreValue >= 65) return 'var(--accent-gold)'; 
            if (scoreValue >= 45) return '#ff9800'; 
            if (scoreValue >= 25) return '#f44336'; 
            return '#b71c1c'; 
        };

        if (isFirstNight) {
            const cloudCond = getCondText(avgCloud, { great: 20, fair: 40 });
            const humCond = getCondText(avgHum, { great: 70, fair: 85 });
            const dewSpread = (avgTemp != null && avgDew != null) ? (avgTemp - avgDew) : null;
            const dewCond = dewSpread != null ? getCondTextInverted(dewSpread, { great: 4, fair: 2 }) : { text: '-', class: '' };
            const windCond = getCondText(avgWind, { great: 15, fair: 20 });
            const moonCond = getCondText(maxMoonPct, { great: 25, fair: 50 });
            const tempCond = { text: '-', class: 'cond-fair' }; 
            const scoreColor = getScoreColor(displayScore);

            mainHtml += `
                <div class="current-night-section">
                    <div class="current-night-header">
                        <div class="score-ring-container">
                            <div class="score-ring" style="border-color: ${scoreColor};">
                                <span class="score-number">${displayScore}</span>
                                <span class="score-label" style="color: ${scoreColor};">${scoreLabel}</span>
                            </div>
                        </div>
                        ${hoursData[0].bestWindow ? `<div class="optimal-window" style="margin-top: 10px; font-weight: bold; color: var(--accent-gold);">Optimal Window: ${hoursData[0].bestWindow.text} (Score: ${hoursData[0].bestWindow.score})</div>` : ''}
                        <div class="ai-summary">Overall: ${avgTransStr}</div>
                    </div>
                    
                    <div class="metrics-grid">
                        <div class="metric-card">
                            <div class="metric-label">☁ Cloud</div>
                            <div class="metric-value">${avgCloud != null ? avgCloud + '%' : '-'}</div>
                            <div class="metric-condition ${cloudCond.class}">${cloudCond.text}</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-label">💧 Humidity</div>
                            <div class="metric-value">${avgHum != null ? avgHum + '%' : '-'}</div>
                            <div class="metric-condition ${humCond.class}">${humCond.text}</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-label">🌡 Dew</div>
                            <div class="metric-value">${avgDew != null ? avgDew + '°C' : '-'}</div>
                            <div class="metric-condition ${dewCond.class}">${dewCond.text} spread</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-label">🌡 Temp</div>
                            <div class="metric-value">${avgTemp != null ? avgTemp + '°C' : '-'}</div>
                            <div class="metric-condition ${tempCond.class}">-</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-label">💨 Wind</div>
                            <div class="metric-value">${avgWind != null ? avgWind + 'km/h' : '-'}</div>
                            <div class="metric-condition ${windCond.class}">${windCond.text}</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-label">🌕 Moon</div>
                            <div class="metric-value">${maxMoonPct}%</div>
                            <div class="metric-condition ${moonCond.class}">${moonCond.text}</div>
                        </div>
                    </div>
                    
                    <div class="horizontal-scroll">
                        ${hoursHtml}
                    </div>
                </div>
            `;
        } else {
            let outlookScoreLabel = 'UNKNOWN';
            let scoreColor = '#b71c1c';
            if (displayScore >= 85) {
                outlookScoreLabel = 'GREAT';
                scoreColor = '#4caf50'; 
            } else if (displayScore >= 65) {
                outlookScoreLabel = 'GOOD';
                scoreColor = 'var(--accent-gold)'; 
            } else if (displayScore >= 45) {
                outlookScoreLabel = 'FAIR';
                scoreColor = '#ff9800'; 
            } else if (displayScore >= 25) {
                outlookScoreLabel = 'POOR';
                scoreColor = '#f44336'; 
            } else {
                outlookScoreLabel = 'VERY POOR';
                scoreColor = '#b71c1c'; 
            }

            outlookHtml += `
                <div class="outlook-card static-card">
                    <div class="outlook-card-content">
                        <div class="outlook-left">
                            <div class="outlook-day">${nightName}</div>
                            <div class="outlook-metrics">
                                ☁ ${avgCloud != null ? avgCloud + '%' : '-'} | 
                                💧 ${avgHum != null ? avgHum + '%' : '-'} | 
                                💨 ${avgWind != null ? avgWind + 'km/h' : '-'} | 
                                🌕 ${maxMoonPct}%
                            </div>
                        </div>
                        <div class="outlook-right">
                            <div class="outlook-score-num">${displayScore}</div>
                            <div class="outlook-score-label" style="color: ${scoreColor};">${outlookScoreLabel}</div>
                        </div>
                    </div>
                </div>
            `;
        }
    }

    container.innerHTML = ephemerisHtml + mainHtml + (nightIndex > 1 ? outlookHtml : '') + modalsHtml;

    if (futureForecast.length > 0) {
        const firstForecastItem = futureForecast[0];
        const targetDateStr = firstForecastItem.timestamp.split('T')[0];
        window.updateEphemerisBanner(targetDateStr);
    }
}

window.updateEphemerisBanner = function(targetDateStr) {
    const container = document.getElementById('ephemeris-container');
    if (!container) return;

    let targetMidnight, localNoon;
    if (window.currentUtcOffsetSeconds !== undefined) {
        const [year, month, day] = targetDateStr.split('-');
        targetMidnight = new Date(Date.UTC(year, month - 1, day) - (window.currentUtcOffsetSeconds * 1000));
        localNoon = new Date(targetMidnight.getTime() + 12 * 3600000);
    } else {
        targetMidnight = new Date(targetDateStr + 'T00:00:00');
        localNoon = new Date(targetDateStr + 'T12:00:00');
    }
    
    let mRise = 'N/A', mSet = 'N/A', gcRise = 'Not Visible', gcSet = 'Not Visible', darkStart = 'N/A', darkEnd = 'N/A', gcEndLabel = 'Sets';

    if (window.Astronomy) {
        const observer = new Astronomy.Observer(currentLat, currentLon, 0);
        
        const formatAstronomyTime = (astroTime) => {
            if (!astroTime || !astroTime.date) return 'N/A';
            return new Date(astroTime.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        };
        
        const moonriseObj = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, +1, localNoon, 1) || Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, +1, localNoon, -1);
        const moonsetObj = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, -1, localNoon, 1) || Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, -1, localNoon, -1);
        
        if (moonriseObj) mRise = formatAstronomyTime(moonriseObj);
        else mRise = "Already up/down";
        
        if (moonsetObj) mSet = formatAstronomyTime(moonsetObj);
        else mSet = "Stays up/down";
        
        if (!moonriseObj && !moonsetObj) {
            const testAlt = Astronomy.Horizon(localNoon, observer, Astronomy.Body.Moon, 'normal').altitude;
            if (testAlt > 0) { mRise = "Up all day"; mSet = "Up all day"; }
            else { mRise = "Below horizon"; mSet = "Below horizon"; }
        }

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

        let foundGcRise = null, foundGcSet = null;
        let t1 = new Astronomy.AstroTime(targetMidnight);
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
             const testAlt = Astronomy.Horizon(new Astronomy.AstroTime(targetMidnight), observer, 17.76, -29.0, 'normal').altitude;
             if (testAlt > 10) { gcRise = "Visible All Night"; gcSet = "Visible All Night"; }
        }
    }

    container.innerHTML = `
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
};

window.openModal = function (id, targetDateStr) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden'; 
        if (targetDateStr) {
            window.updateEphemerisBanner(targetDateStr);
        }
    }
}

window.closeModal = function (event, id) {
    if (event && event.target && event.target.id !== id && !event.target.classList.contains('close-btn')) return; 
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
        if (typeof window.currentForecastData !== 'undefined' && window.currentForecastData.length > 0) {
            if (typeof window.updateEphemerisBanner === 'function') {
                window.updateEphemerisBanner(window.currentForecastData[0].timestamp.split('T')[0]);
            }
        }
    }
}

function initLocationUI() {
    const searchBtn = document.getElementById('search-btn');
    const locateBtn = document.getElementById('locate-btn');
    const searchInput = document.getElementById('location-search');
    const locationLabel = document.getElementById('location-label');
    const suggestionsList = document.getElementById('suggestions-list');

    if (!searchBtn || !locateBtn || !searchInput || !locationLabel || !suggestionsList) return;

    let selectedLat = null;
    let selectedLon = null;
    let selectedName = '';

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
                        selectedLat = result.latitude;
                        selectedLon = result.longitude;
                        selectedName = displayName;
                        searchInput.value = displayName;
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

        if (selectedLat !== null && selectedLon !== null && query === selectedName) {
            currentLat = selectedLat;
            currentLon = selectedLon;
            locationLabel.innerText = `${selectedName} Forecast`;
            if (weatherWorker) {
                weatherWorker.postMessage({ lat: currentLat, lon: currentLon });
            }
            selectedLat = null;
            selectedLon = null;
            selectedName = '';
            return;
        }

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
                console.warn('Location not found or fetch failed: No results returned');
            }
        } catch (error) {
            console.warn('Location not found or fetch failed:', error);
        } finally {
            searchBtn.disabled = false;
            searchBtn.textContent = "Search";
        }
    });

    // Added comprehensive try/catch & timeout resets for location hangs
    locateBtn.addEventListener('click', () => {
        if (!navigator.geolocation) {
            console.warn('Location not found or fetch failed: Geolocation is not supported by your browser.');
            return;
        }

        locateBtn.disabled = true;
        locateBtn.textContent = "Locating...";
        locationLabel.innerText = "Locating...";

        try {
            navigator.geolocation.getCurrentPosition(
                async (position) => {
                    const newLat = position.coords.latitude;
                    const newLon = position.coords.longitude;
                    currentLat = newLat;
                    currentLon = newLon;
                    
                    try {
                        const geoUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${newLat}&lon=${newLon}&email=your_email@example.com`;
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
                    console.warn('Location access denied or timed out:', error);
                    locateBtn.disabled = false;
                    locateBtn.textContent = "📍 Locate Me";
                    locationLabel.innerText = "Location Unknown";
                    const forecastContainer = document.getElementById('forecast-container');
                    if (forecastContainer) {
                        forecastContainer.innerHTML = `<p style="color: red; text-align: center; margin-top: 2rem;">Location access denied or timed out.<br>Please search for a city instead.</p>`;
                    }
                },
                { timeout: 10000 }
            );
        } catch (error) {
            console.warn('Geolocation error:', error);
            locateBtn.disabled = false;
            locateBtn.textContent = "📍 Locate Me";
            locationLabel.innerText = "Location Error";
            const forecastContainer = document.getElementById('forecast-container');
            if (forecastContainer) {
                forecastContainer.innerHTML = `<p style="color: red; text-align: center; margin-top: 2rem;">A location error occurred.<br>Please search for a city instead.</p>`;
            }
        }
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
