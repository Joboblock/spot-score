import { ACCESS_TOKEN } from "./api-key.js";
import { buildSpotScores, TEMP_OPTIMAL_C } from "./utils.js";

const WEATHER_BASE_URL = "https://api.netatmo.com/api/getpublicdata";
const OPEN_METEO_BASE_URL = "https://api.open-meteo.com/v1/forecast";
const NOISE_BASE_URL = "https://api.hamburg.de/datasets/v1/strassenverkehr";
const LDEN_COLLECTION = "strassenverkehr_tag_abend_nacht_2022";
const NETATMO_NEAREST_COUNT = 3;
const NETATMO_RADIUS_KM = 1;
const NETATMO_NEAREST_DISTANCE_FACTOR = 1.5;
const DISTANCE_WEIGHT_MIN_KM = 0.05;
const WEATHER_METRICS = ["temperature", "humidity", "windStrength", "rain24h"];
const DEFAULT_CENTER = [53.5511, 9.9937];
const DEFAULT_ZOOM = 11;
const MIN_ZOOM = 10;
const MAX_ZOOM = 16;
const HAMBURG_BOUNDS = [
    [53.41062884725186, 9.732240484945219],
    [53.72838568700598, 10.29272015751267]
];
const CITY_AVERAGE_SAMPLE_POINT_COUNT = 5;
let map;
let activeLayer;
let legendControl;
let queryMarker;

document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("mapForm");
    const coordinateForm = document.getElementById("coordinateForm");
    const modeSelect = document.getElementById("mapModeSelect");
    const latitudeInput = document.getElementById("latitudeInput");
    const longitudeInput = document.getElementById("longitudeInput");

    hideOutput();

    if (form) {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            loadSelectedMode();
        });
    }

    if (coordinateForm) {
        coordinateForm.addEventListener("submit", (event) => {
            event.preventDefault();
            const lat = Number(latitudeInput?.value);
            const lon = Number(longitudeInput?.value);

            if (!isValidCoordinates(lat, lon)) {
                renderQueryError("Please enter valid coordinates.");
                return;
            }

            handlePointSelection(lat, lon);
        });
    }

    if (modeSelect) {
        modeSelect.addEventListener("change", () => {
            updateSubtitle(modeSelect.value);
            loadSelectedMode();
        });
        updateSubtitle(modeSelect.value);
    }

    initMap();
});

function initMap() {
    if (typeof L === "undefined") return;

    map = L.map("map", {
        attributionControl: false,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        maxBounds: HAMBURG_BOUNDS,
        maxBoundsViscosity: 1.0
    }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        attribution: ""
    }).addTo(map);

    map.on("click", (event) => {
        const { lat, lng } = event.latlng;
        syncCoordinateInputs(lat, lng);
        handlePointSelection(lat, lng);
    });
}

function loadSelectedMode() {
    const mode = document.getElementById("mapModeSelect")?.value ?? "noise";

    if (mode === "weather") {
        loadWeatherData();
        return;
    }

    loadNoiseData();
}

function updateSubtitle(mode) {
    const subtitle = document.getElementById("subtitleText");
    if (!subtitle) return;

    subtitle.innerHTML =
        mode === "weather"
            ? "Source: Netatmo <code>/getpublicdata</code> for public stations in Hamburg"
            : "Source: API Hamburg <code>strassenverkehr</code>, collection <code>strassenverkehr_tag_abend_nacht_2022</code> (Lden)";
}

async function loadWeatherData() {
    if (!ACCESS_TOKEN) {
        renderQueryError("Missing Netatmo access token in src/api-key.js.");
        clearMapLayer();
        return;
    }

    clearMapLayer();

    try {
        const focus = getWeatherFocusPoint();
        const stations = await fetchWeatherStationsWithinRadius(
            focus.lat,
            focus.lon,
            NETATMO_RADIUS_KM
        );
        renderWeatherMap(stations);
    } catch (error) {
        clearMapLayer();
    }
}

