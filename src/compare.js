/**
 * compare.js — kein Radar, kein QR
 * Fixes: Radar entfernt, Gewichtung in Compare-Tabelle, Back-to-A voll, Score-Farben
 */

import { buildSpotScores } from "./utils.js";
import { fetchPointSelectionData, fetchAddressLabelForCoordinates } from "./data-api.js";

const HAMBURG_BOUNDS = [
    [53.41062884725186, 9.732240484945219],
    [53.72838568700598, 10.29272015751267]
];

const SCORE_LABELS = {
    noise: "Noise", airQuality: "Air quality", temperature: "Temperature",
    humidity: "Humidity", wind: "Wind", rain: "Rain"
};

const METRICS = ["noise", "airQuality", "temperature", "humidity", "wind", "rain"];

let pinnedSpot = null;
let isCompareMode = false;
let lastKnownSpot = null;

document.addEventListener("DOMContentLoaded", () => {
    injectBanner();
    watchOutputForSpotResults();
    interceptMapClicks();
});

// ─── Weights ──────────────────────────────────────────────────────────────────

function getWeightedGeneral(scores) {
    const weights = window.__spotScoreWeights;
    if (!weights) return scores.general;
    let sum = 0, total = 0;
    METRICS.forEach(m => {
        const s = scores[m]; const w = weights[m] ?? 1;
        if (Number.isFinite(s)) { sum += s * w; total += w; }
    });
    return total > 0 ? Math.round((sum / total) * 10) / 10 : scores.general;
}

function scoreColor(v) {
    if (!Number.isFinite(v)) return "";
    if (v >= 7) return "score--good";
    if (v >= 4.5) return "score--mid";
    return "score--bad";
}

// ─── Banner ───────────────────────────────────────────────────────────────────

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

// ─── Watch output ─────────────────────────────────────────────────────────────

function watchOutputForSpotResults() {
    const output = document.getElementById("output");
    if (!output) return;

    const observer = new MutationObserver(() => {
        if (isCompareMode) return;
        const scoreCard = output.querySelector(".result-card--score");
        const resultStack = output.querySelector(".result-stack");
        if (!scoreCard || !resultStack) return;
        if (resultStack.querySelector(".btn-compare")) return;

        const nameEl = resultStack.querySelector(".result-card--hero h3");
        const coordEl = resultStack.querySelector(".coordinates");
        const spotName = nameEl?.textContent?.trim() ?? "Selected spot";
        const coordMatch = coordEl?.textContent?.match(/([\d.]+),\s*([\d.]+)/);
        const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
        const lon = coordMatch ? parseFloat(coordMatch[2]) : null;
        const scores = readScoresFromDOM(resultStack);
        lastKnownSpot = { lat, lon, name: spotName, scores };

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-compare";
        btn.textContent = "⚖️ Compare with another spot";
        btn.addEventListener("click", () => onCompareClick(lastKnownSpot));
        resultStack.appendChild(btn);
    });

    observer.observe(output, { childList: true, subtree: false });
}

// ─── Map intercept ────────────────────────────────────────────────────────────

function interceptMapClicks() {
    const mapEl = document.getElementById("map");
    if (!mapEl) return;
    const poll = setInterval(() => {
        if (!window.L) return;
        if (!Object.keys(mapEl).some(k => k.startsWith("_leaflet_id"))) return;
        clearInterval(poll);
        mapEl.addEventListener("click", () => {
            if (!isCompareMode || !pinnedSpot) return;
            waitForChallengerLoad();
        }, { capture: true });
    }, 100);
}

function waitForChallengerLoad() {
    const output = document.getElementById("output");
    if (!output) return;
    const obs = new MutationObserver(() => {
        if (!output.querySelector(".loading")) return;
        obs.disconnect();
        waitForChallengerResult(output);
    });
    obs.observe(output, { childList: true, subtree: true });
}

function waitForChallengerResult(output) {
    let settled = false;
    const obs = new MutationObserver(() => {
        if (settled) return;
        const scoreCard = output.querySelector(".result-card--score");
        const resultStack = output.querySelector(".result-stack");
        if (!scoreCard || !resultStack) return;
        settled = true;
        obs.disconnect();

        const nameEl = resultStack.querySelector(".result-card--hero h3");
        const coordEl = resultStack.querySelector(".coordinates");
        const spotName = nameEl?.textContent?.trim() ?? "Challenger spot";
        const coordMatch = coordEl?.textContent?.match(/([\d.]+),\s*([\d.]+)/);
        const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
        const lon = coordMatch ? parseFloat(coordMatch[2]) : null;
        const scores = readScoresFromDOM(resultStack);

        renderComparisonResults(pinnedSpot, { lat, lon, name: spotName, scores });
    });
    obs.observe(output, { childList: true, subtree: true });
}

