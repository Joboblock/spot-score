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
                renderQueryError("Bitte gib gültige Koordinaten ein.");
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
            ? "Quelle: Netatmo <code>/getpublicdata</code> für öffentliche Stationen in Hamburg"
            : "Quelle: API Hamburg <code>strassenverkehr</code>, Datensatz <code>strassenverkehr_tag_abend_nacht_2022</code> (Lden)";
}

async function loadWeatherData() {
    clearMapLayer();

    try {
        const focus = getWeatherFocusPoint();
        const stations = await fetchWeatherStationsWithinRadius(focus.lat, focus.lon);
        renderWeatherMap(stations);
    } catch (error) {
        renderQueryError(error instanceof Error ? error.message : "Wetterdaten konnten nicht geladen werden.");
        clearMapLayer();
    }
}

async function loadNoiseData() {
    clearMapLayer();

    try {
        const data = await fetchNoiseMapData();
        renderNoiseMap(data);
    } catch (error) {
        renderQueryError(error instanceof Error ? error.message : "Lärmdaten konnten nicht geladen werden.");
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
                radius: 9,
                color: "#070707",
                weight: 2,
                fillColor: getTemperatureColor(station.temperature),
                fillOpacity: 0.92,
                className: "weather-pin"
            });

            marker.bindPopup(
                `<strong>${station.city}</strong><br/>` +
                    `<strong>Straße:</strong> ${station.street}<br/>` +
                    `<strong>Temperatur:</strong> ${formatValue(station.temperature, "°C")}<br/>` +
                    `<strong>Luftfeuchte:</strong> ${formatValue(station.humidity, "%")}<br/>` +
                    `<strong>Druck:</strong> ${formatValue(station.pressure, "mbar")}<br/>` +
                    `<strong>Regen (24h):</strong> ${formatValue(station.rain24h, "mm")}<br/>` +
                    `<strong>Wind:</strong> ${formatValue(station.windStrength, "km/h")}<br/>` +
                    `<strong>Aktualisiert:</strong> ${new Date(station.timestamp * 1000).toLocaleString("de-DE")}`
            );
            marker.bindTooltip(`${formatValue(station.temperature, "°C")}`, {
                permanent: true,
                direction: "top",
                className: "spot-pin-label",
                offset: [0, -8]
            });

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
                const klasse = feature?.properties?.klasse ?? "Unbekannt";
                return {
                    color: "#111111",
                    weight: 0.8,
                    fillColor: getKlasseColor(klasse),
                    fillOpacity: 0.72
                };
            },
            onEachFeature: (feature, layer) => {
                const klasse = feature?.properties?.klasse ?? "Unbekannt";
                layer.bindPopup(`<strong>Lärmklasse:</strong> ${klasse}<br/><strong>Modus:</strong> Lden`);
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
        renderQueryError("Die ausgewählten Koordinaten liegen außerhalb der definierten Hamburg-Grenzen.");
        return;
    }

    placeQueryMarker(lat, lon);
    showLoadingOutput("Lade Lärm- und Wetterdaten für den ausgewählten Spot ...");

    try {
        const { noiseInfo, weatherSelection, cityTemperatureStats } =
            await fetchPointSelectionData(lat, lon, HAMBURG_BOUNDS);

        renderPointResults(lat, lon, noiseInfo, weatherSelection, cityTemperatureStats);
    } catch (error) {
        renderQueryError(error instanceof Error ? error.message : "Spot-Daten konnten nicht geladen werden.");
    }
}