async function loadNoiseData() {
    clearMapLayer();

    try {
        const params = new URLSearchParams({
            f: "json",
            limit: "100"
        });

        const response = await fetch(
            `${NOISE_BASE_URL}/collections/${LDEN_COLLECTION}/items?${params.toString()}`
        );

        if (!response.ok) {
            throw new Error(`Could not load Hamburg noise data (HTTP ${response.status}).`);
        }

        const data = await response.json();
        renderNoiseMap(data);
    } catch (error) {
        clearMapLayer();
    }
}

function clearMapLayer() {
    if (map && activeLayer) {
        map.removeLayer(activeLayer);
    }
    activeLayer = null;

    if (map && legendControl) {
        map.removeControl(legendControl);
    }
    legendControl = null;
}

function renderWeatherMap(stations) {
    if (!map) return;

    if (stations.length === 0) return;

    activeLayer = L.featureGroup(
        stations.map((station) => {
            const marker = L.circleMarker([station.lat, station.lon], {
                radius: 8,
                color: "#ffffff",
                weight: 1.2,
                fillColor: getTemperatureColor(station.temperature),
                fillOpacity: 0.9
            });

            marker.bindPopup(
                `<strong>${station.city}</strong><br/>` +
                    `<strong>Street:</strong> ${station.street}<br/>` +
                    `<strong>Temperature:</strong> ${formatValue(station.temperature, "°C")}<br/>` +
                    `<strong>Humidity:</strong> ${formatValue(station.humidity, "%")}<br/>` +
                    `<strong>Pressure:</strong> ${formatValue(station.pressure, "mbar")}<br/>` +
                    `<strong>Rain (24h):</strong> ${formatValue(station.rain24h, "mm")}<br/>` +
                    `<strong>Wind:</strong> ${formatValue(station.windStrength, "km/h")}<br/>` +
                    `<strong>Updated:</strong> ${new Date(station.timestamp * 1000).toLocaleString()}`
            );

            return marker;
        })
    ).addTo(map);

    updateWeatherLegend();

    const bounds = activeLayer.getBounds();
    if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.05), { maxZoom: 14 });
    }
}

function renderNoiseMap(data) {
    if (!map) return;

    const features = data?.features ?? [];
    const mapFeatures = features.filter((feature) => feature?.geometry);

    if (mapFeatures.length === 0) return;

    activeLayer = L.geoJSON(
        {
            type: "FeatureCollection",
            features: mapFeatures
        },
        {
            style: (feature) => {
                const klasse = feature?.properties?.klasse ?? "Unknown";
                return {
                    color: "#ffffff",
                    weight: 0.6,
                    fillColor: getKlasseColor(klasse),
                    fillOpacity: 0.75
                };
            },
            onEachFeature: (feature, layer) => {
                const klasse = feature?.properties?.klasse ?? "Unknown";
                layer.bindPopup(`<strong>Noise class:</strong> ${klasse}<br/><strong>Mode:</strong> Lden`);
            }
        }
    ).addTo(map);

    updateNoiseLegend(mapFeatures);

    const bounds = activeLayer.getBounds();
    if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.05), { maxZoom: 14 });
    }
}


async function handlePointSelection(lat, lon) {
    if (!map) return;

    if (!isWithinBounds(lat, lon)) {
        renderQueryError("Selected coordinates are outside the configured Hamburg bounds.");
        return;
    }

    placeQueryMarker(lat, lon);
    showLoadingOutput("Loading noise and nearest weather data for selected marker...");

    try {
        const [noiseInfo, weatherSelection, cityTemperatureStats] = await Promise.all([
            fetchNoiseInfoForPoint(lat, lon),
            buildWeatherSelectionForPoint(lat, lon),
            fetchAverageCityTemperature(lat, lon).catch(() => null)
        ]);

        renderPointResults(lat, lon, noiseInfo, weatherSelection, cityTemperatureStats);
    } catch (error) {
        renderQueryError(error instanceof Error ? error.message : "Failed to load marker data.");
    }
}

function placeQueryMarker(lat, lon) {
    if (!map) return;

    if (queryMarker) {
        map.removeLayer(queryMarker);
    }

    queryMarker = L.marker([lat, lon]).addTo(map);
    queryMarker.bindPopup(`<strong>Selected marker</strong><br/>Lat: ${lat.toFixed(5)}<br/>Lon: ${lon.toFixed(5)}`);
    queryMarker.openPopup();
    map.panTo([lat, lon]);
}

