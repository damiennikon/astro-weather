// weatherWorker.js

self.onmessage = async (e) => {
    // 1. Data Ingestion Layer
    // Using default coordinates for Loganholme for immediate testing
    const lat = e.data?.lat || -27.6833;
    const lon = e.data?.lon || 153.1833;
    const timezone = "Australia/Brisbane";

    // 2. Parallel Fetching from multiple models
    const models = ['icon_global', 'ukmo_global', 'ecmwf_ifs025'];
    const hourlyParams = "cloud_cover_low,cloud_cover_mid,cloud_cover_high,temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,wind_speed_250hPa";

    try {
        const fetchPromises = models.map(model => {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${hourlyParams}&models=${model}&timezone=${timezone}`;
            return fetch(url).then(async response => {
                if (!response.ok) {
                    console.warn(`Model ${model} failed to fetch: ${response.status}`);
                    return null;
                }
                const data = await response.json();
                // Ensure hourly data exists (some models may not return data for the requested region/params)
                if (!data.hourly || !data.hourly.time) {
                    console.warn(`Model ${model} returned empty hourly data.`);
                    return null;
                }
                return { model, data };
            }).catch(error => {
                console.warn(`Error fetching ${model}:`, error);
                return null;
            });
        });

        // Fetch all simultaneously
        const responses = await Promise.all(fetchPromises);

        // Filter out any models that failed or returned empty data
        const validModels = responses.filter(r => r !== null);

        if (validModels.length === 0) {
            throw new Error("Failed to fetch data from all models.");
        }

        // 3. Data Alignment & Fusion
        const processedForecast = processAndFuseData(validModels, lat, lon);
        
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

function processAndFuseData(validModels, lat, lon) {
    // Collect all unique timestamps across all surviving models to align the data
    const timeSet = new Set();
    validModels.forEach(({ data }) => {
        data.hourly.time.forEach(t => timeSet.add(t));
    });

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

        // Locate the exact index for this timestamp in each model's arrays
        validModels.forEach(({ model, data }) => {
            const idx = data.hourly.time.indexOf(timeString);
            if (idx !== -1) {
                let cL, cM, cH, t, h, dp, w, js;
                
                if (model === 'ukmo_global') {
                    cL = data.hourly.cloud_cover_low_ukmo_global?.[idx] ?? data.hourly.cloud_cover_low?.[idx];
                    cM = data.hourly.cloud_cover_mid_ukmo_global?.[idx] ?? data.hourly.cloud_cover_mid?.[idx];
                    cH = data.hourly.cloud_cover_high_ukmo_global?.[idx] ?? data.hourly.cloud_cover_high?.[idx];
                    t = data.hourly.temperature_2m_ukmo_global?.[idx] ?? data.hourly.temperature_2m?.[idx];
                    h = data.hourly.relative_humidity_2m_ukmo_global?.[idx] ?? data.hourly.relative_humidity_2m?.[idx];
                    dp = data.hourly.dew_point_2m_ukmo_global?.[idx] ?? data.hourly.dew_point_2m?.[idx];
                    w = data.hourly.wind_speed_10m_ukmo_global?.[idx] ?? data.hourly.wind_speed_10m?.[idx];
                    js = data.hourly.wind_speed_250hPa_ukmo_global?.[idx] ?? data.hourly.wind_speed_250hPa?.[idx] ?? null;
                } else {
                    cL = data.hourly.cloud_cover_low[idx];
                    cM = data.hourly.cloud_cover_mid[idx];
                    cH = data.hourly.cloud_cover_high[idx];
                    t = data.hourly.temperature_2m[idx];
                    h = data.hourly.relative_humidity_2m[idx];
                    dp = data.hourly.dew_point_2m[idx];
                    w = data.hourly.wind_speed_10m[idx];
                    js = data.hourly.wind_speed_250hPa?.[idx] ?? null;
                }

                cloudLows.push(cL);
                cloudMids.push(cM);
                cloudHighs.push(cH);
                temps.push(t);
                humidities.push(h);
                dewPoints.push(dp);
                winds.push(w);
                jetStreams.push(js);
                
                if (model === 'icon_global') rawModels.icon = { low: cL ?? 'N/A', mid: cM ?? 'N/A', high: cH ?? 'N/A' };
                else if (model === 'ukmo_global') rawModels.ukmo = { low: cL ?? 'N/A', mid: cM ?? 'N/A', high: cH ?? 'N/A' };
                else if (model === 'ecmwf_ifs025') rawModels.ecmwf = { low: cL ?? 'N/A', mid: cM ?? 'N/A', high: cH ?? 'N/A' };
                
                if (cL !== null && cL !== undefined) {
                    modelMaxClouds.push(Math.max(cL || 0, cM || 0, cH || 0));
                }
            }
        });

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

        // Approximate if moon is above horizon (within ~6.5 hours of local transit)
        const transitHour = getModulo(12 + phase * 24, 24);
        let diff = Math.abs(hour - transitHour);
        if (diff > 12) diff = 24 - diff;
        const isMoonAboveHorizon = diff < 6.5;

        // --- SCORING ENGINE ---
        let score = 100;
        const vetoReasons = [];
        const cL = avgCloudLow !== null ? Math.round(avgCloudLow) : null;
        const cM = avgCloudMid !== null ? Math.round(avgCloudMid) : null;
        const cH = avgCloudHigh !== null ? Math.round(avgCloudHigh) : null;
        const temp = avgTemp !== null ? Math.round(avgTemp) : null;
        const dewPoint = avgDewPoint !== null ? Math.round(avgDewPoint) : null;
        const wind = avgWind !== null ? Math.round(avgWind) : null;
        const jetStream = avgJetStream !== null ? Math.round(avgJetStream) : null;
        const humidity = avgHumidity !== null ? Math.round(avgHumidity) : null;

        // 1. Data Availability Check
        if (cL === null || cM === null || cH === null || temp === null || dewPoint === null || wind === null) {
            vetoReasons.push("Data Unavailable");
        } else {
            // 2. Cloud Deductions
            const maxCloud = Math.max(cL, cM, cH);
            score -= (maxCloud / 100) * 35;
            if (cL > 40) vetoReasons.push("Low Cloud");

            // 3. Dew Point Deductions
            const spread = temp - dewPoint;
            if (spread < 2) {
                vetoReasons.push("Dew Risk");
            } else if (spread < 4) {
                score -= 15;
            }
            
            if (spread >= 2) {
                // Dew Point Spread Trend (Lookahead)
                let collapsing = false;
                for (let lookahead = 1; lookahead <= 3; lookahead++) {
                    if (i + lookahead < sortedTimes.length) {
                        const futureTime = sortedTimes[i + lookahead];
                        const futureTemps = [];
                        const futureDewPoints = [];
                        validModels.forEach(({ data }) => {
                            const idx = data.hourly.time.indexOf(futureTime);
                            if (idx !== -1) {
                                futureTemps.push(data.hourly.temperature_2m[idx]);
                                futureDewPoints.push(data.hourly.dew_point_2m[idx]);
                            }
                        });
                        const futureAvgTemp = safeAverage(futureTemps);
                        const futureAvgDew = safeAverage(futureDewPoints);
                        if (futureAvgTemp !== null && futureAvgDew !== null) {
                            if (futureAvgTemp - futureAvgDew < 4) {
                                collapsing = true;
                                break;
                            }
                        }
                    }
                }
                if (collapsing) {
                    vetoReasons.push("Dew Spread Collapsing");
                }
            }

            // 4. Wind & Seeing Deductions
            if (wind > 25) vetoReasons.push("High Wind");
            else if (wind >= 20) score -= 10;
            
            if (jetStream !== null && jetStream > 100) {
                score -= 10;
            }
        }

        // 5. Moonlight Deductions
        if (isMoonAboveHorizon && moonIllum > 0.25) {
            score -= (moonIllum * 40); // Proportional penalty up to 40 pts
            if (moonIllum > 0.50) {
                vetoReasons.push("Moonlight");
            }
        }

        // --- VERDICT ASSIGNMENT ---
        let verdictTier = "Unknown";
        let vetoReasonStr = null;

        if (vetoReasons.length > 0) {
            verdictTier = "Poor";
            vetoReasonStr = vetoReasons.join(", ");
            score = 1; // Force score to lowest
        } else if (score >= 85) {
            verdictTier = "Excellent";
        } else if (score >= 70) {
            verdictTier = "Good";
        } else if (score >= 50) {
            verdictTier = "Marginal";
        } else {
            verdictTier = "Poor";
        }

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
