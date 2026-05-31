/**
 * compare.js — Sprint 1: Spot-Vergleich
 *
 * Hängt sich via MutationObserver + Map-Event-Interceptor in die bestehende App ein.
 * Keine Änderungen an script.js, utils.js oder data-api.js nötig.
 *
 * Einbinden in index.html (einzige nötige Änderung dort):
 *   <script type="module" src="./compare.js"></script>
 */

import { buildSpotScores } from "./utils.js";
import { fetchPointSelectionData, fetchAddressLabelForCoordinates } from "./data-api.js";

const HAMBURG_BOUNDS = [
    [53.41062884725186, 9.732240484945219],
    [53.72838568700598, 10.29272015751267]
];

const SCORE_LABELS = {
    noise: "Noise",
    airQuality: "Air quality",
    temperature: "Temperature",
    humidity: "Humidity",
    wind: "Wind",
    rain: "Rain"
};

// ─── State ────────────────────────────────────────────────────────────────────

let pinnedSpot = null;   // { lat, lon, name, noiseInfo, weatherSelection, cityTemperatureStats, airQualityInfo, scores }
let isCompareMode = false;
let lastKnownSpot = null; // filled by MutationObserver watching #output

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    injectBanner();
    watchOutputForSpotResults();
    interceptMapClicks();
});

// ─── Banner injection ─────────────────────────────────────────────────────────

function injectBanner() {
    const banner = document.createElement("div");
    banner.id = "compareBanner";
    banner.className = "compare-banner is-hidden";
    banner.setAttribute("aria-live", "polite");
    banner.innerHTML = `
        <div class="compare-banner__inner">
            <span class="compare-banner__pill">Spot A pinned</span>
            <p class="compare-banner__name"></p>
            <p class="compare-banner__hint">Click anywhere on the map to pick Spot B</p>
        </div>
        <button type="button" class="compare-banner__cancel">✕ Cancel</button>
    `;
    banner.querySelector(".compare-banner__cancel").addEventListener("click", exitCompareMode);
    document.body.appendChild(banner);
}

// ─── MutationObserver: detect when a single-spot result is rendered ───────────

function watchOutputForSpotResults() {
    const output = document.getElementById("output");
    if (!output) return;

    const observer = new MutationObserver(() => {
        // Only act if we're NOT in compare mode (avoid injecting button mid-flow)
        if (isCompareMode) return;

        // Check if this looks like a single-spot result (has .result-card--score)
        const scoreCard = output.querySelector(".result-card--score");
        const resultStack = output.querySelector(".result-stack");
        if (!scoreCard || !resultStack) return;

        // Don't inject twice
        if (resultStack.querySelector(".btn-compare")) return;

        // Extract what we know from the rendered DOM
        const nameEl = resultStack.querySelector(".result-card--hero h3");
        const coordEl = resultStack.querySelector(".coordinates");
        const spotName = nameEl?.textContent?.trim() ?? "Selected spot";

        // Parse coords from the rendered text (e.g. "53.54321, 9.98765")
        const coordMatch = coordEl?.textContent?.match(/([\d.]+),\s*([\d.]+)/);
        const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
        const lon = coordMatch ? parseFloat(coordMatch[2]) : null;

        // Store what we know so far (scores will be re-fetched on compare)
        lastKnownSpot = { lat, lon, name: spotName };

        // Inject compare button after the score card
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-compare";
        btn.textContent = "⚖️ Compare with another spot";
        btn.addEventListener("click", () => onCompareClick(lastKnownSpot));
        resultStack.appendChild(btn);
    });

    observer.observe(output, { childList: true, subtree: false });
}

// ─── Map click interceptor ────────────────────────────────────────────────────

function interceptMapClicks() {
    // We wait for Leaflet's map to be initialized, then intercept via a
    // high-priority listener on the map div itself (before Leaflet propagates)
    const mapEl = document.getElementById("map");
    if (!mapEl) return;

    // Poll until L.map instance is available on the element
    const poll = setInterval(() => {
        if (!window.L) return;

        // Find the Leaflet map instance attached to the div
        const mapKeys = Object.keys(mapEl).filter(k => k.startsWith("_leaflet_id"));
        if (!mapKeys.length) return;

        clearInterval(poll);

        // Leaflet stores map instances in L.map._targets; we use a capture-phase
        // click on the map div to intercept BEFORE the map fires its own click event
        mapEl.addEventListener("click", handleMapClickCapture, { capture: true });
    }, 100);
}

