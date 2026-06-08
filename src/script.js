import { buildSpotScores, TEMP_OPTIMAL_C } from "./utils.js";
import { computeSunDirection, computeSunExposure } from "./sun-exposure.js";
import {
    enuDirectionToEcef,
    latLonHeightToEcef,
    loadNearbyBuildingData,
    rayIntersectsGltf
} from "./b3dm-viewer.js";
import {
    fetchAddressLabelForCoordinates,
    fetchAddressSuggestions,
    fetchPointSelectionData,
    preloadNoiseData
} from "./data-api.js";

const DEFAULT_CENTER = [53.5511, 9.9937];
const DEFAULT_ZOOM = 11;
const MIN_ZOOM = 10;
const MAX_ZOOM = 18;
const ADDRESS_SEARCH_MIN_CHARS = 3;
const ADDRESS_SEARCH_LIMIT = 5;
const ADDRESS_SEARCH_DEBOUNCE_MS = 250;
const SPOT_HEIGHT_METERS = 1.7;
const URL_PARAM_SPOT = "spot";
const URL_PARAM_SPOT_1 = "spot1";
const URL_PARAM_SPOT_2 = "spot2";
const HAMBURG_BOUNDS = [
    [53.41062884725186, 9.732240484945219],
    [53.72838568700598, 10.29272015751267]
];
let map;
let queryMarker;
let usedStationsLayer;
let buildingTileFootprintsLayer;
let addressSearchAbortController;
let addressSearchTimeout;
let compareModeActive = false;

