// weatherWorker.js

self.onmessage = async (e) => {
    // 1. Data Ingestion Layer
    // Using default coordinates for Loganholme for immediate testing
    const lat = e.data?.lat || -27.6833;
    const lon = e.data?.lon || 153.1833;
    const timezone = "Australia/Brisbane";

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

        // 3. Data Alignment & Fusion
        const processedForecast = processAndFuseData(surfaceData, upperData, lat, lon);
        
        // 4. Send the payload back to the UI
        self.postMessage({
            status: "success",
            forecast: processedForecast
        });

    } catch (error) {
        self.postMessage({
            status: "error",
            message: error.message
        });
    }
};

function processAndFuseData(surfaceData, upperData, lat, lon) {
    // Collect all unique timestamps to align the data
    const timeSet = new Set(surfaceData.hourly.time);

    const sortedTimes = Array.from(timeSet).sort();
    const nightForecasts = [];

    // Helper for safe averaging: ignores null/undefined/NaN
    const safeAverage = (values) => {
        const validVals = values.filter(v => v !== null && v !== undefined && !isNaN(v));
        if (validVals.length === 0) return null;
        const sum = validVals.reduce((a, b) => a + b, 0);
        return sum / validVals.length;
    };

    for (let i = 0; i < sortedTimes.length; i++) {
        const timeString = sortedTimes[i];
        const date = new Date(timeString);
        const hour = date.getHours();

        // Arrays to hold the data points from all available models for this specific hour
        const cloudLows = [];
        const cloudMids = [];
        const cloudHighs = [];
        const temps = [];
        const humidities = [];
        const dewPoints = [];
        const winds = [];
        const jetStreams = [];
        
        const modelMaxClouds = [];
        const rawModels = {
            icon: { low: 'N/A', mid: 'N/A', high: 'N/A' },
            ukmo: { low: 'N/A', mid: 'N/A', high: 'N/A' },
            ecmwf: { low: 'N/A', mid: 'N/A', high: 'N/A' }
        };


        const idxSurface = surfaceData.hourly.time.indexOf(timeString);
        const idxUpper = upperData.hourly.time.indexOf(timeString);

        if (idxSurface !== -1) {
            // ECMWF IFS04
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

            // ICON Global
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

            // UKMO Seamless
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

        // Model Confidence Calculation
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

        // Compute safe averages
        const avgCloudLow = safeAverage(cloudLows);
        const avgCloudMid = safeAverage(cloudMids);
        const avgCloudHigh = safeAverage(cloudHighs);
        const avgTemp = safeAverage(temps);
        const avgHumidity = safeAverage(humidities);
        const avgDewPoint = safeAverage(dewPoints);
        const avgWind = safeAverage(winds);
        const avgJetStream = safeAverage(jetStreams);

        // --- NATIVE ASTRONOMY ENGINE ---
        // Helper to safely handle negative modulos
        const getModulo = (a, n) => ((a % n) + n) % n;
        const rad = Math.PI / 180;
        
        // 1. Native Astronomical Twilight (Sun Altitude)
        const d = (date.getTime() - Date.UTC(2000, 0, 1, 12, 0, 0)) / 86400000;
        const M_rad = getModulo(356.0470 + 0.9856002585 * d, 360) * rad;
        const C = 1.9148 * Math.sin(M_rad) + 0.0200 * Math.sin(2 * M_rad) + 0.0003 * Math.sin(3 * M_rad);
        const lambda_rad = getModulo((M_rad/rad) + C + 180 + 102.9372, 360) * rad;
        const declination = Math.asin(Math.sin(lambda_rad) * Math.sin(23.44 * rad));
        const ra = Math.atan2(Math.sin(lambda_rad) * Math.cos(23.44 * rad), Math.cos(lambda_rad));
        const GMST = 18.697374558 + 24.06570982441908 * d;
        const LST = getModulo(GMST + lon / 15, 24);
        const HA = (LST * 15 * rad) - ra;
        const lat_rad = lat * rad;
        const sinAlt = Math.sin(declination) * Math.sin(lat_rad) + Math.cos(declination) * Math.cos(lat_rad) * Math.cos(HA);
        const sunAltDeg = Math.asin(sinAlt) / rad;
        const isAstroDark = sunAltDeg <= -18;

        // 2. Native Moon Phase & Illumination
        const newMoon = Date.UTC(2000, 0, 6, 18, 14, 0); // Known New Moon: Jan 6, 2000, 18:14 UTC
        const daysSinceNewMoon = (date.getTime() - newMoon) / 86400000;
        const synodicMonth = 29.530588853;
        const phase = getModulo(daysSinceNewMoon, synodicMonth) / synodicMonth;
        const moonIllum = 0.5 * (1 - Math.cos(phase * 2 * Math.PI));

        // Approximate Moon Altitude
        const L_moon_rad = getModulo(218.316 + 13.176396 * d, 360) * rad;
        const M_moon_rad = getModulo(134.963 + 13.064993 * d, 360) * rad;
        const F_moon_rad = getModulo(93.272 + 13.229350 * d, 360) * rad;
        const lambda_moon_rad = L_moon_rad + 6.289 * rad * Math.sin(M_moon_rad);
        const beta_moon_rad = 5.128 * rad * Math.sin(F_moon_rad);
        const moon_declination = Math.asin(Math.sin(beta_moon_rad) * Math.cos(23.44 * rad) + Math.cos(beta_moon_rad) * Math.sin(23.44 * rad) * Math.sin(lambda_moon_rad));
        const moon_ra = Math.atan2(Math.sin(lambda_moon_rad) * Math.cos(23.44 * rad) - Math.tan(beta_moon_rad) * Math.sin(23.44 * rad), Math.cos(lambda_moon_rad));
        const moon_HA = (LST * 15 * rad) - moon_ra;
        const moon_sinAlt = Math.sin(moon_declination) * Math.sin(lat_rad) + Math.cos(moon_declination) * Math.cos(lat_rad) * Math.cos(moon_HA);
        const moonAltDeg = Math.asin(moon_sinAlt) / rad;
        const isMoonAboveHorizon = moonAltDeg > 0;

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

        // 1. Data Availability Check
        if (cL === null || cM === null || cH === null || temp === null || dewPoint === null || wind === null || humidity === null) {
            vetoReasons.push("Data Unavailable");
            score = 0;
            verdictTier = "Very Poor";
            vetoReasonStr = vetoReasons.join(", ");
        } else {
            const maxCloud = Math.max(cL, cM, cH);
            
            const cloudScore = getCloudScore(maxCloud);
            const moonScore = getMoonScore(moonIllum, moonAltDeg);
            const humidityScore = getHumidityScore(humidity);
            const dewSpreadScore = getDewSpreadScore(temp, dewPoint);
            const windScore = getWindScore(wind);
            
            score = (cloudScore * 0.35) + (moonScore * 0.30) + (humidityScore * 0.15) + (dewSpreadScore * 0.10) + (windScore * 0.10);

            if (maxCloud > 50) {
                score = Math.min(score, 24);
                vetoReasons.push("Cloud > 50%");
            }
            
            if (moonIllum > 0.8 && moonAltDeg > 0) {
                score = Math.min(score, 24);
                vetoReasons.push("Bright Moon");
            }
            
            if (vetoReasons.length > 0) {
                vetoReasonStr = vetoReasons.join(", ");
            }

            if (score >= 85) {
                verdictTier = "GREAT";
            } else if (score >= 65) {
                verdictTier = "GOOD";
            } else if (score >= 45) {
                verdictTier = "FAIR";
            } else if (score >= 25) {
                verdictTier = "POOR";
            } else {
                verdictTier = "VERY POOR";
            }
        }

        console.log("Day Calculation:", timeString, "Raw Score:", score);

        // Output Payload Object
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
            rawModels: rawModels
        });
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
