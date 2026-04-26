import { buildSpotScores, TEMP_OPTIMAL_C } from "./utils.js";
import {
    fetchNoiseMapData,
    fetchPointSelectionData,
    fetchWeatherStationsWithinRadius
} from "./data-api.js";

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
    clearMapLayer();

    try {
        const focus = getWeatherFocusPoint();
        const stations = await fetchWeatherStationsWithinRadius(focus.lat, focus.lon);
        renderWeatherMap(stations);
    } catch (error) {
        renderQueryError(error instanceof Error ? error.message : "Failed to load weather data.");
        clearMapLayer();
    }
}

async function loadNoiseData() {
    clearMapLayer();

    try {
        const data = await fetchNoiseMapData();
        renderNoiseMap(data);
    } catch (error) {
        renderQueryError(error instanceof Error ? error.message : "Failed to load noise data.");
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
        const { noiseInfo, weatherSelection, cityTemperatureStats } =
            await fetchPointSelectionData(lat, lon, HAMBURG_BOUNDS);

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