function handleMapClickCapture(e) {
    if (!isCompareMode || !pinnedSpot) return;

    // We don't stopPropagation — Leaflet still gets the click.
    // But we register our OWN parallel fetch for the challenger spot.
    // We need latlng from Leaflet, so we let the event through and hook
    // onto the next Leaflet map click event once.

    // Strategy: temporarily override the map's click handler output
    // by watching #output for the loading message, then re-fetching ourselves.
    waitForChallengerLoad();
}

function waitForChallengerLoad() {
    const output = document.getElementById("output");
    if (!output) return;

    // Watch for the loading state that script.js triggers after a map click
    const observer = new MutationObserver(() => {
        const loading = output.querySelector(".loading");
        if (!loading) return;

        observer.disconnect();

        // At this point Leaflet fired its click, script.js called
        // handlePointSelection and is now fetching data normally.
        // We intercept by watching for the NEXT result render,
        // then replacing it with the comparison view.
        waitForChallengerResult(output);
    });

    observer.observe(output, { childList: true, subtree: true });
}

function waitForChallengerResult(output) {
    let settled = false;

    const observer = new MutationObserver(() => {
        if (settled) return;

        const scoreCard = output.querySelector(".result-card--score");
        const resultStack = output.querySelector(".result-stack");
        if (!scoreCard || !resultStack) return;

        settled = true;
        observer.disconnect();

        // Extract challenger data from the freshly rendered DOM
        const nameEl = resultStack.querySelector(".result-card--hero h3");
        const coordEl = resultStack.querySelector(".coordinates");
        const spotName = nameEl?.textContent?.trim() ?? "Challenger spot";
        const coordMatch = coordEl?.textContent?.match(/([\d.]+),\s*([\d.]+)/);
        const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
        const lon = coordMatch ? parseFloat(coordMatch[2]) : null;

        // Read scores from rendered score-list
        const scores = readScoresFromDOM(resultStack);

        const challengerSpot = { lat, lon, name: spotName, scores };

        renderComparisonResults(pinnedSpot, challengerSpot);
    });

    observer.observe(output, { childList: true, subtree: true });
}

function readScoresFromDOM(resultStack) {
    const scores = {};
    const scoreItems = resultStack.querySelectorAll(".score-list li");

    const keyMap = {
        "Noise": "noise",
        "Air quality": "airQuality",
        "Temperature": "temperature",
        "Humidity": "humidity",
        "Wind": "wind",
        "Rain": "rain"
    };

    scoreItems.forEach(li => {
        const label = li.querySelector("strong")?.textContent?.trim();
        const value = li.querySelector(".score-value")?.textContent?.trim();
        const key = keyMap[label];
        if (key && value && value !== "n/a") {
            scores[key] = parseFloat(value);
        }
    });

    // Overall score
    const generalEl = resultStack.querySelector(".score-display");
    if (generalEl && generalEl.textContent.trim() !== "n/a") {
        scores.general = parseFloat(generalEl.textContent.trim());
    }

    return scores;
}

// ─── Compare mode state ───────────────────────────────────────────────────────

async function onCompareClick(spot) {
    // If we only have lat/lon/name but no scores yet, scores are already in lastKnownSpot
    // We still need the full score object — read it from current DOM
    const output = document.getElementById("output");
    const resultStack = output?.querySelector(".result-stack");
    const scores = resultStack ? readScoresFromDOM(resultStack) : {};

    pinnedSpot = { ...spot, scores };
    isCompareMode = true;

    const banner = document.getElementById("compareBanner");
    if (banner) {
        banner.querySelector(".compare-banner__name").textContent = spot.name;
        banner.classList.remove("is-hidden");
    }

    // Show instruction in output
    output.innerHTML = `<section class="result-card"><p class="loading">📍 Spot A pinned: "${spot.name}".<br><br>Now click anywhere on the map to pick Spot B.</p></section>`;
    output.classList.remove("is-hidden");
}

