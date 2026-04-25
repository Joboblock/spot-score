import { ACCESS_TOKEN } from "./api-key.js";

const WEATHER_BASE_URL = "https://api.netatmo.com/api/getpublicdata";
const NOISE_BASE_URL = "https://api.hamburg.de/datasets/v1/strassenverkehr";
const LDEN_COLLECTION = "strassenverkehr_tag_abend_nacht_2022";
const DEFAULT_CENTER = [53.5511, 9.9937];
const DEFAULT_ZOOM = 11;
const MIN_ZOOM = 10;
const MAX_ZOOM = 16;
const HAMBURG_BOUNDS = [
    [53.41062884725186, 9.732240484945219],
    [53.72838568700598, 10.29272015751267]
];
let map;
let activeLayer;
let legendControl;

document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("mapForm");
    const modeSelect = document.getElementById("mapModeSelect");

    if (form) {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            loadSelectedMode();
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
    loadSelectedMode();
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
    const output = document.getElementById("output");

    if (!ACCESS_TOKEN) {
        output.innerHTML = "<div class='error'>Missing Netatmo access token in src/api-key.js.</div>";
        clearMapLayer();
        return;
    }

    output.innerHTML = "<div class='loading'>Loading Netatmo weather stations for Hamburg...</div>";
    clearMapLayer();

    try {
        const params = new URLSearchParams({
            lat_ne: String(HAMBURG_BOUNDS[1][0]),
            lon_ne: String(HAMBURG_BOUNDS[1][1]),
            lat_sw: String(HAMBURG_BOUNDS[0][0]),
            lon_sw: String(HAMBURG_BOUNDS[0][1]),
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
        const hamburgStations = extractHamburgStations(data?.body ?? []);

        renderWeatherResults(hamburgStations);
        renderWeatherMap(hamburgStations);
    } catch (error) {
        output.innerHTML = `<div class='error'>${error instanceof Error ? error.message : "Failed to load weather data."}</div>`;
        clearMapLayer();
    }
}

async function loadNoiseData() {
    const output = document.getElementById("output");
    output.innerHTML = "<div class='loading'>Loading Hamburg Lden noise map...</div>";
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
        renderNoiseResults(data);
        renderNoiseMap(data);
    } catch (error) {
        output.innerHTML = `<div class='error'>${error instanceof Error ? error.message : "Failed to load noise data."}</div>`;
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

function renderWeatherResults(stations) {
    const output = document.getElementById("output");

    if (stations.length === 0) {
        output.innerHTML = "<div class='error'>No public Netatmo stations with weather data found in Hamburg.</div>";
        return;
    }

    const temperatures = stations
        .map((station) => station.temperature)
        .filter((value) => Number.isFinite(value));
    const humidities = stations
        .map((station) => station.humidity)
        .filter((value) => Number.isFinite(value));
    const pressures = stations
        .map((station) => station.pressure)
        .filter((value) => Number.isFinite(value));

    const latestTimestamp = Math.max(...stations.map((station) => station.timestamp));

    const rows = [
        { label: "Temperature (avg)", value: formatValue(average(temperatures), "°C") },
        { label: "Temperature (min)", value: formatValue(Math.min(...temperatures), "°C") },
        { label: "Temperature (max)", value: formatValue(Math.max(...temperatures), "°C") },
        { label: "Humidity (avg)", value: formatValue(average(humidities), "%") },
        { label: "Pressure (avg)", value: formatValue(average(pressures), "mbar") }
    ]
        .map((metric) => `<li><strong>${metric.label}</strong><span>${metric.value}</span></li>`)
        .join("");

    output.innerHTML = `
        <h3>Public Weather Stations in Hamburg</h3>
        <p><strong>Stations shown:</strong> ${stations.length}</p>
        <p><strong>Map mode:</strong> One marker per station, color by temperature</p>
        <ul class="klasse-list">${rows}</ul>
        <p class="timestamp">Latest update: ${new Date(latestTimestamp * 1000).toLocaleString()}</p>
    `;
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

function renderNoiseResults(data) {
    const output = document.getElementById("output");
    const features = data?.features ?? [];

    if (features.length === 0) {
        output.innerHTML = "<div class='error'>No matching Lden noise results found.</div>";
        return;
    }

    const counts = features.reduce((acc, feature) => {
        const klasse = feature?.properties?.klasse ?? "Unknown";
        acc[klasse] = (acc[klasse] ?? 0) + 1;
        return acc;
    }, {});

    const rows = Object.entries(counts)
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([klasse, count]) => `<li><strong>${klasse}</strong><span>${count}</span></li>`)
        .join("");

    output.innerHTML = `
        <h3>Hamburg Lden Noise Map</h3>
        <p><strong>Returned features:</strong> ${data.numberReturned ?? features.length}</p>
        <p><strong>Total matched:</strong> ${data.numberMatched ?? features.length}</p>
        <p><strong>Map mode:</strong> Noise polygons colored by dB class</p>
        <ul class="klasse-list">${rows}</ul>
        <p class="timestamp">Updated: ${formatDate(data.timeStamp)}</p>
    `;
}

function extractHamburgStations(rawStations) {
    return rawStations
        .map((station) => {
            const location = station?.place?.location;
            if (!Array.isArray(location) || location.length < 2) return null;

            const [lon, lat] = location;
            const city = station?.place?.city ?? "Unknown city";
            if (!city.toLowerCase().includes("hamburg")) return null;

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

function average(values) {
    if (values.length === 0) return null;
    const total = values.reduce((sum, value) => sum + value, 0);
    return total / values.length;
}

function formatValue(value, unit) {
    if (!Number.isFinite(value)) return "n/a";
    return `${value.toFixed(1)} ${unit}`;
}

function formatDate(rawValue) {
    const parsedDate = rawValue ? new Date(rawValue) : null;
    if (!parsedDate || Number.isNaN(parsedDate.getTime())) return "n/a";
    return parsedDate.toLocaleString();
}