async function fetchNoiseInfoForPoint(lat, lon) {
    const delta = 0.0007;
    const params = new URLSearchParams({
        f: "json",
        limit: "300",
        bbox: `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`
    });

    const response = await fetch(
        `${NOISE_BASE_URL}/collections/${LDEN_COLLECTION}/items?${params.toString()}`
    );

    if (!response.ok) {
        throw new Error(`Could not load point noise data (HTTP ${response.status}).`);
    }

    const data = await response.json();
    const features = data?.features ?? [];
    if (features.length === 0) {
        return { klasse: null, distanceKm: null };
    }

    const point = { lat, lon };
    const containingFeature = features.find((feature) => isPointInsideGeometry(point, feature?.geometry));

    if (containingFeature) {
        return {
            klasse: containingFeature?.properties?.klasse ?? null,
            distanceKm: 0
        };
    }

    const nearest = features
        .map((feature) => {
            const center = geometryCenter(feature?.geometry);
            if (!center) return null;
            return {
                klasse: feature?.properties?.klasse ?? null,
                distanceKm: haversineDistanceKm(lat, lon, center.lat, center.lon)
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.distanceKm - b.distanceKm)[0];

    return nearest ?? { klasse: null, distanceKm: null };
}

async function buildWeatherSelectionForPoint(lat, lon) {
    const stations = await fetchWeatherStationsWithinRadius(lat, lon, NETATMO_RADIUS_KM);

    if (stations.length === 0) {
        return {
            usedStations: [],
            totalStationsUsed: 0,
            metricStationCounts: {
                temperature: 0,
                humidity: 0,
                windStrength: 0,
                rain24h: 0
            },
            combined: {
                temperature: null,
                windStrength: null,
                rain24h: null,
                humidity: null
            }
        };
    }

    const sortedByDistance = [...stations].sort((a, b) => a.distanceKm - b.distanceKm);
    const stationsByMetric = {
        temperature: selectStationsForMetric(sortedByDistance, "temperature"),
        humidity: selectStationsForMetric(sortedByDistance, "humidity"),
        windStrength: selectStationsForMetric(sortedByDistance, "windStrength"),
        rain24h: selectStationsForMetric(sortedByDistance, "rain24h")
    };

    const allUsedStations = WEATHER_METRICS.flatMap((metric) => stationsByMetric[metric]);
    const uniqueStationsById = new Map(allUsedStations.map((station) => [station.id, station]));
    const usedStations = [...uniqueStationsById.values()].sort((a, b) => a.distanceKm - b.distanceKm);

    const metricStationCounts = {
        temperature: stationsByMetric.temperature.length,
        humidity: stationsByMetric.humidity.length,
        windStrength: stationsByMetric.windStrength.length,
        rain24h: stationsByMetric.rain24h.length
    };

    return {
        usedStations: usedStations.slice(0, NETATMO_NEAREST_COUNT),
        totalStationsUsed: usedStations.length,
        metricStationCounts,
        combined: {
            temperature: computeWeightedMetric(stationsByMetric.temperature, "temperature"),
            humidity: computeWeightedMetric(stationsByMetric.humidity, "humidity"),
            windStrength: computeWeightedMetric(stationsByMetric.windStrength, "windStrength"),
            rain24h: computeWeightedMetric(stationsByMetric.rain24h, "rain24h")
        }
    };
}

async function fetchAverageCityTemperature(lat, lon) {
    const samplePoints = getHamburgTemperatureSamplePoints();
    const temperatureSamples = await Promise.all(
        samplePoints.map((point) => fetchCurrentTemperatureAtPoint(point.lat, point.lon).catch(() => null))
    );

    const numericSamples = temperatureSamples.filter(Number.isFinite);
    if (numericSamples.length === 0) {
        throw new Error("Open-Meteo did not return current temperatures for Hamburg sample points.");
    }

    const averageCityTemperature =
        numericSamples.reduce((sum, value) => sum + value, 0) / numericSamples.length;
    const tempDifference = Math.abs(TEMP_OPTIMAL_C - averageCityTemperature);

    return {
        averageCityTemperature,
        tempDifference,
        samplePointsUsed: numericSamples.length,
        samplePointsTotal: samplePoints.length
    };
}

function getHamburgTemperatureSamplePoints() {
    const [southWest, northEast] = HAMBURG_BOUNDS;
    const latMin = southWest[0];
    const lonMin = southWest[1];
    const latMax = northEast[0];
    const lonMax = northEast[1];

    const centerLat = (latMin + latMax) / 2;
    const centerLon = (lonMin + lonMax) / 2;

    const points = [
        { lat: centerLat, lon: centerLon },
        { lat: latMin, lon: lonMin },
        { lat: latMin, lon: lonMax },
        { lat: latMax, lon: lonMin },
        { lat: latMax, lon: lonMax }
    ];

    return points.slice(0, CITY_AVERAGE_SAMPLE_POINT_COUNT);
}

async function fetchCurrentTemperatureAtPoint(lat, lon) {
    const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        current: "temperature_2m",
        timezone: "auto"
    });

    const response = await fetch(`${OPEN_METEO_BASE_URL}?${params.toString()}`);
    if (!response.ok) {
        throw new Error(`Could not load Open-Meteo current data (HTTP ${response.status}).`);
    }

    const data = await response.json();
    const currentTemperature = data?.current?.temperature_2m;

    if (!Number.isFinite(currentTemperature)) {
        throw new Error("Open-Meteo response did not include current temperature.");
    }

    return currentTemperature;
}