function exitCompareMode() {
    pinnedSpot = null;
    isCompareMode = false;

    const banner = document.getElementById("compareBanner");
    if (banner) banner.classList.add("is-hidden");

    // Remove compare marker if one was placed
    const mapEl = document.getElementById("map");
    if (mapEl?._compareMarker && window._leafletMap) {
        try { window._leafletMap.removeLayer(mapEl._compareMarker); } catch (_) {}
    }
}

// ─── Comparison render ────────────────────────────────────────────────────────

function renderComparisonResults(spotA, spotB) {
    const output = document.getElementById("output");
    if (!output) return;

    exitCompareMode();

    const metrics = Object.keys(SCORE_LABELS);
    let aWinCount = 0;
    let bWinCount = 0;

    const metricRows = metrics.map((key) => {
        const aVal = spotA.scores[key];
        const bVal = spotB.scores[key];
        let aClass = ""; let bClass = "";

        if (Number.isFinite(aVal) && Number.isFinite(bVal)) {
            if (aVal > bVal)      { aClass = "compare-cell--win"; aWinCount++; }
            else if (bVal > aVal) { bClass = "compare-cell--win"; bWinCount++; }
            else                  { aClass = bClass = "compare-cell--tie"; }
        }

        return `<tr>
            <td class="compare-cell compare-cell--metric">${SCORE_LABELS[key]}</td>
            <td class="compare-cell compare-cell--a ${aClass}">${fmt(aVal)}</td>
            <td class="compare-cell compare-cell--b ${bClass}">${fmt(bVal)}</td>
        </tr>`;
    }).join("");

    const aG = spotA.scores.general;
    const bG = spotB.scores.general;
    let aGClass = ""; let bGClass = "";
    let winnerBanner = "";

    if (Number.isFinite(aG) && Number.isFinite(bG)) {
        if (aG > bG) {
            aGClass = "compare-cell--win";
            winnerBanner = buildWinnerBanner(spotA.name, aG, "a");
        } else if (bG > aG) {
            bGClass = "compare-cell--win";
            winnerBanner = buildWinnerBanner(spotB.name, bG, "b");
        } else {
            aGClass = bGClass = "compare-cell--tie";
            winnerBanner = `<div class="winner-banner winner-banner--tie"><span class="winner-trophy">🤝</span><p class="winner-label">It's a tie!</p><p class="winner-score">${fmt(aG)} / 10</p></div>`;
        }
    }

    output.innerHTML = `
        <div class="result-stack">
            <section class="result-card result-card--hero">
                <div class="hero-meta">
                    <span class="pill">Spot comparison</span>
                    <span class="pill pill--accent">${aWinCount} – ${bWinCount} categories</span>
                </div>
                <h3>Head-to-head</h3>
            </section>

            ${winnerBanner}

            <section class="result-card compare-card">
                <div class="compare-header">
                    <div class="compare-header__metric"></div>
                    <div class="compare-header__spot compare-header__spot--a">
                        ${renderSpotName(spotA, "a")}
                    </div>
                    <div class="compare-header__spot compare-header__spot--b">
                        ${renderSpotName(spotB, "b")}
                    </div>
                </div>
                <table class="compare-table">
                    <colgroup>
                        <col class="compare-col compare-col--metric" />
                        <col class="compare-col compare-col--a" />
                        <col class="compare-col compare-col--b" />
                    </colgroup>
                    <tbody>
                        ${metricRows}
                        <tr class="compare-row--total">
                            <td class="compare-cell compare-cell--metric">Overall</td>
                            <td class="compare-cell compare-cell--a ${aGClass}">${fmt(aG)}</td>
                            <td class="compare-cell compare-cell--b ${bGClass}">${fmt(bG)}</td>
                        </tr>
                    </tbody>
                </table>
            </section>

            <div class="compare-actions">
                <button type="button" id="compareAgainBtn" class="btn-secondary">Compare again</button>
            </div>
        </div>
    `;

    output.classList.remove("is-hidden");

    document.getElementById("compareAgainBtn")?.addEventListener("click", () => {
        onCompareClick(spotA);
    });

    output.querySelectorAll(".compare-spot-button").forEach((button) => {
        button.addEventListener("click", () => {
            const side = button.getAttribute("data-spot");
            const targetSpot = side === "b" ? spotB : spotA;
            triggerSpotSelection(targetSpot);
        });
    });
}

