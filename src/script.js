import { buildSpotScores, TEMP_OPTIMAL_C } from "./utils.js";
import { fetchAddressSuggestions, fetchPointSelectionData } from "./data-api.js";

const DEFAULT_CENTER = [53.5511, 9.9937];
const DEFAULT_ZOOM = 11;
const MIN_ZOOM = 10;
const MAX_ZOOM = 16;
const ADDRESS_SEARCH_MIN_CHARS = 3;
const ADDRESS_SEARCH_LIMIT = 5;
const ADDRESS_SEARCH_DEBOUNCE_MS = 250;
const HAMBURG_BOUNDS = [
    [53.41062884725186, 9.732240484945219],
    [53.72838568700598, 10.29272015751267]
];
let map;
let queryMarker;
let usedStationsLayer;
let addressSearchAbortController;
let addressSearchTimeout;

document.addEventListener("DOMContentLoaded", () => {
    const importSpotBtn = document.getElementById("importSpotBtn");

    hideOutput();

    if (importSpotBtn) {
        importSpotBtn.addEventListener("click", () => {
            importSpotFromClipboard();
        });
    }

    setupAddressSearch();

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

function setupAddressSearch() {
    const input = document.getElementById("addressSearchInput");
    const resultsList = document.getElementById("addressSearchResults");

    if (!input || !resultsList) return;

    const triggerSearch = () => {
        const query = input.value.trim();

        if (query.length < ADDRESS_SEARCH_MIN_CHARS) {
            clearAddressSuggestions(resultsList);
            return;
        }

        if (addressSearchTimeout) {
            window.clearTimeout(addressSearchTimeout);
        }

        addressSearchTimeout = window.setTimeout(() => {
            loadAddressSuggestions(query, resultsList, input);
        }, ADDRESS_SEARCH_DEBOUNCE_MS);
    };

    input.addEventListener("input", triggerSearch);
    input.addEventListener("focus", triggerSearch);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            input.value = "";
            clearAddressSuggestions(resultsList);
        }
    });
}

async function loadAddressSuggestions(query, resultsList, input) {
    if (addressSearchAbortController) {
        addressSearchAbortController.abort();
    }

    addressSearchAbortController = new AbortController();

    try {
        const suggestions = await fetchAddressSuggestions(query, {
            limit: ADDRESS_SEARCH_LIMIT,
            signal: addressSearchAbortController.signal
        });

        if (addressSearchAbortController.signal.aborted) return;
        renderAddressSuggestions(resultsList, input, suggestions);
    } catch (error) {
        if (error?.name === "AbortError") return;
        if (!hasVisibleSuggestions(resultsList)) {
            setSuggestionMessage(resultsList, "Unable to load address suggestions.");
        }
    }
}

function renderAddressSuggestions(resultsList, input, suggestions) {
    resultsList.innerHTML = "";

    if (!suggestions.length) {
        setSuggestionMessage(resultsList, "No matches yet.");
        return;
    }

    suggestions.forEach((suggestion) => {
        const listItem = document.createElement("li");
        const button = document.createElement("button");

        button.type = "button";
        button.className = "suggestion-btn";
        button.setAttribute("role", "option");

        const labelSpan = document.createElement("span");
        labelSpan.textContent = suggestion.label;

        const metaSpan = document.createElement("span");
        metaSpan.className = "suggestion-meta";
        metaSpan.textContent = suggestion.typeLabel;

        button.append(labelSpan, metaSpan);
        button.addEventListener("click", () => {
            input.value = suggestion.label;
            clearAddressSuggestions(resultsList);
            handlePointSelection(suggestion.lat, suggestion.lon, { zoomToMax: true });
        });

        listItem.append(button);
        resultsList.append(listItem);
    });

    resultsList.classList.remove("is-hidden");
}

function clearAddressSuggestions(resultsList) {
    resultsList.innerHTML = "";
    resultsList.classList.add("is-hidden");
}

function hasVisibleSuggestions(resultsList) {
    return resultsList.children.length > 0 && !resultsList.classList.contains("is-hidden");
}

