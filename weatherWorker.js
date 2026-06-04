// weatherWorker.js

let isAstronomyLoaded = false;
try {
    importScripts('https://cdn.jsdelivr.net/npm/astronomy-engine@2.1.19/astronomy.browser.min.js');
    if (typeof Astronomy !== 'undefined') {
        isAstronomyLoaded = true;
        console.log("SUCCESS: Astronomy Engine loaded from CDN.");
    }
} catch (e) {
    console.error("CRITICAL: Astronomy engine import failed.", e);
}

self.onmessage = async (e) => {
    // 1. Data Ingestion Layer
    const lat = e.data?.lat || -27.6833;
    const lon = e.data?.lon || 153.1833;
    const timezone = "auto";

    // 2. Dual-Stream Fetching from multiple models
    const surfaceModels = "ecmwf_ifs04,icon_global,ukmo_seamless";
    const surfaceParams = "cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m";
    const surfaceUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${surfaceParams}&models=${surfaceModels}&timezone=${timezone}`;

    const upperModels = "ecmwf_ifs04,icon_global";
    const upperParams = "wind_speed_250hPa";
    const upperUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${upperParams}&models=${upperModels}&timezone=${timezone}`;

    try {
        const [surfaceRes, upperRes] = await Promise.all([fetch(surfaceUrl), fetch(upperUrl)]);

        if (!surfaceRes.ok) throw new Error(`Surface fetch failed: ${surfaceRes.status}`);
        if (!upperRes.ok) throw new Error(`Upper fetch failed: ${upperRes.status}`);

        const surfaceData = await surfaceRes.json();
        const upperData = await upperRes.json();

        if (!surfaceData.hourly || !upperData.hourly) {
            throw new Error("Returned empty hourly data.");
        }

        const utcOffsetSeconds = (typeof surfaceData.utc_offset_seconds === 'number' 
            && !isNaN(surfaceData.utc_offset_seconds)) 
            ? surfaceData.utc_offset_seconds 
            : 36000;
        console.log('UTC offset extracted:', utcOffsetSeconds, typeof utcOffsetSeconds);

        // 3. Data Alignment & Fusion
        const processedForecast = processAndFuseData(surfaceData, upperData, lat, lon, utcOffsetSeconds);
        
        // 4. Send the payload back to the UI
        self.postMessage({
            status: "success",
            forecast: processedForecast,
            utcOffsetSeconds: utcOffsetSeconds
        });

    } catch (error) {
        self.postMessage({
            status: "error",
            message: error.message
        });
    }
};