function readScoresFromDOM(resultStack) {
    const scores = {};
    const keyMap = {
        "Noise": "noise", "Air quality": "airQuality", "Temperature": "temperature",
        "Humidity": "humidity", "Wind": "wind", "Rain": "rain"
    };
    resultStack.querySelectorAll(".score-list li").forEach(li => {
        const label = li.querySelector("strong")?.textContent?.trim();
        const value = li.querySelector(".score-value")?.textContent?.trim();
        const key = keyMap[label];
        if (key && value && value !== "n/a") scores[key] = parseFloat(value);
    });
    const generalEl = resultStack.querySelector(".score-display");
    const rawGeneral = generalEl?.textContent?.trim();
    if (rawGeneral && rawGeneral !== "n/a") scores.general = parseFloat(rawGeneral);
    return scores;
}

// ─── Compare mode ─────────────────────────────────────────────────────────────

function onCompareClick(spot) {
    const output = document.getElementById("output");
    const resultStack = output?.querySelector(".result-stack");
    const scores = resultStack ? readScoresFromDOM(resultStack) : spot.scores ?? {};
    pinnedSpot = { ...spot, scores };
    isCompareMode = true;

    const banner = document.getElementById("compareBanner");
    if (banner) {
        banner.querySelector(".compare-banner__name").textContent = spot.name;
        banner.classList.remove("is-hidden");
    }
    output.innerHTML = `<section class="result-card"><p class="loading">📍 Spot A pinned: "${spot.name}".<br><br>Click anywhere on the map to pick Spot B.</p></section>`;
    output.classList.remove("is-hidden");
}

function exitCompareMode() {
    pinnedSpot = null;
    isCompareMode = false;
    document.getElementById("compareBanner")?.classList.add("is-hidden");
}

// ─── Render comparison ────────────────────────────────────────────────────────

function renderComparisonResults(spotA, spotB) {
    const output = document.getElementById("output");
    if (!output) return;
    exitCompareMode();

    const aG = getWeightedGeneral(spotA.scores);
    const bG = getWeightedGeneral(spotB.scores);
    let aWinCount = 0, bWinCount = 0;

    const metricRows = METRICS.map(key => {
        const aVal = spotA.scores[key], bVal = spotB.scores[key];
        let aClass = "", bClass = "";
        if (Number.isFinite(aVal) && Number.isFinite(bVal)) {
            if (aVal > bVal)      { aClass = "compare-cell--win"; aWinCount++; }
            else if (bVal > aVal) { bClass = "compare-cell--win"; bWinCount++; }
            else                  { aClass = bClass = "compare-cell--tie"; }
        }
        return `<tr>
            <td class="compare-cell compare-cell--metric">${SCORE_LABELS[key]}</td>
            <td class="compare-cell compare-cell--a ${aClass}"><span class="${scoreColor(aVal)}">${fmt(aVal)}</span></td>
            <td class="compare-cell compare-cell--b ${bClass}"><span class="${scoreColor(bVal)}">${fmt(bVal)}</span></td>
        </tr>`;
    }).join("");

    let aGClass = "", bGClass = "", winnerBanner = "";
    if (Number.isFinite(aG) && Number.isFinite(bG)) {
        if (aG > bG)      { aGClass = "compare-cell--win"; winnerBanner = buildWinnerBanner(spotA.name, aG, "a"); }
        else if (bG > aG) { bGClass = "compare-cell--win"; winnerBanner = buildWinnerBanner(spotB.name, bG, "b"); }
        else { aGClass = bGClass = "compare-cell--tie"; winnerBanner = `<div class="winner-banner winner-banner--tie"><span class="winner-trophy">🤝</span><p class="winner-label">It's a tie!</p><p class="winner-score">${fmt(aG)} / 10</p></div>`; }
    }

    const hasWeights = !!window.__spotScoreWeights;

    output.innerHTML = `
        <div class="result-stack">
            <section class="result-card result-card--hero">
                <div class="hero-meta">
                    <span class="pill">Spot comparison</span>
                    <span class="pill pill--accent">${aWinCount} – ${bWinCount} categories</span>
                    ${hasWeights ? '<span class="pill pill--weighted">✦ Personalized</span>' : ""}
                </div>
                <h3>Head-to-head</h3>
            </section>

            ${winnerBanner}

            <section class="result-card compare-card">
                <div class="compare-header">
                    <div class="compare-header__metric"></div>
                    <div class="compare-header__spot compare-header__spot--a">
                        <span class="compare-spot-label">Spot A</span>
                        <strong class="compare-spot-name">${spotA.name}</strong>
                        <span class="compare-spot-coords">${fmtCoord(spotA.lat)}, ${fmtCoord(spotA.lon)}</span>
                    </div>
                    <div class="compare-header__spot compare-header__spot--b">
                        <span class="compare-spot-label">Spot B</span>
                        <strong class="compare-spot-name">${spotB.name}</strong>
                        <span class="compare-spot-coords">${fmtCoord(spotB.lat)}, ${fmtCoord(spotB.lon)}</span>
                    </div>
                </div>
                <table class="compare-table">
                    <tbody>
                        ${metricRows}
                        <tr class="compare-row--total">
                            <td class="compare-cell compare-cell--metric">Overall</td>
                            <td class="compare-cell compare-cell--a ${aGClass}"><span class="${scoreColor(aG)}">${fmt(aG)}</span></td>
                            <td class="compare-cell compare-cell--b ${bGClass}"><span class="${scoreColor(bG)}">${fmt(bG)}</span></td>
                        </tr>
                    </tbody>
                </table>
            </section>

            <div class="compare-actions">
                <button type="button" id="compareAgainBtn" class="btn-secondary">Compare again</button>
                <button type="button" id="backToABtn">Back to Spot A</button>
            </div>
        </div>
    `;
    output.classList.remove("is-hidden");

    document.getElementById("compareAgainBtn")?.addEventListener("click", () => onCompareClick(spotA));
    document.getElementById("backToABtn")?.addEventListener("click", () => renderFullSpotFromScores(spotA));
}