function setSuggestionMessage(resultsList, message) {
    resultsList.innerHTML = "";
    const listItem = document.createElement("li");
    listItem.className = "suggestion-message";
    listItem.textContent = message;
    resultsList.append(listItem);
    resultsList.classList.remove("is-hidden");
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

        handlePointSelection(lat, lon, { zoomToMax: true });
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
async function handlePointSelection(lat, lon, options = {}) {
    if (!map) return;

    const { zoomToMax = false } = options;

    if (!isWithinBounds(lat, lon)) {
        renderQueryError("Selected coordinates are outside the configured Hamburg bounds.");
        return;
    }

    clearUsedStationsLayer();
    placeQueryMarker(lat, lon, { zoomToMax });
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

function placeQueryMarker(lat, lon, options = {}) {
    if (!map) return;

    const { zoomToMax = false } = options;

    if (queryMarker) {
        map.removeLayer(queryMarker);
    }

    queryMarker = L.marker([lat, lon]).addTo(map);
    queryMarker.bindPopup(`<strong>Selected marker</strong><br/>Lat: ${lat.toFixed(5)}<br/>Lon: ${lon.toFixed(5)}`);
    queryMarker.openPopup();

    if (zoomToMax) {
        animateZoomToMaxAtSpot(lat, lon);
        return;
    }

    panToVisibleMapCenter(lat, lon);
}

function animateZoomToMaxAtSpot(lat, lon) {
    if (!map) return;

    const targetCenter = getVisibleCenterForSpot(lat, lon, MAX_ZOOM);
    map.flyTo(targetCenter, MAX_ZOOM, {
        animate: true,
        duration: 0.9
    });
}

function panToVisibleMapCenter(lat, lon) {
    if (!map) return;

    const targetCenter = getVisibleCenterForSpot(lat, lon, map.getZoom());
    map.panTo(targetCenter, { animate: true });
}

function getVisibleCenterForSpot(lat, lon, zoomLevel) {
    if (!map) return L.latLng(lat, lon);

    const mapSize = map.getSize();
    const sidebarWidth = getSidebarWidth();

    if (sidebarWidth <= 0) {
        return L.latLng(lat, lon);
    }

    const screenCenter = L.point(mapSize.x / 2, mapSize.y / 2);
    const visibleCenterX = Math.min(mapSize.x - 20, mapSize.x / 2 + sidebarWidth / 2);
    const desiredSpotPoint = L.point(visibleCenterX, mapSize.y / 2);
    const offsetFromCenter = desiredSpotPoint.subtract(screenCenter);

    const spotPointAtZoom = map.project(L.latLng(lat, lon), zoomLevel);
    const targetCenterPoint = spotPointAtZoom.subtract(offsetFromCenter);
    return map.unproject(targetCenterPoint, zoomLevel);
}

function getSidebarWidth() {
    const sidebar = document.querySelector(".app");
    if (!sidebar) return 0;

    const mapSize = map?.getSize();
    if (!mapSize) return 0;

    const sidebarRect = sidebar.getBoundingClientRect();
    return Math.min(sidebarRect.width, Math.max(0, mapSize.x - 20));
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
                color: "#0e4d25",
                weight: 1.5,
                fillColor: "#c0ed55",
                fillOpacity: 0.92
            });

            marker.bindPopup(
                `<strong>Used weather station</strong><br/>` +
                    `${station.street ?? station.city ?? "Unknown station"}<br/>` +
                    `Distance: ${formatDistance(station.distanceKm)}`
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
    const noiseDistanceText = formatDistance(noiseInfo?.distanceKm);

    const usedStations = weatherSelection?.usedStations ?? [];
    const totalStationsUsed = weatherSelection?.totalStationsUsed ?? 0;
    const metricStationCounts = weatherSelection?.metricStationCounts ?? {};
    const combined = weatherSelection?.combined ?? {};
    const spotScores = buildSpotScores(noiseInfo, combined, cityTemperatureStats);
    const generalScoreText = formatScore(spotScores.general);

    const stationRows = usedStations.length
        ? usedStations
              .map(
                  (station, index) => `
                    <li>
                        <div class="station-list__head">
                            <div>
                                <p class="station-list__label">Station #${index + 1}</p>
                                <strong>${station.street ?? station.city ?? "Unknown station"}</strong>
                            </div>
                            <span class="station-list__distance">${formatDistance(station.distanceKm)}</span>
                        </div>
                        <div class="station-metrics">
                            <div class="station-metric">
                                <span>Temperature</span>
                                <strong>${formatValue(station.temperature, "°C")}</strong>
                            </div>
                            <div class="station-metric">
                                <span>Humidity</span>
                                <strong>${formatValue(station.humidity, "%")}</strong>
                            </div>
                            <div class="station-metric">
                                <span>Wind</span>
                                <strong>${formatValue(station.windStrength, "km/h")}</strong>
                            </div>
                            <div class="station-metric">
                                <span>Rain (24h)</span>
                                <strong>${formatValue(station.rain24h, "mm")}</strong>
                            </div>
                        </div>
                    </li>
                `
              )
              .join("")
        : `
            <li>
                <div class="station-list__head">
                    <div>
                        <p class="station-list__label">Stations</p>
                        <strong>No nearby stations found</strong>
                    </div>
                </div>
            </li>
        `;

    output.innerHTML = `
        <div class="result-stack">
            <section class="result-card result-card--hero">
                <div class="hero-meta">
                    <span class="pill">Selected spot</span>
                    <span class="pill pill--accent">Hamburg scoring</span>
                </div>
                <h3>Marker Data</h3>
                <p class="coordinates">${lat.toFixed(5)}, ${lon.toFixed(5)}</p>
                <div class="quick-stats">
                    <div class="quick-stat">
                        <span>Noise class</span>
                        <strong>${noiseClass}</strong>
                    </div>
                    <div class="quick-stat">
                        <span>Distance to matched feature</span>
                        <strong>${noiseDistanceText}</strong>
                    </div>
                </div>
            </section>

            <details class="accordion">
                <summary>
                    <div class="accordion__copy">
                        <p class="accordion__eyebrow">Stations</p>
                        <h4>Nearest used weather stations</h4>
                    </div>
                    <span class="accordion__meta">${totalStationsUsed} used</span>
                </summary>
                <div class="accordion__content">
                    <p class="section-note">Distance-weighted selection by metric: Temp ${metricStationCounts.temperature ?? 0}, Humidity ${metricStationCounts.humidity ?? 0}, Wind ${metricStationCounts.windStrength ?? 0}, Rain ${metricStationCounts.rain24h ?? 0}.</p>
                    <ul class="station-list">${stationRows}</ul>
                </div>
            </details>

            <details class="accordion">
                <summary>
                    <div class="accordion__copy">
                        <p class="accordion__eyebrow">Weather</p>
                        <h4>Combined weather</h4>
                    </div>
                    <span class="accordion__meta">${formatValue(combined.temperature, "°C")}</span>
                </summary>
                <div class="accordion__content">
                    <ul class="stat-list">
                        <li><strong>Temperature</strong><span>${formatValue(combined.temperature, "°C")}</span></li>
                        <li><strong>Humidity</strong><span>${formatValue(combined.humidity, "%")}</span></li>
                        <li><strong>Wind</strong><span>${formatValue(combined.windStrength, "km/h")}</span></li>
                        <li><strong>Rain (24h)</strong><span>${formatValue(combined.rain24h, "mm")}</span></li>
                        <li><strong>Open-Meteo Hamburg average temperature</strong><span>${formatValue(cityTemperatureStats?.averageCityTemperature, "°C")}</span></li>
                        <li><strong>Sample points used</strong><span>${cityTemperatureStats?.samplePointsUsed ?? 0}/${cityTemperatureStats?.samplePointsTotal ?? 0}</span></li>
                        <li><strong>Temp difference to optimal (${TEMP_OPTIMAL_C}°C)</strong><span>${formatValue(cityTemperatureStats?.tempDifference, "°C")}</span></li>
                    </ul>
                </div>
            </details>

            <details class="accordion" open>
                <summary>
                    <div class="accordion__copy">
                        <p class="accordion__eyebrow">Scoring</p>
                        <h4>Spot scores</h4>
                    </div>
                    <span class="accordion__meta">${generalScoreText} / 10</span>
                </summary>
                <div class="accordion__content">
                    <ul class="score-list">
                        <li><strong>Noise</strong><span class="score-value">${formatScore(spotScores.noise)}</span></li>
                        <li><strong>Temperature</strong><span class="score-value">${formatScore(spotScores.temperature)}</span></li>
                        <li><strong>Humidity</strong><span class="score-value">${formatScore(spotScores.humidity)}</span></li>
                        <li><strong>Wind</strong><span class="score-value">${formatScore(spotScores.wind)}</span></li>
                        <li><strong>Rain</strong><span class="score-value">${formatScore(spotScores.rain)}</span></li>
                    </ul>
                </div>
            </details>

            <section class="result-card result-card--score">
                <p class="score-kicker">General spot score</p>
                <div class="score-display">${generalScoreText}</div>
                <p class="score-caption">A combined read across noise, temperature, humidity, wind, and rain for the selected point.</p>
            </section>
        </div>
    `;

    showOutput();
}

function showLoadingOutput(message) {
    const output = document.getElementById("output");
    if (!output) return;
    output.innerHTML = `
        <section class="result-card">
            <p class="loading">${message}</p>
        </section>
    `;
    showOutput();
}

function renderQueryError(message) {
    const output = document.getElementById("output");
    if (!output) return;
    output.innerHTML = `
        <section class="result-card">
            <p class="error">${message}</p>
        </section>
    `;
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

function formatDistance(value) {
    if (!Number.isFinite(value)) return "n/a";
    return `${value.toFixed(3)} km`;
}

function formatScore(value) {
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(1);
}