document.addEventListener("DOMContentLoaded", () => {
    hideOutput();

    setupAddressSearch();
    preloadNoiseData(HAMBURG_BOUNDS).catch(() => null);

    initMap();
    applyInitialSpotFromUrl();
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
    const searchButton = document.querySelector(".search-btn");

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
    const triggerFirstSuggestion = () => {
        const firstSuggestion = resultsList.querySelector(".suggestion-btn");

        if (firstSuggestion) {
            firstSuggestion.click();
            return;
        }

        attemptCoordinateFallback(input.value, resultsList);
    };

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            triggerFirstSuggestion();
            return;
        }

        if (event.key === "Escape") {
            input.value = "";
            clearAddressSuggestions(resultsList);
        }
    });

    if (searchButton) {
        searchButton.addEventListener("click", triggerFirstSuggestion);
    }
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
        if (!attemptCoordinateFallback(input.value, resultsList)) {
            setSuggestionMessage(resultsList, "No matches yet.");
        }
        return;
    }

    suggestions.forEach((suggestion) => {
        const listItem = document.createElement("li");
        const button = document.createElement("button");

        button.type = "button";
        button.className = "suggestion-btn";
        button.setAttribute("role", "option");

        const iconSpan = document.createElement("span");
        iconSpan.className = "suggestion-icon";

        const contentWrapper = document.createElement("span");
        contentWrapper.className = "suggestion-content";

        const labelSpan = document.createElement("span");
        labelSpan.className = "suggestion-title";
        labelSpan.textContent = suggestion.label;

        const metaSpan = document.createElement("span");
        metaSpan.className = "suggestion-meta";
        metaSpan.textContent = suggestion.typeLabel;

        contentWrapper.append(labelSpan, metaSpan);
        button.append(iconSpan, contentWrapper);
        button.addEventListener("click", () => {
            input.value = suggestion.label;
            clearAddressSuggestions(resultsList);
            handlePointSelection(suggestion.lat, suggestion.lon, {
                zoomToMax: true,
                addressLabel: suggestion.label
            });
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

function hideAppHeader() {
    const header = document.querySelector(".app-header");

    if (header) {
        header.classList.add("is-hidden");
    }
}

function parseCoordinatesFromInput(rawText) {
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

function parseSpotParam(paramValue) {
    if (!paramValue) return null;
    const parsed = parseCoordinatesFromInput(paramValue);
    if (!parsed) return null;
    if (!isValidCoordinates(parsed.lat, parsed.lon)) return null;
    if (!isWithinBounds(parsed.lat, parsed.lon)) return null;
    return parsed;
}

function formatSpotParam(lat, lon) {
    return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

function getUrlSpots() {
    const params = new URLSearchParams(window.location.search);
    const spot = parseSpotParam(params.get(URL_PARAM_SPOT));
    const spot1 = parseSpotParam(params.get(URL_PARAM_SPOT_1));
    const spot2 = parseSpotParam(params.get(URL_PARAM_SPOT_2));

    const singleSpot = spot ?? (spot1 && !spot2 ? spot1 : null);

    return {
        spot: singleSpot,
        spot1,
        spot2,
        hasCompare: Boolean(spot1 && spot2)
    };
}

function updateUrlWithSpots({ spot = null, spot1 = null, spot2 = null } = {}) {
    const params = new URLSearchParams(window.location.search);
    [URL_PARAM_SPOT, URL_PARAM_SPOT_1, URL_PARAM_SPOT_2].forEach((param) => params.delete(param));

    if (spot1 && spot2) {
        params.set(URL_PARAM_SPOT_1, formatSpotParam(spot1.lat, spot1.lon));
        params.set(URL_PARAM_SPOT_2, formatSpotParam(spot2.lat, spot2.lon));
    } else if (spot) {
        params.set(URL_PARAM_SPOT, formatSpotParam(spot.lat, spot.lon));
    }

    const queryString = params.toString();
    const nextUrl = `${window.location.pathname}${queryString ? `?${queryString}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
}

function applyInitialSpotFromUrl() {
    if (!window?.location) return;
    const { spot, hasCompare } = getUrlSpots();
    if (hasCompare || !spot) return;
    handlePointSelection(spot.lat, spot.lon, { zoomToMax: true, skipUrlUpdate: true });
}

function attemptCoordinateFallback(rawInput, resultsList) {
    const parsedCoordinates = parseCoordinatesFromInput(rawInput);

    if (!parsedCoordinates) {
        return false;
    }

    const { lat, lon } = parsedCoordinates;

    if (!isValidCoordinates(lat, lon)) {
        if (resultsList) {
            setSuggestionMessage(resultsList, "Coordinates are outside the supported range.");
        }
        return true;
    }

    clearAddressSuggestions(resultsList);
    handlePointSelection(lat, lon, { zoomToMax: true });
    return true;
}
async function handlePointSelection(lat, lon, options = {}) {
    if (!map) return;

    const { zoomToMax = false, addressLabel = null, skipUrlUpdate = false } = options;

    if (!isWithinBounds(lat, lon)) {
        renderQueryError("Selected coordinates are outside the configured Hamburg bounds.");
        return;
    }

    hideAppHeader();

    if (!skipUrlUpdate && !compareModeActive) {
        updateUrlWithSpots({ spot: { lat, lon } });
    }

    const exposureNow = new Date();
    const sunDirection = computeSunDirection(lat, lon, exposureNow);
    const rayDirectionWorld = sunDirection ? enuDirectionToEcef(sunDirection, lat, lon) : null;
    const buildingDataPromise = loadNearbyBuildingData(lat, lon, {
        debug: true,
        ray: rayDirectionWorld
            ? {
                  origin: latLonHeightToEcef(lat, lon, SPOT_HEIGHT_METERS),
                  direction: rayDirectionWorld
              }
            : null,
        rayOptions: { maxTriangles: 800000 }
    }).catch((error) => {
        console.warn("[b3dm] Unexpected error while loading building data", error);
        const emptyResult = [];
        Object.defineProperty(emptyResult, "debugSummary", {
            value: {
                selectionMode: "error",
                requested: 0,
                loaded: 0,
                requestedTiles: [],
                error: error instanceof Error ? error.message : String(error)
            },
            configurable: true,
            enumerable: false,
            writable: true
        });
        return emptyResult;
    });

    clearUsedStationsLayer();
    clearBuildingTileFootprintsLayer();
    placeQueryMarker(lat, lon, { zoomToMax, addressLabel });
    showLoadingOutput("Loading noise and nearest weather data for selected marker...");

    try {
        const [pointSelection, buildingData] = await Promise.all([
            fetchPointSelectionData(lat, lon, HAMBURG_BOUNDS),
            buildingDataPromise
        ]);

        const { noiseInfo, weatherSelection, cityTemperatureStats, airQualityInfo } = pointSelection;

        renderUsedStationsOnMap(weatherSelection?.usedStations ?? []);
        renderBuildingTileFootprints(buildingData);
        renderPointResults(
            lat,
            lon,
            noiseInfo ?? { klasse: null, distanceKm: null },
            weatherSelection ?? {
                usedStations: [],
                totalStationsUsed: 0,
                metricStationCounts: {},
                combined: {}
            },
            cityTemperatureStats,
            airQualityInfo ?? { pm10: null, pm25: null, usedSensors: 0, nearestDistanceKm: null },
            buildingData
        );
    } catch (error) {
        clearUsedStationsLayer();
        clearBuildingTileFootprintsLayer();
        renderQueryError(error instanceof Error ? error.message : "Failed to load marker data.");
    }
}

window.__spotScoreApp = {
    handlePointSelection,
    updateUrlWithSpots,
    getUrlSpots,
    setCompareMode: (value) => {
        compareModeActive = Boolean(value);
    }
};

function placeQueryMarker(lat, lon, options = {}) {
    if (!map) return;

    const { zoomToMax = false, addressLabel = null } = options;

    if (queryMarker) {
        map.removeLayer(queryMarker);
    }

    queryMarker = L.marker([lat, lon]).addTo(map);
    queryMarker.bindPopup(buildMarkerPopupHtml(addressLabel ?? "Loading...", lat, lon));
    queryMarker.openPopup();

    if (!addressLabel) {
        updateMarkerAddressFromLookup(queryMarker, lat, lon);
    }

    if (zoomToMax) {
        animateZoomToMaxAtSpot(lat, lon);
        return;
    }

    panToVisibleMapCenter(lat, lon);
}

function buildMarkerPopupHtml(addressLabel, lat, lon) {
    return `<strong>${addressLabel}</strong><br/>Lat: ${lat.toFixed(5)}<br/>Lon: ${lon.toFixed(5)}`;
}

async function updateMarkerAddressFromLookup(marker, lat, lon) {
    const resolvedLabel = await fetchAddressLabelForCoordinates(lat, lon);

    if (!resolvedLabel || marker !== queryMarker) return;

    marker.setPopupContent(buildMarkerPopupHtml(resolvedLabel, lat, lon));
    updateSpotNameInOutput(resolvedLabel, lat, lon);
}

function updateSpotNameInOutput(spotName, lat, lon) {
    const output = document.getElementById("output");
    if (!output) return;

    const heroCard = output.querySelector(".result-card--hero");
    if (!heroCard) return;

    const coordEl = heroCard.querySelector(".coordinates");
    if (!coordEl) return;

    const expectedCoords = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    if (coordEl.textContent?.trim() !== expectedCoords) return;

    const heading = heroCard.querySelector("h3");
    if (heading) {
        heading.textContent = spotName;
    }
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

function clearBuildingTileFootprintsLayer() {
    if (!map || !buildingTileFootprintsLayer) return;
    map.removeLayer(buildingTileFootprintsLayer);
    buildingTileFootprintsLayer = null;
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

function renderBuildingTileFootprints(buildingData) {
    if (!map) return;

    clearBuildingTileFootprintsLayer();

    if (!Array.isArray(buildingData) || buildingData.length === 0) return;

    const footprintLayers = buildingData.flatMap((tile, index) => {
        const color = getTileDebugColor(index);
        const buildingFootprints = Array.isArray(tile?.buildingFootprints) ? tile.buildingFootprints : [];
        const layers = [];

        if (buildingFootprints.length > 0) {
            buildingFootprints.forEach((buildingFootprint, buildingIndex) => {
                const polygonLatLon = buildingFootprint?.polygonLatLon;
                if (!Array.isArray(polygonLatLon) || polygonLatLon.length < 3) return;

                const polygon = L.polygon(polygonLatLon, {
                    color,
                    weight: 1.25,
                    opacity: 0.85,
                    fillColor: color,
                    fillOpacity: 0.16
                });

                polygon.bindTooltip(`${tile.tile} #${buildingIndex + 1}`, {
                    sticky: true,
                    direction: "top"
                });

                polygon.bindPopup(buildTileFootprintPopupHtml(tile, buildingFootprint, buildingIndex));
                layers.push(polygon);
            });
        } else {
            const footprintPolygon = tile?.footprint?.polygonLatLon;
            if (!Array.isArray(footprintPolygon) || footprintPolygon.length < 3) {
                return [];
            }

            const polygon = L.polygon(footprintPolygon, {
                color,
                weight: 2,
                opacity: 0.95,
                fillColor: color,
                fillOpacity: 0.12
            });

            polygon.bindTooltip(tile.tile, {
                sticky: true,
                direction: "top"
            });

            polygon.bindPopup(buildTileFootprintPopupHtml(tile));
            layers.push(polygon);
        }

        if (tile.tilesetCenter && Number.isFinite(tile.tilesetCenter.lat) && Number.isFinite(tile.tilesetCenter.lon)) {
            const centerMarker = L.circleMarker([tile.tilesetCenter.lat, tile.tilesetCenter.lon], {
                radius: 4,
                color,
                weight: 2,
                fillColor: "#ffffff",
                fillOpacity: 0.95
            });

            centerMarker.bindTooltip(`${tile.tile} center`, {
                sticky: true,
                direction: "top"
            });
            centerMarker.bindPopup(buildTileFootprintPopupHtml(tile));
            layers.push(centerMarker);
        }

        return layers;
    });

    if (footprintLayers.length === 0) return;

    buildingTileFootprintsLayer = L.featureGroup(footprintLayers).addTo(map);
}

function renderPointResults(
    lat,
    lon,
    noiseInfo,
    weatherSelection,
    cityTemperatureStats,
    airQualityInfo,
    buildingData = []
) {
    const output = document.getElementById("output");
    if (!output) return;

    const noiseClass = noiseInfo?.klasse ?? "n/a";
    const noiseDistanceText = formatDistance(noiseInfo?.distanceKm);

    const usedStations = weatherSelection?.usedStations ?? [];
    const totalStationsUsed = weatherSelection?.totalStationsUsed ?? 0;
    const metricStationCounts = weatherSelection?.metricStationCounts ?? {};
    const combined = weatherSelection?.combined ?? {};
    const airQuality = airQualityInfo ?? {};
    const exposureNow = new Date();
    const sunExposure = computeSunExposure(lat, lon, exposureNow, { lookAheadHours: 12, stepMinutes: 5 });
    const sunlitStatus = evaluateSunlitStatus(lat, lon, exposureNow, buildingData, true);
    const buildingDebugSummary = buildingData?.debugSummary ?? null;
    const sunRayDebug = sunlitStatus.debug ?? null;
    const exposureStatus = sunlitStatus.isSunlit === null
        ? "n/a"
        : sunlitStatus.isSunlit
            ? "In sun"
            : "In shade";
    const exposureAltitudeText = formatValue(sunExposure.altitudeDeg, "°");
    const exposureDurationText = sunExposure.minutesUntilChange === null
        ? "n/a"
        : sunExposure.nextChangeTime
            ? formatDurationMinutes(sunExposure.minutesUntilChange)
            : `${formatDurationMinutes(sunExposure.minutesUntilChange)}+`;
    const exposureChangeLabel = sunExposure.nextChangeTime
        ? `${sunExposure.changeType === "sunrise" ? "Sunrise" : "Sunset"} at ${formatLocalTime(sunExposure.nextChangeTime, exposureNow)}`
        : `No change expected in next ${sunExposure.lookAheadHours}h`;
    const sunStartForecast = findNextSunlitTime(
        lat,
        lon,
        exposureNow,
        buildingData,
        sunlitStatus,
        { lookAheadHours: 12, stepMinutes: 10 }
    );
    const spotScores = buildSpotScores(noiseInfo, combined, cityTemperatureStats, airQuality);
    const generalScoreText = formatScore(spotScores.general);
    const sunStartText = sunStartForecast.minutesUntilStart === null
        ? "n/a"
        : sunStartForecast.minutesUntilStart === 0
            ? "Now"
            : formatDurationMinutes(sunStartForecast.minutesUntilStart);
    const sunStartLabel = sunStartForecast.nextTime
        ? `Sun exposure starts at ${formatLocalTime(sunStartForecast.nextTime, exposureNow)}`
        : sunStartForecast.reason;
    const tileChecks = Array.isArray(sunRayDebug?.tileChecks) ? sunRayDebug.tileChecks : [];
    const tileRows = tileChecks.length
        ? tileChecks
              .map(
                  (tileCheck, index) => `
                    <li>
                        <div class="debug-tile__head">
                            <div class="debug-tile__label">
                                <span class="debug-color-swatch" style="--tile-color: ${getTileDebugColor(index)}"></span>
                                <strong>${tileCheck.tile}</strong>
                            </div>
                            <span class="debug-chip debug-chip--${formatDebugReasonClass(tileCheck.reason)}">${tileCheck.reason}</span>
                        </div>
                        <div class="debug-tile__meta">
                            <span>Distance: ${formatMeters(tileCheck.selectionDistanceMeters)}</span>
                            <span>Triangles: ${tileCheck.trianglesTested ?? 0}</span>
                            <span>Hit: ${tileCheck.hit ? "yes" : "no"}</span>
                        </div>
                    </li>
                `
              )
              .join("")
        : `
            <li>
                <div class="debug-tile__head">
                    <div class="debug-tile__label">
                        <strong>No tile checks recorded</strong>
                    </div>
                </div>
            </li>
        `;
    const debugRequestedText = buildingDebugSummary
        ? `${buildingDebugSummary.loaded ?? 0}/${buildingDebugSummary.requested ?? 0} tiles`
        : `${buildingData.length} tiles`;
    const debugSummaryText = sunRayDebug?.summary ?? sunlitStatus.reason;
    const debugErrorNote = buildingDebugSummary?.error
        ? `<p class="section-note section-note--error">Loader error: ${escapeHtml(buildingDebugSummary.error)}</p>`
        : "";
    const debugOriginText = formatVector(sunRayDebug?.originWorld);
    const debugDirectionText = formatVector(sunRayDebug?.directionWorld);
    const shouldOpenDebugAccordion =
        sunlitStatus.isSunlit === null ||
        Boolean(buildingDebugSummary?.error) ||
        tileChecks.some((tileCheck) => tileCheck.reason === "Triangle limit reached");

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

    const spotName = queryMarker?.getPopup()?.getContent()?.match(/<strong>(.*?)<\/strong>/)?.[1] ?? "Selected spot";

    output.innerHTML = `
        <div class="result-stack">
            <section class="result-card result-card--hero">
                <div class="hero-meta">
                    <span class="pill">Selected spot</span>
                    <span class="pill pill--accent">Hamburg scoring</span>
                </div>
                <h3>${spotName}</h3>
                <p class="coordinates">${lat.toFixed(5)}, ${lon.toFixed(5)}</p>
            </section>

            <details class="accordion"${shouldOpenDebugAccordion ? " open" : ""}>
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

            <details class="accordion">
                <summary>
                    <div class="accordion__copy">
                        <p class="accordion__eyebrow">Noise</p>
                        <h4>Traffic noise estimate</h4>
                    </div>
                    <span class="accordion__meta">${noiseClass}</span>
                </summary>
                <div class="accordion__content">
                    <ul class="stat-list">
                        <li><strong>Noise class</strong><span>${noiseClass}</span></li>
                        <li><strong>Distance to matched feature</strong><span>${noiseDistanceText}</span></li>
                    </ul>
                </div>
            </details>

            <details class="accordion">
                <summary>
                    <div class="accordion__copy">
                        <p class="accordion__eyebrow">Air quality</p>
                        <h4>Sensor.Community readings</h4>
                    </div>
                    <span class="accordion__meta">${formatValue(airQuality.pm25, "µg/m³")}</span>
                </summary>
                <div class="accordion__content">
                    <ul class="stat-list">
                        <li><strong>PM2.5</strong><span>${formatValue(airQuality.pm25, "µg/m³")}</span></li>
                        <li><strong>PM10</strong><span>${formatValue(airQuality.pm10, "µg/m³")}</span></li>
                        <li><strong>Sensors used</strong><span>${airQuality.usedSensors ?? 0}</span></li>
                        <li><strong>Nearest sensor distance</strong><span>${formatDistance(airQuality.nearestDistanceKm)}</span></li>
                    </ul>
                </div>
            </details>

            <details class="accordion">
                <summary>
                    <div class="accordion__copy">
                        <p class="accordion__eyebrow">Sun exposure</p>
                        <h4>Sun & shade outlook</h4>
                    </div>
                    <span class="accordion__meta">${exposureStatus}</span>
                </summary>
                <div class="accordion__content">
                    <ul class="stat-list">
                        <li><strong>Current status</strong><span>${exposureStatus}</span></li>
                        <li><strong>Sun altitude</strong><span>${exposureAltitudeText}</span></li>
                        <li><strong>Time until sun exposure starts</strong><span>${sunStartText}</span></li>
                        <li><strong>Exposure start</strong><span>${sunStartLabel}</span></li>
                        <li><strong>Time until change</strong><span>${exposureDurationText}</span></li>
                        <li><strong>Next change</strong><span>${exposureChangeLabel}</span></li>
                    </ul>
                    <p class="section-note">Sun exposure uses basic ray checks against nearby building tiles. Forecast limited to 12 hours.</p>
                </div>
            </details>

            <details class="accordion">
                <summary>
                    <div class="accordion__copy">
                        <p class="accordion__eyebrow">Ray debug</p>
                        <h4>Sun ray diagnostics</h4>
                    </div>
                    <span class="accordion__meta">${debugRequestedText}</span>
                </summary>
                <div class="accordion__content">
                    <ul class="stat-list">
                        <li><strong>Selection mode</strong><span>${buildingDebugSummary?.selectionMode ?? "n/a"}</span></li>
                        <li><strong>Status reason</strong><span>${debugSummaryText}</span></li>
                        <li><strong>Ray origin (ECEF)</strong><span>${debugOriginText}</span></li>
                        <li><strong>Ray direction (ECEF)</strong><span>${debugDirectionText}</span></li>
                    </ul>
                    <p class="section-note">Tile footprints for the loaded adjacent tiles are drawn on the map with the matching colors shown below.</p>
                    ${debugErrorNote}
                    <ul class="debug-tile-list">${tileRows}</ul>
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
                        <li><strong>Air quality</strong><span class="score-value">${formatScore(spotScores.airQuality)}</span></li>
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
                <p class="score-caption">A combined read across noise, air quality, temperature, humidity, wind, and rain for the selected point.</p>
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

function formatPercent(value) {
    if (!Number.isFinite(value)) return "n/a";
    return `${Math.round(value)}%`;
}

function formatDurationMinutes(minutes) {
    if (!Number.isFinite(minutes)) return "n/a";
    const rounded = Math.max(0, Math.round(minutes));
    const hours = Math.floor(rounded / 60);
    const mins = rounded % 60;

    if (hours > 0 && mins > 0) {
        return `${hours}h ${mins}m`;
    }

    if (hours > 0) {
        return `${hours}h`;
    }

    return `${mins}m`;
}

function formatLocalTime(date, referenceDate) {
    if (!(date instanceof Date)) return "n/a";
    const sameDay =
        referenceDate instanceof Date &&
        date.getFullYear() === referenceDate.getFullYear() &&
        date.getMonth() === referenceDate.getMonth() &&
        date.getDate() === referenceDate.getDate();

    return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        weekday: sameDay ? undefined : "short"
    });
}

function formatMeters(value) {
    if (!Number.isFinite(value)) return "n/a";
    if (value >= 1000) return `${(value / 1000).toFixed(2)} km`;
    return `${Math.round(value)} m`;
}

function formatVector(vector) {
    if (!Array.isArray(vector) || vector.length < 3 || vector.some((value) => !Number.isFinite(value))) {
        return "n/a";
    }

    return vector.map((value) => value.toFixed(3)).join(", ");
}

function formatDebugReasonClass(reason) {
    switch (reason) {
        case "Hit geometry":
            return "hit";
        case "Triangle limit reached":
            return "limit";
        case "No hit":
            return "clear";
        default:
            return "neutral";
    }
}

function getTileDebugColor(index) {
    const palette = [
        "#d64545",
        "#0e4d25",
        "#3a7bd5",
        "#8a5cf6",
        "#cf7a00",
        "#0f8b8d",
        "#9c2c77",
        "#3f681c",
        "#8b4513"
    ];

    return palette[index % palette.length];
}

function buildTileFootprintPopupHtml(tile, buildingFootprint = null, buildingIndex = null) {
    const footprint = tile?.footprint ?? null;
    const rayCheck = tile?.rayCheck ?? null;
    const tileCenter = tile?.tilesetCenter ?? null;
    const totalBuildings = Array.isArray(tile?.buildingFootprints) ? tile.buildingFootprints.length : 0;
    const activeFootprint = buildingFootprint ?? footprint;

    return `
        <strong>${escapeHtml(tile?.tile ?? "Tile")}</strong><br/>
        Distance: ${formatMeters(tile?.selectionDistanceMeters)}<br/>
        Buildings extracted: ${totalBuildings}<br/>
        ${Number.isInteger(buildingIndex) ? `Building index: ${buildingIndex + 1}<br/>` : ""}
        Footprint hull points: ${activeFootprint?.hullPointCount ?? 0}<br/>
        Footprint sampled points: ${activeFootprint?.sampledPointCount ?? activeFootprint?.sourcePointCount ?? 0}<br/>
        Footprint total vertices: ${activeFootprint?.totalVertexCount ?? 0}${activeFootprint?.isSampled ? " (sampled)" : ""}<br/>
        Footprint area: ${Number.isFinite(activeFootprint?.areaSquareMeters) ? `${activeFootprint.areaSquareMeters.toFixed(1)} m²` : "n/a"}<br/>
        Matrix apply mode: ${escapeHtml(tile?.matrixApplyMode ?? "n/a")}<br/>
        Tile center: ${formatLatLon(tileCenter?.lat, tileCenter?.lon)}<br/>
        Ray result: ${escapeHtml(rayCheck?.reason ?? "n/a")}<br/>
        Triangles tested: ${rayCheck?.trianglesTested ?? 0}
    `;
}

function formatLatLon(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "n/a";
    return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function escapeHtml(value) {
    if (typeof value !== "string") return "";

    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

function evaluateSunlitStatus(lat, lon, date, buildingData, debug = false) {
    const sunDirection = computeSunDirection(lat, lon, date);
    const sunExposure = computeSunExposure(lat, lon, date, { lookAheadHours: 12, stepMinutes: 10 });
    const rayDirectionWorld = sunDirection ? enuDirectionToEcef(sunDirection, lat, lon) : null;
    const rayOriginWorld = latLonHeightToEcef(lat, lon, SPOT_HEIGHT_METERS);
    const tileChecks = [];
    const baseDebug = {
        originWorld: rayOriginWorld,
        directionWorld: rayDirectionWorld,
        tilesLoaded: Array.isArray(buildingData) ? buildingData.length : 0,
        tileChecks
    };

    if (!sunDirection || !rayDirectionWorld || sunExposure.isSunUp === null) {
        if (debug) {
            console.info("[sun-ray] Missing sun direction", {
                lat,
                lon,
                date,
                sunDirection,
                rayDirectionWorld,
                isSunUp: sunExposure.isSunUp
            });
        }
        return {
            isSunlit: null,
            isSunUp: sunExposure.isSunUp,
            reason: "No sun position",
            debug: {
                ...baseDebug,
                summary: "No sun position"
            }
        };
    }

    if (!sunExposure.isSunUp) {
        if (debug) {
            console.info("[sun-ray] Sun below horizon", {
                lat,
                lon,
                date,
                altitudeDeg: sunExposure.altitudeDeg,
                azimuthDeg: sunExposure.azimuthDeg
            });
        }
        return {
            isSunlit: false,
            isSunUp: false,
            reason: "Sun below horizon",
            debug: {
                ...baseDebug,
                summary: "Sun below horizon"
            }
        };
    }

    if (!Array.isArray(buildingData) || buildingData.length === 0) {
        if (debug) {
            console.info("[sun-ray] No building data", {
                lat,
                lon,
                date,
                direction: sunDirection
            });
        }
        return {
            isSunlit: true,
            isSunUp: true,
            reason: "No building data",
            debug: {
                ...baseDebug,
                summary: "No building data"
            }
        };
    }

    if (debug) {
        console.info("[sun-ray] Raycast start", {
            lat,
            lon,
            date,
            direction: sunDirection,
            directionWorld: rayDirectionWorld,
            originWorld: rayOriginWorld,
            tilesLoaded: buildingData.length,
            altitudeDeg: sunExposure.altitudeDeg,
            azimuthDeg: sunExposure.azimuthDeg
        });
    }

    let raycastIncomplete = false;

    for (const tile of buildingData) {
        if (!tile?.gltf || tile?.validation?.isValid === false) {
            if (debug) {
                console.info("[sun-ray] Skipping tile", {
                    tile: tile?.tile,
                    hasGltf: Boolean(tile?.gltf),
                    validation: tile?.validation
                });
            }
            continue;
        }

        if (debug) {
            console.info("[sun-ray] Tile origin", {
                tile: tile.tile,
                originWorld: rayOriginWorld,
                rtcCenter: tile.rtcCenter,
                tilesetCenter: tile.tilesetCenter
            });
        }

        const rayCheck = rayIntersectsGltf(
            tile.gltf,
            {
                origin: rayOriginWorld,
                direction: rayDirectionWorld
            },
            {
                maxTriangles: 800000,
                modelMatrix: tile.modelMatrix
            }
        );

        if (debug) {
            console.info("[sun-ray] Tile result", {
                tile: tile.tile,
                hit: rayCheck?.hit,
                trianglesTested: rayCheck?.trianglesTested,
                reason: rayCheck?.reason
            });
        }

        tileChecks.push({
            tile: tile.tile,
            selectionDistanceMeters: tile.selectionDistanceMeters,
            hit: Boolean(rayCheck?.hit),
            trianglesTested: rayCheck?.trianglesTested ?? 0,
            reason: rayCheck?.reason ?? "No result"
        });

        if (rayCheck?.hit) {
            return {
                isSunlit: false,
                isSunUp: true,
                reason: "Blocked by geometry",
                debug: {
                    ...baseDebug,
                    blockedTile: tile.tile,
                    summary: `Blocked by ${tile.tile}`
                }
            };
        }

        if (rayCheck?.reason === "Triangle limit reached") {
            raycastIncomplete = true;
        }
    }

    if (raycastIncomplete) {
        if (debug) {
            console.info("[sun-ray] Raycast incomplete", {
                lat,
                lon,
                date
            });
        }

        return {
            isSunlit: null,
            isSunUp: true,
            reason: "Raycast incomplete",
            debug: {
                ...baseDebug,
                summary: "Triangle budget exhausted before completing the raycast"
            }
        };
    }

    if (debug) {
        console.info("[sun-ray] No hits", {
            lat,
            lon,
            date
        });
    }

    return {
        isSunlit: true,
        isSunUp: true,
        reason: "Clear",
        debug: {
            ...baseDebug,
            summary: "No blocking geometry hit"
        }
    };
}

function findNextSunlitTime(lat, lon, now, buildingData, currentStatus, options = {}) {
    const lookAheadHours = Number.isFinite(options.lookAheadHours) ? options.lookAheadHours : 12;
    const stepMinutes = Number.isFinite(options.stepMinutes) ? options.stepMinutes : 10;
    const maxMinutes = Math.max(0, lookAheadHours * 60);

    if (currentStatus?.isSunlit === true) {
        return { minutesUntilStart: 0, nextTime: now, reason: "Already sunlit" };
    }

    if (currentStatus?.isSunlit === null) {
        return { minutesUntilStart: null, nextTime: null, reason: "Sun position unavailable" };
    }

    let previousSunlit = currentStatus.isSunlit;

    for (let elapsed = stepMinutes; elapsed <= maxMinutes; elapsed += stepMinutes) {
        const candidate = new Date(now.getTime() + elapsed * 60000);
        const status = evaluateSunlitStatus(lat, lon, candidate, buildingData);

        if (status.isSunlit && !previousSunlit) {
            return {
                minutesUntilStart: elapsed,
                nextTime: candidate,
                reason: "Sun exposure expected"
            };
        }

        previousSunlit = status.isSunlit;
    }

    return {
        minutesUntilStart: null,
        nextTime: null,
        reason: `No sun exposure change in next ${lookAheadHours}h`
    };
}