function placeQueryMarker(lat, lon) {
    if (!map) return;

    if (queryMarker) {
        map.removeLayer(queryMarker);
    }

    queryMarker = L.circleMarker([lat, lon], {
        radius: 11,
        color: "#070707",
        weight: 3,
        fillColor: "#c0ed55",
        fillOpacity: 1,
        className: "query-pin"
    }).addTo(map);
    queryMarker.bindPopup(`<strong>Ausgewählter Spot</strong><br/>Breite: ${lat.toFixed(5)}<br/>Länge: ${lon.toFixed(5)}`);
    queryMarker.openPopup();
    const markerElement = queryMarker.getElement?.();
    if (markerElement) {
        markerElement.classList.remove("is-pulsing");
        void markerElement.getBoundingClientRect();
        markerElement.classList.add("is-pulsing");
    }
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

    const noiseClass = noiseInfo?.klasse ?? "k. A.";
    const noiseDistanceText = Number.isFinite(noiseInfo?.distanceKm)
        ? `${noiseInfo.distanceKm.toFixed(3)} km`
        : "k. A.";

    const usedStations = weatherSelection?.usedStations ?? [];
    const totalStationsUsed = weatherSelection?.totalStationsUsed ?? 0;
    const metricStationCounts = weatherSelection?.metricStationCounts ?? {};
    const combined = weatherSelection?.combined ?? {};
    const spotScores = buildSpotScores(noiseInfo, combined, cityTemperatureStats);
    const spotName = getSpotName(weatherSelection);
    const spotRating = getGeneralScoreLabel(spotScores.general);
    const summary = buildSummaryText(noiseInfo, combined, cityTemperatureStats);
    const reasonBadges = buildReasonBadges(noiseInfo, combined);

    const stationRows = usedStations.length
        ? usedStations
              .map(
                  (station, index) => `
                    <li>
                        <strong>#${index + 1} ${station.street ?? station.city ?? "Unbekannte Station"}</strong>
                        <span>${station.distanceKm.toFixed(3)} km</span>
                        <div>Temp: ${formatValue(station.temperature, "°C")} · Luftfeuchte: ${formatValue(station.humidity, "%")} · Wind: ${formatValue(station.windStrength, "km/h")} · Regen: ${formatValue(station.rain24h, "mm")}</div>
                    </li>
                `
              )
              .join("")
        : "<li><strong>Keine nahe Station gefunden</strong></li>";

    output.innerHTML = `
        <article class="spot-detail">
            <header class="spot-detail-header">
                <p class="spot-kicker">Ausgewählter Spot</p>
                <h3 class="spot-name">${spotName}</h3>
            </header>
            <div class="spot-main-score">
                <strong>${formatScore(spotScores.general)}</strong>
                <span>${spotRating}</span>
            </div>
            <p class="spot-summary">${summary}</p>
            <div class="spot-badges">
                ${reasonBadges.map((badge) => `<span>${badge}</span>`).join("")}
            </div>
            <div class="detail-grid">
                <section class="detail-box">
                    <h4>Standort</h4>
                    <ul class="klasse-list">
                        <li><strong>Koordinaten</strong><span>${lat.toFixed(5)}, ${lon.toFixed(5)}</span></li>
                        <li><strong>Lärmklasse</strong><span>${noiseClass}</span></li>
                        <li><strong>Distanz zur Klasse</strong><span>${noiseDistanceText}</span></li>
                    </ul>
                </section>
                <section class="detail-box">
                    <h4>Wetter (distanzgewichtet)</h4>
                    <ul class="klasse-list">
                        <li><strong>Temperatur</strong><span>${formatValue(combined.temperature, "°C")}</span></li>
                        <li><strong>Luftfeuchte</strong><span>${formatValue(combined.humidity, "%")}</span></li>
                        <li><strong>Wind</strong><span>${formatValue(combined.windStrength, "km/h")}</span></li>
                        <li><strong>Regen (24h)</strong><span>${formatValue(combined.rain24h, "mm")}</span></li>
                        <li><strong>Open-Meteo Ø Hamburg (${cityTemperatureStats?.samplePointsUsed ?? 0}/${cityTemperatureStats?.samplePointsTotal ?? 0})</strong><span>${formatValue(cityTemperatureStats?.averageCityTemperature, "°C")}</span></li>
                        <li><strong>Abweichung zum Optimum (${TEMP_OPTIMAL_C}°C)</strong><span>${formatValue(cityTemperatureStats?.tempDifference, "°C")}</span></li>
                    </ul>
                </section>
                <section class="detail-box">
                    <h4>Score-Bausteine (0,1–10)</h4>
                    <ul class="klasse-list">
                        <li><strong>Ruhigkeit</strong><span class="score-value">${formatScore(spotScores.noise)}</span></li>
                        <li><strong>Temperatur</strong><span class="score-value">${formatScore(spotScores.temperature)}</span></li>
                        <li><strong>Luftfeuchte</strong><span class="score-value">${formatScore(spotScores.humidity)}</span></li>
                        <li><strong>Wind</strong><span class="score-value">${formatScore(spotScores.wind)}</span></li>
                        <li><strong>Regen</strong><span class="score-value">${formatScore(spotScores.rain)}</span></li>
                        <li><strong>Gesamter SpotScore</strong><span class="score-value is-general">${formatScore(spotScores.general)}</span></li>
                    </ul>
                </section>
                <section class="detail-box">
                    <h4>Nächste Netatmo-Stationen</h4>
                    <ul class="klasse-list">
                        <li><strong>Genutzte Stationen</strong><span>${totalStationsUsed}</span></li>
                        <li><strong>Metrikbezug</strong><span>Temp ${metricStationCounts.temperature ?? 0} · Luft ${metricStationCounts.humidity ?? 0} · Wind ${metricStationCounts.windStrength ?? 0} · Regen ${metricStationCounts.rain24h ?? 0}</span></li>
                    </ul>
                    <ul class="klasse-list station-list">${stationRows}</ul>
                </section>
            </div>
        </article>
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
    if (!Number.isFinite(temperature)) return "#6b7280";
    if (temperature <= 0) return "#2142b8";
    if (temperature <= 5) return "#2c63d6";
    if (temperature <= 10) return "#0e4d25";
    if (temperature <= 15) return "#3f8c44";
    if (temperature <= 20) return "#c0ed55";
    return "#f2e90e";
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

    if (lowerDb >= 75) return "#111111";
    if (lowerDb >= 70) return "#37241a";
    if (lowerDb >= 65) return "#6b3a21";
    if (lowerDb >= 60) return "#8a6a2d";
    if (lowerDb >= 55) return "#9ebf50";
    return "#c0ed55";
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
            <h4>Temperatur-Skala</h4>
            <div class="legend-item"><span class="legend-color" style="background:#2142b8"></span>≤ 0°C</div>
            <div class="legend-item"><span class="legend-color" style="background:#2c63d6"></span>1–5°C</div>
            <div class="legend-item"><span class="legend-color" style="background:#0e4d25"></span>6–10°C</div>
            <div class="legend-item"><span class="legend-color" style="background:#3f8c44"></span>11–15°C</div>
            <div class="legend-item"><span class="legend-color" style="background:#c0ed55"></span>16–20°C</div>
            <div class="legend-item"><span class="legend-color" style="background:#f2e90e"></span>> 20°C</div>
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

    const classes = [...new Set(features.map((feature) => feature?.properties?.klasse ?? "Unbekannt"))]
        .sort((a, b) => parseLowerDbBound(a) - parseLowerDbBound(b));

    legendControl = L.control({ position: "bottomright" });
    legendControl.onAdd = () => {
        const div = L.DomUtil.create("div", "map-legend");
        div.innerHTML = `
            <h4>Lden dB(A)</h4>
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
    if (!Number.isFinite(value)) return "k. A.";
    return `${value.toFixed(1)} ${unit}`;
}

