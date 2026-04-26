import { buildSpotScores, TEMP_OPTIMAL_C } from "./utils.js";
import { fetchPointSelectionData } from "./data-api.js";

const DEFAULT_CENTER = [53.5511, 9.9937];
const DEFAULT_ZOOM = 11;
const MIN_ZOOM = 10;
const MAX_ZOOM = 16;
const HAMBURG_BOUNDS = [
    [53.41062884725186, 9.732240484945219],
    [53.72838568700598, 10.29272015751267]
];
let map;
let queryMarker;
let usedStationsLayer;

document.addEventListener("DOMContentLoaded", () => {
    const importSpotBtn = document.getElementById("importSpotBtn");

    hideOutput();

    if (importSpotBtn) {
        importSpotBtn.addEventListener("click", () => {
            importSpotFromClipboard();
        });
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
        handlePointSelection(lat, lng);
    });
}

async function importSpotFromClipboard() {
    if (!navigator?.clipboard?.readText) {
        renderQueryError("Clipboard access is not available in this browser context. Please click on the map to select a spot.");
        return;
    }

    showLoadingOutput("Reading coordinates from clipboard...");

    try {
        const clipboardText = await navigator.clipboard.readText();
        const parsedCoordinates = parseCoordinatesFromClipboard(clipboardText);

        if (!parsedCoordinates) {
            renderQueryError("Could not parse coordinates from clipboard. Use one of: lat,lon · lat;lon · lat lon");
            return;
        }

        const { lat, lon } = parsedCoordinates;

        if (!isValidCoordinates(lat, lon)) {
            renderQueryError("Please provide valid numeric coordinates.");
            return;
        }

        handlePointSelection(lat, lon);
    } catch (error) {
        renderQueryError(error instanceof Error ? `Clipboard import failed: ${error.message}` : "Clipboard import failed.");
    }
}

function parseCoordinatesFromClipboard(rawText) {
    if (typeof rawText !== "string") return null;

    const cleanedText = rawText.trim().replace(/[()\[\]]/g, "");
    if (!cleanedText) return null;

    const match = cleanedText.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match) return null;

    const lat = Number(match[1]);
    const lon = Number(match[2]);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    return { lat, lon };
}
async function handlePointSelection(lat, lon) {
    if (!map) return;

    if (!isWithinBounds(lat, lon)) {
        renderQueryError("Selected coordinates are outside the configured Hamburg bounds.");
        return;
    }

    clearUsedStationsLayer();
    placeQueryMarker(lat, lon);
    showLoadingOutput("Loading noise and nearest weather data for selected marker...");

    try {
        const { noiseInfo, weatherSelection, cityTemperatureStats } =
            await fetchPointSelectionData(lat, lon, HAMBURG_BOUNDS);

        renderUsedStationsOnMap(weatherSelection?.usedStations ?? []);
        renderPointResults(lat, lon, noiseInfo, weatherSelection, cityTemperatureStats);
    } catch (error) {
        clearUsedStationsLayer();
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

function clearUsedStationsLayer() {
    if (!map || !usedStationsLayer) return;
    map.removeLayer(usedStationsLayer);
    usedStationsLayer = null;
}

function renderUsedStationsOnMap(usedStations) {
    if (!map) return;

    clearUsedStationsLayer();

    if (!Array.isArray(usedStations) || usedStations.length === 0) return;

    const stationMarkers = usedStations
        .filter((station) => Number.isFinite(station?.lat) && Number.isFinite(station?.lon))
        .map((station) => {
            const marker = L.circleMarker([station.lat, station.lon], {
                radius: 6,
                color: "#ffffff",
                weight: 1,
                fillColor: "#0f62fe",
                fillOpacity: 0.92
            });

            marker.bindPopup(
                `<strong>Used weather station</strong><br/>` +
                    `${station.street ?? station.city ?? "Unknown station"}<br/>` +
                    `Distance: ${Number.isFinite(station.distanceKm) ? station.distanceKm.toFixed(3) : "n/a"} km`
            );

            return marker;
        });

    if (stationMarkers.length === 0) return;
    usedStationsLayer = L.featureGroup(stationMarkers).addTo(map);
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

function formatValue(value, unit) {
    if (!Number.isFinite(value)) return "n/a";
    return `${value.toFixed(1)} ${unit}`;
}

function formatScore(value) {
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(1);
}