function renderFullSpotFromScores(spot) {
    const output = document.getElementById("output");
    if (!output) return;

    const weightedGeneral = getWeightedGeneral(spot.scores);
    const hasWeights = !!window.__spotScoreWeights;

    const scoreRows = METRICS.map(k => `
        <li>
            <strong>${SCORE_LABELS[k]}</strong>
            <span class="score-value ${scoreColor(spot.scores[k])}">${fmt(spot.scores[k])}</span>
        </li>`).join("");

    output.innerHTML = `
        <div class="result-stack">
            <section class="result-card result-card--hero">
                <div class="hero-meta">
                    <span class="pill">Selected spot</span>
                    <span class="pill pill--accent">Hamburg scoring</span>
                    ${hasWeights ? '<span class="pill pill--weighted">✦ Personalized</span>' : ""}
                </div>
                <h3>${spot.name}</h3>
                <p class="coordinates">${fmtCoord(spot.lat)}, ${fmtCoord(spot.lon)}</p>
            </section>

            <details class="accordion" open>
                <summary>
                    <div class="accordion__copy"><p class="accordion__eyebrow">Scoring</p><h4>Spot scores</h4></div>
                    <span class="accordion__meta ${scoreColor(weightedGeneral)}">${fmt(weightedGeneral)} / 10</span>
                </summary>
                <div class="accordion__content">
                    <ul class="score-list">${scoreRows}</ul>
                </div>
            </details>

            <section class="result-card result-card--score">
                <p class="score-kicker">General spot score</p>
                <div class="score-display ${scoreColor(weightedGeneral)}">${fmt(weightedGeneral)}</div>
                <p class="score-caption">Click the map again to reload full weather data.</p>
            </section>

            <button type="button" class="btn-compare" id="recompareBtnBack">⚖️ Compare with another spot</button>
        </div>
    `;
    output.classList.remove("is-hidden");
    document.getElementById("recompareBtnBack")?.addEventListener("click", () => onCompareClick(spot));
}

function buildWinnerBanner(name, score, side) {
    return `<div class="winner-banner winner-banner--${side}">
        <span class="winner-trophy">🏆</span>
        <div class="winner-copy"><p class="winner-label">Winner</p><p class="winner-name">${name}</p></div>
        <p class="winner-score ${scoreColor(score)}">${fmt(score)} / 10</p>
    </div>`;
}

function fmt(v) { return Number.isFinite(v) ? v.toFixed(1) : "n/a"; }
function fmtCoord(v) { return Number.isFinite(v) ? v.toFixed(5) : "–"; }