function formatScore(value) {
    if (!Number.isFinite(value)) return "k. A.";
    return value.toFixed(1);
}

function getSpotName(weatherSelection) {
    const firstStation = weatherSelection?.usedStations?.[0];
    if (!firstStation) return "Spot in Hamburg";
    return firstStation.street ?? firstStation.city ?? "Spot in Hamburg";
}

function getGeneralScoreLabel(generalScore) {
    if (!Number.isFinite(generalScore)) return "Score wird berechnet";
    if (generalScore >= 8.5) return "Sehr guter Spot";
    if (generalScore >= 6.5) return "Guter Spot";
    if (generalScore >= 4.5) return "Ausgewogener Spot";
    return "Eher schwacher Spot";
}

function buildReasonBadges(noiseInfo, combined) {
    const badges = [];
    const lowerDb = parseLowerDbBound(noiseInfo?.klasse ?? "");

    if (lowerDb > 0 && lowerDb <= 55) badges.push("Ruhig");
    if (Number.isFinite(combined?.temperature) && combined.temperature >= 14 && combined.temperature <= 24) {
        badges.push("Angenehme Temperatur");
    }
    if (Number.isFinite(combined?.humidity) && combined.humidity >= 35 && combined.humidity <= 70) {
        badges.push("Luftfeuchte stabil");
    }
    if (Number.isFinite(combined?.rain24h) && combined.rain24h <= 0.6) {
        badges.push("Trocken");
    }
    if (Number.isFinite(combined?.windStrength) && combined.windStrength <= 20) {
        badges.push("Gut erreichbar");
    }

    return badges.length > 0 ? badges.slice(0, 4) : ["Daten geprüft"];
}

function buildSummaryText(noiseInfo, combined, cityTemperatureStats) {
    const lowerDb = parseLowerDbBound(noiseInfo?.klasse ?? "");
    const noiseText =
        lowerDb > 0 && lowerDb <= 60 ? "Die Lärmbelastung bleibt im ruhigen Bereich." : "Die Lärmbelastung ist eher erhöht.";
    const rainText =
        Number.isFinite(combined?.rain24h) && combined.rain24h <= 0.6
            ? "Wenig Regen in den letzten 24 Stunden."
            : "Erhöhte Regenmenge in den letzten 24 Stunden.";
    const tempDiffText = Number.isFinite(cityTemperatureStats?.tempDifference)
        ? `Temperaturabweichung zum Optimum: ${formatValue(cityTemperatureStats.tempDifference, "°C")}.`
        : "Temperaturabweichung zum Optimum nicht verfügbar.";

    return `${noiseText} ${rainText} ${tempDiffText}`;
}