function renderSpotName(spot, side) {
    const trimmedName = (spot?.name ?? "").trim();
    const label = trimmedName || "Spot";
    const isSingleWord = label && !/\s/.test(label);
    const className = isSingleWord
        ? "compare-spot-name compare-spot-name--truncate"
        : "compare-spot-name";
    return `
        <button type="button" class="compare-spot-button" data-spot="${side}" aria-label="View ${label}">
            <strong class="${className}">${label}</strong>
        </button>
    `;
}

function triggerSpotSelection(spot) {
    if (!spot || !Number.isFinite(spot.lat) || !Number.isFinite(spot.lon)) return;
    if (window.__spotScoreApp?.handlePointSelection) {
        window.__spotScoreApp.handlePointSelection(spot.lat, spot.lon);
    }
}

function reloadSpot(spot) {
    const output = document.getElementById("output");
    if (output) {
        output.innerHTML = `<section class="result-card"><p class="loading">Reloading ${spot.name}…</p></section>`;
        output.classList.remove("is-hidden");
    }

    // Dispatch a custom event that compare.js itself listens to — no script.js touch needed
    // Instead: re-use the scores we already have and rebuild the winner display from stored data
    // Since we don't have noiseInfo etc stored, we render a lightweight "back" view
    renderBackToSpot(spot);
}

function renderBackToSpot(spot) {
    const output = document.getElementById("output");
    if (!output) return;

    const metrics = Object.keys(SCORE_LABELS);
    const scoreRows = metrics.map(key => `
        <li><strong>${SCORE_LABELS[key]}</strong><span class="score-value">${fmt(spot.scores[key])}</span></li>
    `).join("");

    output.innerHTML = `
        <div class="result-stack">
            <section class="result-card result-card--hero">
                <div class="hero-meta">
                    <span class="pill">Selected spot</span>
                    <span class="pill pill--accent">Hamburg scoring</span>
                </div>
                <h3>${spot.name}</h3>
                <p class="coordinates">${fmtCoord(spot.lat)}, ${fmtCoord(spot.lon)}</p>
            </section>

            <details class="accordion" open>
                <summary>
                    <div class="accordion__copy"><p class="accordion__eyebrow">Scoring</p><h4>Spot scores</h4></div>
                    <span class="accordion__meta">${fmt(spot.scores.general)} / 10</span>
                </summary>
                <div class="accordion__content">
                    <ul class="score-list">${scoreRows}</ul>
                </div>
            </details>

            <section class="result-card result-card--score">
                <p class="score-kicker">General spot score</p>
                <div class="score-display">${fmt(spot.scores.general)}</div>
                <p class="score-caption">Click the map again to reload full data for this spot.</p>
            </section>

            <button type="button" class="btn-compare" id="recompareBtnBack">
                ⚖️ Compare with another spot
            </button>
        </div>
    `;

    output.classList.remove("is-hidden");

    document.getElementById("recompareBtnBack")?.addEventListener("click", () => {
        onCompareClick(spot);
    });
}

function buildWinnerBanner(name, score, side) {
    return `<div class="winner-banner winner-banner--${side}">
        <span class="winner-trophy">🏆</span>
        <div class="winner-copy">
            <p class="winner-label">Winner</p>
            <p class="winner-name">${name}</p>
        </div>
        <p class="winner-score">${fmt(score)} / 10</p>
    </div>`;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(value) {
    if (!Number.isFinite(value)) return "n/a";
    return value.toFixed(1);
}

function fmtCoord(value) {
    if (!Number.isFinite(value)) return "–";
    return value.toFixed(5);
}