function processAndFuseData(surfaceData, upperData, lat, lon, utcOffsetSeconds) {
    const timeSet = new Set(surfaceData.hourly.time);
    const sortedTimes = Array.from(timeSet).sort();
    const nightForecasts = [];

    const safeAverage = (values) => {
        const validVals = values.filter(v => v !== null && v !== undefined && !isNaN(v));
        if (validVals.length === 0) return null;
        const sum = validVals.reduce((a, b) => a + b, 0);
        return sum / validVals.length;
    };

    const defensiveBlend = (ecmwf, ukmo, icon) => {
        const valid = [];
        if (ecmwf != null && !isNaN(ecmwf)) valid.push({ val: ecmwf, weight: 0.5 });
        if (ukmo != null && !isNaN(ukmo)) valid.push({ val: ukmo, weight: 0.3 });
        if (icon != null && !isNaN(icon)) valid.push({ val: icon, weight: 0.2 });
        
        if (valid.length === 0) return null;

        const max = Math.max(...valid.map(v => v.val));
        const min = Math.min(...valid.map(v => v.val));
        const spread = max - min;
        
        if (valid.length === 3 && spread > 30) {
            return min + 0.7 * spread;
        }

        const totalWeight = valid.reduce((sum, v) => sum + v.weight, 0);
        return valid.reduce((sum, v) => sum + (v.val * (v.weight / totalWeight)), 0);
    };

    for (let i = 0; i < sortedTimes.length; i++) {
        const timeString = sortedTimes[i];
        const date = new Date(timeString);
        const hour = date.getHours();

        const cloudLows = [], cloudMids = [], cloudHighs = [], temps = [], humidities = [], dewPoints = [], winds = [], jetStreams = [];
        const modelMaxClouds = [];
        const rawModels = {
            icon: { low: 'N/A', mid: 'N/A', high: 'N/A' },
            ukmo: { low: 'N/A', mid: 'N/A', high: 'N/A' },
            ecmwf: { low: 'N/A', mid: 'N/A', high: 'N/A' }
        };

        const idxSurface = surfaceData.hourly.time.indexOf(timeString);
        const idxUpper = upperData.hourly.time.indexOf(timeString);

        if (idxSurface !== -1) {
            // ECMWF
            const ecmwf_cL = surfaceData.hourly.cloud_cover_low_ecmwf_ifs04?.[idxSurface];
            const ecmwf_cM = surfaceData.hourly.cloud_cover_mid_ecmwf_ifs04?.[idxSurface];
            const ecmwf_cH = surfaceData.hourly.cloud_cover_high_ecmwf_ifs04?.[idxSurface];
            cloudLows.push(ecmwf_cL); cloudMids.push(ecmwf_cM); cloudHighs.push(ecmwf_cH);
            temps.push(surfaceData.hourly.temperature_2m_ecmwf_ifs04?.[idxSurface]);
            humidities.push(surfaceData.hourly.relative_humidity_2m_ecmwf_ifs04?.[idxSurface]);
            dewPoints.push(surfaceData.hourly.dew_point_2m_ecmwf_ifs04?.[idxSurface]);
            winds.push(surfaceData.hourly.wind_speed_10m_ecmwf_ifs04?.[idxSurface]);
            rawModels.ecmwf = { low: ecmwf_cL ?? 'N/A', mid: ecmwf_cM ?? 'N/A', high: ecmwf_cH ?? 'N/A' };
            if (ecmwf_cL !== undefined && ecmwf_cL !== null) modelMaxClouds.push(Math.max(ecmwf_cL||0, ecmwf_cM||0, ecmwf_cH||0));

            // ICON
            const icon_cL = surfaceData.hourly.cloud_cover_low_icon_global?.[idxSurface];
            const icon_cM = surfaceData.hourly.cloud_cover_mid_icon_global?.[idxSurface];
            const icon_cH = surfaceData.hourly.cloud_cover_high_icon_global?.[idxSurface];
            cloudLows.push(icon_cL); cloudMids.push(icon_cM); cloudHighs.push(icon_cH);
            temps.push(surfaceData.hourly.temperature_2m_icon_global?.[idxSurface]);
            humidities.push(surfaceData.hourly.relative_humidity_2m_icon_global?.[idxSurface]);
            dewPoints.push(surfaceData.hourly.dew_point_2m_icon_global?.[idxSurface]);
            winds.push(surfaceData.hourly.wind_speed_10m_icon_global?.[idxSurface]);
            rawModels.icon = { low: icon_cL ?? 'N/A', mid: icon_cM ?? 'N/A', high: icon_cH ?? 'N/A' };
            if (icon_cL !== undefined && icon_cL !== null) modelMaxClouds.push(Math.max(icon_cL||0, icon_cM||0, icon_cH||0));

            // UKMO
            const ukmo_cL = surfaceData.hourly.cloud_cover_low_ukmo_seamless?.[idxSurface];
            const ukmo_cM = surfaceData.hourly.cloud_cover_mid_ukmo_seamless?.[idxSurface];
            const ukmo_cH = surfaceData.hourly.cloud_cover_high_ukmo_seamless?.[idxSurface];
            cloudLows.push(ukmo_cL); cloudMids.push(ukmo_cM); cloudHighs.push(ukmo_cH);
            temps.push(surfaceData.hourly.temperature_2m_ukmo_seamless?.[idxSurface]);
            humidities.push(surfaceData.hourly.relative_humidity_2m_ukmo_seamless?.[idxSurface]);
            dewPoints.push(surfaceData.hourly.dew_point_2m_ukmo_seamless?.[idxSurface]);
            winds.push(surfaceData.hourly.wind_speed_10m_ukmo_seamless?.[idxSurface]);
            rawModels.ukmo = { low: ukmo_cL ?? 'N/A', mid: ukmo_cM ?? 'N/A', high: ukmo_cH ?? 'N/A' };
            if (ukmo_cL !== undefined && ukmo_cL !== null) modelMaxClouds.push(Math.max(ukmo_cL||0, ukmo_cM||0, ukmo_cH||0));
        }

        if (idxUpper !== -1) {
            jetStreams.push(upperData.hourly.wind_speed_250hPa_ecmwf_ifs04?.[idxUpper]);
            jetStreams.push(upperData.hourly.wind_speed_250hPa_icon_global?.[idxUpper]);
        }

        let modelAgreement = 'Models Agree';
        let isUncertain = false;
        if (modelMaxClouds.length >= 2) {
            const minModelCloud = Math.min(...modelMaxClouds);
            const maxModelCloud = Math.max(...modelMaxClouds);
            const diff = maxModelCloud - minModelCloud;
            if (diff > 30) {
                modelAgreement = 'Models Disagree';
                isUncertain = true;
            } else if (diff > 15) {
                modelAgreement = 'Models Mixed';
            }
        }

        const avgCloudLow = defensiveBlend(
            rawModels.ecmwf.low !== 'N/A' ? rawModels.ecmwf.low : null,
            rawModels.ukmo.low !== 'N/A' ? rawModels.ukmo.low : null,
            rawModels.icon.low !== 'N/A' ? rawModels.icon.low : null
        );
        const avgCloudMid = defensiveBlend(
            rawModels.ecmwf.mid !== 'N/A' ? rawModels.ecmwf.mid : null,
            rawModels.ukmo.mid !== 'N/A' ? rawModels.ukmo.mid : null,
            rawModels.icon.mid !== 'N/A' ? rawModels.icon.mid : null
        );
        const avgCloudHigh = defensiveBlend(
            rawModels.ecmwf.high !== 'N/A' ? rawModels.ecmwf.high : null,
            rawModels.ukmo.high !== 'N/A' ? rawModels.ukmo.high : null,
            rawModels.icon.high !== 'N/A' ? rawModels.icon.high : null
        );
        const avgTemp = safeAverage(temps);
        const avgHumidity = safeAverage(humidities);
        const avgDewPoint = safeAverage(dewPoints);
        const avgWind = safeAverage(winds);
        const avgJetStream = safeAverage(jetStreams);

        // --- ASTRONOMY ENGINE ---
        let isAstroDark = false;
        let moonIllum = 0;
        let moonAltDeg = -90;
        let isMoonAboveHorizon = false;
        let astronomyFailed = false;

        try {
            if (!isAstronomyLoaded || typeof Astronomy === 'undefined') {
                throw new Error('Astronomy engine not loaded');
            }

            const safeLat = Number(lat) || -27.6833;
            const safeLon = Number(lon) || 153.1833;
            const observer = new Astronomy.Observer(safeLat, safeLon, 0);

            // Append Z to force unambiguous UTC interpretation
            const utcTimestamp = timeString.length === 16 ? timeString + ':00Z' : timeString + 'Z';
            const utcTimeMs = new Date(utcTimestamp).getTime();

            const safeOffsetSeconds = (typeof utcOffsetSeconds === 'number' && !isNaN(utcOffsetSeconds)) ? utcOffsetSeconds : 36000;

            // Convert local time to true UTC by subtracting the location offset
            const targetTime = new Date(utcTimeMs - (safeOffsetSeconds * 1000));

            if (isNaN(targetTime.getTime())) {
                throw new Error(`Invalid Date: ${timeString}, offset: ${safeOffsetSeconds}`);
            }

            // Sun altitude
            const sunHorizon = Astronomy.Horizon(targetTime, observer, Astronomy.Body.Sun, 'normal');
            isAstroDark = sunHorizon.altitude <= -18;

            // Moon illumination (Property fallback fix)
            const moonIllumData = Astronomy.Illumination(Astronomy.Body.Moon, targetTime);
            moonIllum = moonIllumData.disc_light_fraction ?? moonIllumData.phase_fraction ?? 0;
            console.log('Moon illum:', moonIllum, 'from object:', JSON.stringify(moonIllumData));

            // Moon altitude
            const moonHorizon = Astronomy.Horizon(targetTime, observer, Astronomy.Body.Moon, 'normal');
            moonAltDeg = moonHorizon.altitude;
            isMoonAboveHorizon = moonAltDeg > 0;

        } catch (error) {
            console.error("Astronomy Engine Crash:", error.message);
            isAstroDark = true;
            moonIllum = 0;
            moonAltDeg = -90;
            isMoonAboveHorizon = false;
            astronomyFailed = true;
        }

        // --- SCORING ENGINE ---
        let score = 0;
        const vetoReasons = [];
        const cL = avgCloudLow !== null ? Math.round(avgCloudLow) : null;
        const cM = avgCloudMid !== null ? Math.round(avgCloudMid) : null;
        const cH = avgCloudHigh !== null ? Math.round(avgCloudHigh) : null;
        const temp = avgTemp !== null ? Math.round(avgTemp) : null;
        const dewPoint = avgDewPoint !== null ? Math.round(avgDewPoint) : null;
        const wind = avgWind !== null ? Math.round(avgWind) : null;
        const jetStream = avgJetStream !== null ? Math.round(avgJetStream) : null;
        const humidity = avgHumidity !== null ? Math.round(avgHumidity) : null;

        let verdictTier = "Unknown";
        let vetoReasonStr = null;

        if (cL === null || cM === null || cH === null || temp === null || dewPoint === null || wind === null || humidity === null) {
            vetoReasons.push("Data Unavailable");
            score = 0;
            verdictTier = "Very Poor";
            vetoReasonStr = vetoReasons.join(", ");
        } else {
            const maxCloud = Math.max(cL, cM, cH);
            
            const cloudScore = getCloudScore(maxCloud);
            let moonScore = getMoonScore(moonIllum, moonAltDeg);
            
            if (moonAltDeg > 0 && moonAltDeg <= 10) {
                const penalty = 100 - moonScore;
                moonScore = 100 - (penalty * 0.5);
            }

            const humidityScore = getHumidityScore(humidity);
            const dewSpreadScore = getDewSpreadScore(temp, dewPoint);
            const windScore = getWindScore(wind);
            
            score = (cloudScore * 0.35) + (moonScore * 0.30) + (humidityScore * 0.15) + (dewSpreadScore * 0.10) + (windScore * 0.10);

            if (maxCloud > 70) {
                score = Math.min(score, 20);
                vetoReasons.push("Cloud > 70%");
            } else if (maxCloud > 50) {
                score = Math.min(score, 35);
                vetoReasons.push("Cloud > 50%");
            }
            
            if (moonIllum > 0.8 && moonAltDeg > 0) {
                score = Math.min(score, 24);
                vetoReasons.push("Bright Moon");
            }
            
            if (vetoReasons.length > 0) {
                vetoReasonStr = vetoReasons.join(", ");
            }

            if (score >= 85) verdictTier = "GREAT";
            else if (score >= 65) verdictTier = "GOOD";
            else if (score >= 45) verdictTier = "FAIR";
            else if (score >= 25) verdictTier = "POOR";
            else verdictTier = "VERY POOR";
        }

        nightForecasts.push({
            timestamp: timeString,
            hour: hour,
            cloudLow: cL,
            cloudMid: cM,
            cloudHigh: cH,
            temp: temp,
            humidity: humidity,
            dewPoint: dewPoint,
            wind: wind,
            jetStream: jetStream,
            score: score,
            verdictTier: verdictTier,
            vetoReason: vetoReasonStr,
            moonIllumination: moonIllum,
            isMoonAboveHorizon: isMoonAboveHorizon,
            isAstroDark: isAstroDark,
            modelAgreement: modelAgreement,
            isUncertain: isUncertain,
            astronomyFailed: astronomyFailed,
            rawModels: rawModels
        });
    }

    const nights = {};
    nightForecasts.forEach(item => {
        if (!item.timestamp) return;
        const [datePart, timePart] = item.timestamp.split('T');
        const [year, month, day] = datePart.split('-').map(Number);
        const hour = parseInt(timePart.split(':')[0], 10);
        let nightDate = new Date(Date.UTC(year, month - 1, day));
        if (hour < 12) {
            nightDate = new Date(Date.UTC(year, month - 1, day - 1));
        }
        const nightDateStr = nightDate.toISOString().split('T')[0];
        if (!nights[nightDateStr]) nights[nightDateStr] = [];
        nights[nightDateStr].push(item);
    });

    for (const [nightDate, hoursData] of Object.entries(nights)) {
        let bestWindow = null;
        let highestAvgScore = -1;

        hoursData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        const darkHours = hoursData.filter(h => h.isAstroDark && h.score != null);

        for (let size = 3; size >= 1; size--) {
            if (darkHours.length < size) continue;
            
            let foundAtThisSize = false;
            for (let i = 0; i <= darkHours.length - size; i++) {
                const windowHours = darkHours.slice(i, i + size);
                
                let isConsecutive = true;
                for (let j = 0; j < windowHours.length - 1; j++) {
                    const t1 = new Date(windowHours[j].timestamp).getTime();
                    const t2 = new Date(windowHours[j+1].timestamp).getTime();
                    if (t2 - t1 !== 3600000) {
                        isConsecutive = false;
                        break;
                    }
                }

                if (isConsecutive) {
                    foundAtThisSize = true;
                    const avgWinScore = windowHours.reduce((sum, h) => sum + h.score, 0) / size;
                    
                    if (avgWinScore > highestAvgScore) {
                        highestAvgScore = avgWinScore;
                        
                        const hFirst = windowHours[0];
                        const hLast = windowHours[windowHours.length - 1];
                        
                        const formatTime = (ts) => {
                            const hr = parseInt(ts.split('T')[1].split(':')[0], 10);
                            const ampm = hr >= 12 ? 'PM' : 'AM';
                            const fmtHr = hr % 12 || 12;
                            return `${fmtHr} ${ampm}`;
                        };
                        
                        const endHr = (parseInt(hLast.timestamp.split('T')[1].split(':')[0], 10) + 1) % 24;
                        const endAmPm = endHr >= 12 ? 'PM' : 'AM';
                        const fmtEndHr = endHr % 12 || 12;

                        bestWindow = {
                            startTimeStr: formatTime(hFirst.timestamp),
                            endTimeFormatted: `${fmtEndHr} ${endAmPm}`,
                            avgScore: Math.round(avgWinScore)
                        };
                    }
                }
            }
            if (foundAtThisSize) break; 
        }
        
        if (bestWindow) {
            const bw = {
                text: `${bestWindow.startTimeStr} - ${bestWindow.endTimeFormatted}`,
                score: bestWindow.avgScore
            };
            hoursData.forEach(item => item.bestWindow = bw);
        }
    }

    return nightForecasts;
}

function getCloudScore(cloud) {
    if (cloud <= 5) return 100;
    if (cloud <= 15) return 85;
    if (cloud <= 30) return 60;
    if (cloud <= 50) return 30;
    return 0;
}

function getMoonScore(illumination, altitude) {
    if (altitude < 0) return 100;
    const illumPct = illumination * 100;
    if (illumPct <= 10) return 100;
    if (illumPct <= 25) return 85;
    if (illumPct <= 45) return 60;
    if (illumPct <= 65) return 35;
    if (illumPct <= 80) return 15;
    return 0;
}

function getHumidityScore(humidity) {
    if (humidity < 50) return 100;
    if (humidity <= 65) return 80;
    if (humidity <= 75) return 60;
    if (humidity <= 85) return 35;
    return 10;
}

function getDewSpreadScore(temp, dew) {
    const spread = temp - dew;
    if (spread > 8) return 100;
    if (spread >= 5) return 75;
    if (spread >= 3) return 45;
    return 10;
}

function getWindScore(windKm) {
    if (windKm <= 10) return 100;
    if (windKm <= 20) return 75;
    if (windKm <= 35) return 40;
    return 10;
}