function selectStationsForMetric(sortedStations, metricName) {
    const metricStations = sortedStations.filter((station) => Number.isFinite(station?.[metricName]));
    if (metricStations.length === 0) return [];

    const nearestDistanceKm = metricStations[0].distanceKm;
    const maxAcceptedDistanceKm = nearestDistanceKm * NETATMO_NEAREST_DISTANCE_FACTOR;

    return metricStations.filter((station, index) => {
        if (index === 0) return true;
        return station.distanceKm <= maxAcceptedDistanceKm;
    });
}

function computeWeightedMetric(stations, metricName) {
    let weightedSum = 0;
    let totalWeight = 0;

    stations.forEach((station) => {
        const value = station?.[metricName];
        if (!Number.isFinite(value)) return;

        const distance = Math.max(station.distanceKm, DISTANCE_WEIGHT_MIN_KM);
        const weight = 1 / distance;
        weightedSum += value * weight;
        totalWeight += weight;
    });

    if (totalWeight === 0) return null;
    return weightedSum / totalWeight;
}

async function fetchWeatherStationsWithinRadius(lat, lon, radiusKm) {
    if (!ACCESS_TOKEN) {
        throw new Error("Missing Netatmo access token in src/api-key.js.");
    }

    const bbox = getBoundingBoxForRadius(lat, lon, radiusKm);

    const params = new URLSearchParams({
        lat_ne: String(bbox.latNe),
        lon_ne: String(bbox.lonNe),
        lat_sw: String(bbox.latSw),
        lon_sw: String(bbox.lonSw),
        required_data: "temperature",
        filter: "false"
    });

    const response = await fetch(`${WEATHER_BASE_URL}?${params.toString()}`, {
        headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`
        }
    });

    if (!response.ok) {
        throw new Error(`Could not load Netatmo data (HTTP ${response.status}).`);
    }

    const data = await response.json();
    return extractPublicWeatherStations(data?.body ?? [])
        .map((station) => ({
            ...station,
            distanceKm: haversineDistanceKm(lat, lon, station.lat, station.lon)
        }))
        .filter((station) => station.distanceKm <= radiusKm);
}

function getWeatherFocusPoint() {
    if (queryMarker) {
        const markerPosition = queryMarker.getLatLng();
        return { lat: markerPosition.lat, lon: markerPosition.lng };
    }

    const center = map?.getCenter();
    return {
        lat: center?.lat ?? DEFAULT_CENTER[0],
        lon: center?.lng ?? DEFAULT_CENTER[1]
    };
}

function renderPointResults(lat, lon, noiseInfo, weatherSelection, cityTemperatureStats) {
    const output = document.getElementById("output");
    if (!output) return;

    const noiseClass = noiseInfo?.klasse ?? "n/a";
    const noiseDistanceText = Number.isFinite(noiseInfo?.distanceKm)
        ? `${noiseInfo.distanceKm.toFixed(3)} km`
        : "n/a";

    const usedStations = weatherSelection?.usedStations ?? [];
    const totalStationsUsed = weatherSelection?.totalStationsUsed ?? 0;
    const metricStationCounts = weatherSelection?.metricStationCounts ?? {};
    const combined = weatherSelection?.combined ?? {};
    const spotScores = buildSpotScores(noiseInfo, combined, cityTemperatureStats);

    const stationRows = usedStations.length
        ? usedStations
              .map(
                  (station, index) => `
                    <li>
                        <strong>#${index + 1} ${station.street ?? station.city ?? "Unknown station"}</strong>
                        <span>${station.distanceKm.toFixed(3)} km</span>
                        <div>Temp: ${formatValue(station.temperature, "°C")} · Humidity: ${formatValue(station.humidity, "%")} · Wind: ${formatValue(station.windStrength, "km/h")} · Rain: ${formatValue(station.rain24h, "mm")}</div>
                    </li>
                `
              )
              .join("")
        : "<li><strong>No nearby stations found</strong></li>";

    output.innerHTML = `
        <h3>Marker Data</h3>
        <p><strong>Coordinates:</strong> ${lat.toFixed(5)}, ${lon.toFixed(5)}</p>
        <h4>Nearest Lden Noise Information</h4>
        <ul class="klasse-list">
            <li><strong>Noise class</strong><span>${noiseClass}</span></li>
            <li><strong>Distance to matched feature</strong><span>${noiseDistanceText}</span></li>
        </ul>
        <h4>Nearest Netatmo Stations</h4>
        <p><strong>Total stations used (distance weighted):</strong> ${totalStationsUsed}</p>
    <p><strong>Stations used by metric:</strong> Temp ${metricStationCounts.temperature ?? 0}, Humidity ${metricStationCounts.humidity ?? 0}, Wind ${metricStationCounts.windStrength ?? 0}, Rain ${metricStationCounts.rain24h ?? 0}</p>
        <ul class="klasse-list station-list">${stationRows}</ul>
        <h4>Combined Weather (distance weighted)</h4>
        <ul class="klasse-list">
            <li><strong>Temperature</strong><span>${formatValue(combined.temperature, "°C")}</span></li>
            <li><strong>Humidity</strong><span>${formatValue(combined.humidity, "%")}</span></li>
            <li><strong>Wind</strong><span>${formatValue(combined.windStrength, "km/h")}</span></li>
            <li><strong>Rain (24h)</strong><span>${formatValue(combined.rain24h, "mm")}</span></li>
            <li><strong>Open-Meteo current Hamburg average temp (${cityTemperatureStats?.samplePointsUsed ?? 0}/${cityTemperatureStats?.samplePointsTotal ?? 0} points)</strong><span>${formatValue(cityTemperatureStats?.averageCityTemperature, "°C")}</span></li>
            <li><strong>Temp difference to optimal (${TEMP_OPTIMAL_C}°C)</strong><span>${formatValue(cityTemperatureStats?.tempDifference, "°C")}</span></li>
        </ul>
        <h4>Spot Scores (0.1–10)</h4>
        <ul class="klasse-list">
            <li><strong>Noise</strong><span class="score-value">${formatScore(spotScores.noise)}</span></li>
            <li><strong>Temperature</strong><span class="score-value">${formatScore(spotScores.temperature)}</span></li>
            <li><strong>Humidity</strong><span class="score-value">${formatScore(spotScores.humidity)}</span></li>
            <li><strong>Wind</strong><span class="score-value">${formatScore(spotScores.wind)}</span></li>
            <li><strong>Rain</strong><span class="score-value">${formatScore(spotScores.rain)}</span></li>
            <li><strong>General spot score</strong><span class="score-value is-general">${formatScore(spotScores.general)}</span></li>
        </ul>
    `;

    showOutput();
}

function showLoadingOutput(message) {
    const output = document.getElementById("output");
    if (!output) return;
    output.innerHTML = `<div class='loading'>${message}</div>`;
    showOutput();
}

function renderQueryError(message) {
    const output = document.getElementById("output");
    if (!output) return;
    output.innerHTML = `<div class='error'>${message}</div>`;
    showOutput();
}

function hideOutput() {
    const output = document.getElementById("output");
    if (!output) return;
    output.classList.add("is-hidden");
    output.innerHTML = "";
}

function showOutput() {
    const output = document.getElementById("output");
    if (!output) return;
    output.classList.remove("is-hidden");
}

function syncCoordinateInputs(lat, lon) {
    const latitudeInput = document.getElementById("latitudeInput");
    const longitudeInput = document.getElementById("longitudeInput");
    if (latitudeInput) latitudeInput.value = String(lat.toFixed(6));
    if (longitudeInput) longitudeInput.value = String(lon.toFixed(6));
}

function isValidCoordinates(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon);
}

function isWithinBounds(lat, lon) {
    return (
        lat >= HAMBURG_BOUNDS[0][0] &&
        lat <= HAMBURG_BOUNDS[1][0] &&
        lon >= HAMBURG_BOUNDS[0][1] &&
        lon <= HAMBURG_BOUNDS[1][1]
    );
}

function extractPublicWeatherStations(rawStations) {
    return rawStations
        .map((station) => {
            const location = station?.place?.location;
            if (!Array.isArray(location) || location.length < 2) return null;

            const [lon, lat] = location;
            const city = station?.place?.city ?? "Unknown city";

            const weather = extractStationWeather(station?.measures ?? {});
            if (!weather || !Number.isFinite(weather.temperature)) return null;

            return {
                id: station?._id ?? `${lon}-${lat}`,
                lat,
                lon,
                city,
                street: station?.place?.street ?? "Unknown street",
                ...weather
            };
        })
        .filter(Boolean);
}

function extractStationWeather(measures) {
    let temperature;
    let humidity;
    let pressure;
    let rain24h;
    let windStrength;
    let timestamp = 0;

    for (const value of Object.values(measures)) {
        const types = value?.type;
        const res = value?.res;

        if (Array.isArray(types) && res && typeof res === "object") {
            const [latestTs, latestValues] = Object.entries(res).sort((a, b) => Number(b[0]) - Number(a[0]))[0] ?? [];

            if (latestTs && Array.isArray(latestValues)) {
                timestamp = Math.max(timestamp, Number(latestTs));

                types.forEach((type, index) => {
                    const measureValue = latestValues[index];
                    if (type === "temperature" && Number.isFinite(measureValue)) temperature = measureValue;
                    if (type === "humidity" && Number.isFinite(measureValue)) humidity = measureValue;
                    if (type === "pressure" && Number.isFinite(measureValue)) pressure = measureValue;
                });
            }
        }

        if (Number.isFinite(value?.rain_24h)) rain24h = value.rain_24h;
        if (Number.isFinite(value?.wind_strength)) windStrength = value.wind_strength;

        if (Number.isFinite(value?.rain_timeutc)) {
            timestamp = Math.max(timestamp, value.rain_timeutc);
        }

        if (Number.isFinite(value?.wind_timeutc)) {
            timestamp = Math.max(timestamp, value.wind_timeutc);
        }
    }

    if (!Number.isFinite(temperature)) return null;

    return {
        temperature,
        humidity,
        pressure,
        rain24h,
        windStrength,
        timestamp
    };
}

function getTemperatureColor(temperature) {
    if (!Number.isFinite(temperature)) return "#9ca3af";
    if (temperature <= 0) return "#1d4ed8";
    if (temperature <= 5) return "#3b82f6";
    if (temperature <= 10) return "#06b6d4";
    if (temperature <= 15) return "#22c55e";
    if (temperature <= 20) return "#f59e0b";
    return "#ef4444";
}

function parseLowerDbBound(klasseLabel) {
    const lowerBoundMatch = klasseLabel.match(/(\d+)\s*-\s*\d+/);
    if (lowerBoundMatch) return Number(lowerBoundMatch[1]);

    const atLeastMatch = klasseLabel.match(/>=\s*(\d+)/);
    if (atLeastMatch) return Number(atLeastMatch[1]);

    return 0;
}

function getKlasseColor(klasseLabel) {
    const lowerDb = parseLowerDbBound(klasseLabel);

    if (lowerDb >= 75) return "#7f0000";
    if (lowerDb >= 70) return "#b30000";
    if (lowerDb >= 65) return "#e34a33";
    if (lowerDb >= 60) return "#fc8d59";
    if (lowerDb >= 55) return "#fdbb84";
    return "#fee8c8";
}

function updateWeatherLegend() {
    if (!map) return;

    if (legendControl) {
        map.removeControl(legendControl);
    }

    legendControl = L.control({ position: "bottomright" });
    legendControl.onAdd = () => {
        const div = L.DomUtil.create("div", "map-legend");
        div.innerHTML = `
            <h4>Temperature scale</h4>
            <div class="legend-item"><span class="legend-color" style="background:#1d4ed8"></span>≤ 0°C</div>
            <div class="legend-item"><span class="legend-color" style="background:#3b82f6"></span>1–5°C</div>
            <div class="legend-item"><span class="legend-color" style="background:#06b6d4"></span>6–10°C</div>
            <div class="legend-item"><span class="legend-color" style="background:#22c55e"></span>11–15°C</div>
            <div class="legend-item"><span class="legend-color" style="background:#f59e0b"></span>16–20°C</div>
            <div class="legend-item"><span class="legend-color" style="background:#ef4444"></span>> 20°C</div>
        `;
        return div;
    };

    legendControl.addTo(map);
}

function updateNoiseLegend(features) {
    if (!map) return;

    if (legendControl) {
        map.removeControl(legendControl);
    }

    const classes = [...new Set(features.map((feature) => feature?.properties?.klasse ?? "Unknown"))]
        .sort((a, b) => parseLowerDbBound(a) - parseLowerDbBound(b));

    legendControl = L.control({ position: "bottomright" });
    legendControl.onAdd = () => {
        const div = L.DomUtil.create("div", "map-legend");
        div.innerHTML = `
            <h4>Lden dB(A) levels</h4>
            ${classes
                .map(
                    (klasse) =>
                        `<div class="legend-item"><span class="legend-color" style="background:${getKlasseColor(klasse)}"></span>${klasse}</div>`
                )
                .join("")}
        `;
        return div;
    };

    legendControl.addTo(map);
}

function formatValue(value, unit) {
    if (!Number.isFinite(value)) return "n/a";
    return `${value.toFixed(1)} ${unit}`;
}

function formatScore(value) {
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(1);
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
    const earthRadiusKm = 6371;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
}

function toRadians(value) {
    return (value * Math.PI) / 180;
}

function getBoundingBoxForRadius(lat, lon, radiusKm) {
    const latDelta = radiusKm / 111;
    const safeCos = Math.max(Math.cos(toRadians(lat)), 0.01);
    const lonDelta = radiusKm / (111 * safeCos);

    return {
        latNe: lat + latDelta,
        lonNe: lon + lonDelta,
        latSw: lat - latDelta,
        lonSw: lon - lonDelta
    };
}

function geometryCenter(geometry) {
    const coords = geometry?.coordinates;
    if (!coords) return null;

    const points = flattenGeometryCoordinates(geometry);
    if (points.length === 0) return null;

    const sums = points.reduce(
        (acc, [lon, lat]) => {
            acc.lat += lat;
            acc.lon += lon;
            return acc;
        },
        { lat: 0, lon: 0 }
    );

    return {
        lat: sums.lat / points.length,
        lon: sums.lon / points.length
    };
}

function flattenGeometryCoordinates(geometry) {
    if (!geometry) return [];
    if (geometry.type === "Point") return [geometry.coordinates];
    if (geometry.type === "Polygon") return geometry.coordinates.flat();
    if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(2);
    return [];
}

function isPointInsideGeometry(point, geometry) {
    if (!geometry) return false;
    if (geometry.type === "Polygon") {
        return isPointInsidePolygon(point, geometry.coordinates[0]);
    }

    if (geometry.type === "MultiPolygon") {
        return geometry.coordinates.some((polygon) => isPointInsidePolygon(point, polygon[0]));
    }

    return false;
}

function isPointInsidePolygon(point, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    const x = point.lon;
    const y = point.lat;
    let isInside = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];

        const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersects) isInside = !isInside;
    }

    return isInside;
}
