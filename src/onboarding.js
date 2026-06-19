/**
 * Onboarding.js — v4
 * Adapted for separated temperature & sun scores.
 * Fixes: Score-Farben auch ohne Weights, Weight-Bars animieren, kein Radar, kein Find-Best
 * Metrics: noise, airQuality, temperature, humidity, wind, sun, rain
 */

const QUESTIONS = [
    {
        id: "vibe", emoji: "🎯",
        question: "What kind of spot are you looking for?",
        subtitle: "This shapes what matters most.",
        answers: [
            { label: "Chill & relax",     emoji: "🛋️", desc: "Quiet, comfortable, no stress",          weights: { noise: 2.5, temperature: 1.5, humidity: 1.0, wind: 0.5, airQuality: 0.5, rain: 0.5, sun: 1.0 } },
            { label: "Active & outdoors", emoji: "🏃", desc: "Fresh air, some breeze, get moving",     weights: { airQuality: 2.0, wind: 1.5, temperature: 1.5, noise: 0.5, humidity: 0.5, rain: 1.0, sun: 1.5 } },
            { label: "Work & focus",      emoji: "💻", desc: "Minimal distractions, stable conditions", weights: { noise: 3.0, rain: 1.5, humidity: 0.5, temperature: 0.5, airQuality: 0.5, wind: 0.0, sun: 0.5 } },
            { label: "Social hangout",    emoji: "👥", desc: "Good vibes for a group",                 weights: { temperature: 2.0, noise: 1.0, rain: 1.5, airQuality: 1.0, humidity: 0.5, wind: 0.5, sun: 1.0 } }
        ]
    },
    {
        id: "sensitivity", emoji: "🌡️",
        question: "How do you feel about heat?",
        subtitle: "Helps us calibrate the temperature score for you.",
        answers: [
            { label: "Love the heat",         emoji: "☀️", desc: "The warmer the better",          weights: { temperature: 2.5, humidity: 1.0, wind: 0.5, noise: 0.5, airQuality: 0.5, rain: 1.0, sun: 0.5 } },
            { label: "Somewhere in between",  emoji: "😌", desc: "Not too hot, not too cold",     weights: { temperature: 1.5, humidity: 1.0, wind: 1.0, noise: 0.5, airQuality: 0.5, rain: 0.5, sun: 0.5 } },
            { label: "Easily overheated",     emoji: "🥵", desc: "Shade and breeze please",       weights: { temperature: 2.5, wind: 1.5, humidity: 1.5, noise: 0.0, airQuality: 0.5, rain: 0.0, sun: 0.0 } },
            { label: "Always freezing",       emoji: "🥶", desc: "More warmth, less wind",        weights: { temperature: 2.5, wind: 0.0, humidity: 0.5, noise: 0.5, airQuality: 0.5, rain: 1.0, sun: 1.5 } }
        ]
    },
    {
        id: "sunpref", emoji: "☀️",
        question: "How much sun do you want?",
        subtitle: "This tunes sun exposure weight independently from temperature.",
        answers: [
            { label: "Love bright, sunny spots", emoji: "😎", desc: "Bring on the sunshine",       weights: { sun: 3.0, temperature: 0.5, humidity: 0.5, wind: 0.5, noise: 0.5, airQuality: 0.5, rain: 1.0 } },
            { label: "Some sun is nice",         emoji: "🌤️", desc: "A bit of both is great",     weights: { sun: 1.5, temperature: 1.0, humidity: 1.0, wind: 1.0, noise: 0.5, airQuality: 0.5, rain: 0.5 } },
            { label: "Prefer shady spots",       emoji: "🌳", desc: "Keep me in the shade",        weights: { sun: 0.0, temperature: 1.5, wind: 1.0, humidity: 1.0, noise: 0.5, airQuality: 0.5, rain: 0.5 } },
            { label: "Don't care about sun",     emoji: "🤷", desc: "Sun doesn't affect my choice", weights: { sun: 0.5, temperature: 1.0, humidity: 1.0, wind: 1.0, noise: 0.5, airQuality: 0.5, rain: 1.0 } }
        ]
    },
    {
        id: "dealbreaker", emoji: "🚫",
        question: "What's your biggest dealbreaker?",
        subtitle: "We'll heavily penalise this in scoring.",
        answers: [
            { label: "Too loud",           emoji: "🔊", desc: "Noise ruins everything for me",      weights: { noise: 3.5, airQuality: 0.5, temperature: 0.5, humidity: 0.5, wind: 0.0, rain: 0.5, sun: 0.5 } },
            { label: "Bad air quality",    emoji: "😷", desc: "Pollution and dust are a no-go",    weights: { airQuality: 3.5, noise: 0.5, temperature: 0.5, humidity: 0.5, wind: 0.5, rain: 0.0, sun: 0.5 } },
            { label: "Rain or wind",       emoji: "🌧️", desc: "I hate getting wet or blown around", weights: { rain: 2.5, wind: 1.5, temperature: 0.5, noise: 0.5, airQuality: 0.5, humidity: 0.0, sun: 0.5 } },
            { label: "Uncomfortable temp", emoji: "🌡️", desc: "Temperature makes or breaks it",    weights: { temperature: 3.0, humidity: 1.5, wind: 0.5, noise: 0.5, airQuality: 0.0, rain: 0.0, sun: 1.5 } }
        ]
    }
];

const STORAGE_KEY = "spotscore_weights_v1";
const METRICS = ["noise", "airQuality", "temperature", "humidity", "wind", "sun", "rain"];
const METRIC_LABELS = { noise: "Quiet spots", airQuality: "Fresh air", temperature: "Temperature", humidity: "Humidity", wind: "Wind comfort", sun: "Sun exposure", rain: "Dry conditions" };
const METRIC_EMOJIS = { noise: "🔇", airQuality: "🌿", temperature: "🌡️", humidity: "💧", wind: "🍃", sun: "☀️", rain: "☀️" };

let currentStep = 0;
let selectedAnswers = {};

document.addEventListener("DOMContentLoaded", () => {
    const saved = loadWeights();
    if (saved) {
        applyWeights(saved);
    } else {
        setTimeout(showOnboarding, 700);
    }
    injectPrefsButton();
    // Always patch score colors, even without weights
    watchOutputForScoreColors();
});

// ─── Weight math ──────────────────────────────────────────────────────────────

function computeWeightsFromAnswers(answers) {
    const raw = Object.fromEntries(METRICS.map(m => [m, 0]));
    QUESTIONS.forEach(q => {
        const idx = answers[q.id];
        if (idx == null) return;
        const w = q.answers[idx].weights;
        METRICS.forEach(m => { raw[m] += w[m] ?? 0; });
    });
    const total = METRICS.reduce((s, m) => s + raw[m], 0);
    const normalized = {};
    METRICS.forEach(m => { normalized[m] = total > 0 ? (raw[m] / total) * METRICS.length : 1; });
    return normalized;
}

function applyWeights(weights) {
    window.__spotScoreWeights = weights;
}

function weightedGeneral(scores, weights) {
    let sum = 0, total = 0;
    METRICS.forEach(m => {
        const s = scores[m]; const w = weights[m] ?? 1;
        if (Number.isFinite(s)) { sum += s * w; total += w; }
    });
    return total > 0 ? Math.round((sum / total) * 10) / 10 : null;
}

function scoreColor(v) {
    if (!Number.isFinite(v)) return "";
    if (v >= 7) return "score--good";
    if (v >= 4.5) return "score--mid";
    return "score--bad";
}

// ─── Always-on score color patch (works with AND without weights) ─────────────

function watchOutputForScoreColors() {
    const output = document.getElementById("output");
    if (!output) return;

    const observer = new MutationObserver(() => {
        const resultStack = output.querySelector(".result-stack");
        if (!resultStack) return;
        if (resultStack.dataset.colorPatched === "1") return;
        resultStack.dataset.colorPatched = "1";

        const weights = window.__spotScoreWeights;

        // Color individual score values
        resultStack.querySelectorAll(".score-list li").forEach(li => {
            const el = li.querySelector(".score-value");
            if (!el) return;
            const v = parseFloat(el.textContent);
            if (Number.isFinite(v)) el.classList.add(scoreColor(v));
        });

        // If weights set: recalculate general score and color everything
        if (weights) {
            const scores = readScoresFromDOM(resultStack);
            const weighted = weightedGeneral(scores, weights);
            if (!Number.isFinite(weighted)) return;

            const scoreDisplay = resultStack.querySelector(".score-display");
            if (scoreDisplay) {
                scoreDisplay.textContent = weighted.toFixed(1);
                scoreDisplay.className = `score-display ${scoreColor(weighted)}`;
            }

            resultStack.querySelectorAll(".accordion__meta").forEach(el => {
                if (el.textContent.includes("/ 10")) {
                    el.textContent = `${weighted.toFixed(1)} / 10`;
                    el.className = `accordion__meta ${scoreColor(weighted)}`;
                }
            });

            // Personalized badge
            const heroPills = resultStack.querySelector(".hero-meta");
            if (heroPills && !heroPills.querySelector(".pill--weighted")) {
                const badge = document.createElement("span");
                badge.className = "pill pill--weighted";
                badge.textContent = "✦ Personalized";
                heroPills.appendChild(badge);
            }
        } else {
            // No weights — just color the existing general score
            const scoreDisplay = resultStack.querySelector(".score-display");
            if (scoreDisplay) {
                const v = parseFloat(scoreDisplay.textContent);
                if (Number.isFinite(v)) scoreDisplay.classList.add(scoreColor(v));
            }
            resultStack.querySelectorAll(".accordion__meta").forEach(el => {
                if (el.textContent.includes("/ 10")) {
                    const v = parseFloat(el.textContent);
                    if (Number.isFinite(v)) el.classList.add(scoreColor(v));
                }
            });
        }
    });

    observer.observe(output, { childList: true, subtree: false });
}

function readScoresFromDOM(resultStack) {
    const scores = {};
    const keyMap = { "Noise": "noise", "Air quality": "airQuality", "Temperature": "temperature", "Humidity": "humidity", "Wind": "wind", "Sun": "sun", "Rain": "rain" };
    resultStack.querySelectorAll(".score-list li").forEach(li => {
        const label = li.querySelector("strong")?.textContent?.trim();
        const value = li.querySelector(".score-value")?.textContent?.trim();
        const key = keyMap[label];
        if (key && value && value !== "n/a") scores[key] = parseFloat(value);
    });
    return scores;
}

// ─── Onboarding UI ────────────────────────────────────────────────────────────

function showOnboarding() {
    document.getElementById("onboardingOverlay")?.remove();
    currentStep = 0;
    selectedAnswers = {};

    const overlay = document.createElement("div");
    overlay.id = "onboardingOverlay";
    overlay.className = "ob-overlay";
    overlay.innerHTML = `
        <div class="ob-box">
            <div class="ob-progress"><div class="ob-progress__bar" id="obProgressBar"></div></div>
            <div class="ob-content" id="obContent"></div>
        </div>`;
    document.body.appendChild(overlay);
    renderStep(0);
}

function renderStep(stepIndex) {
    const content = document.getElementById("obContent");
    const progressBar = document.getElementById("obProgressBar");
    if (!content) return;

    progressBar.style.width = `${(stepIndex / QUESTIONS.length) * 100}%`;
    const q = QUESTIONS[stepIndex];
    const isLast = stepIndex === QUESTIONS.length - 1;

    content.innerHTML = `
        <div class="ob-step" data-step="${stepIndex}">
            <div class="ob-step__top">
                <span class="ob-step__counter">${stepIndex + 1} / ${QUESTIONS.length}</span>
                <div class="ob-step__emoji">${q.emoji}</div>
                <h2 class="ob-step__question">${q.question}</h2>
                <p class="ob-step__subtitle">${q.subtitle}</p>
            </div>
            <div class="ob-answers">
                ${q.answers.map((a, i) => `
                    <button class="ob-answer" data-index="${i}" type="button">
                        <span class="ob-answer__emoji">${a.emoji}</span>
                        <div class="ob-answer__text"><strong>${a.label}</strong><span>${a.desc}</span></div>
                        <span class="ob-answer__check">✓</span>
                    </button>`).join("")}
            </div>
            <div class="ob-step__footer">
                <button class="ob-btn ob-btn--ghost" id="obSkipBtn" type="button">
                    ${stepIndex === 0 ? "Skip setup" : "Skip question"}
                </button>
                <button class="ob-btn ob-btn--primary" id="obNextBtn" type="button" disabled>
                    ${isLast ? "See my profile →" : "Next →"}
                </button>
            </div>
        </div>`;

    const prevIdx = selectedAnswers[q.id];
    if (prevIdx != null) {
        content.querySelector(`.ob-answer[data-index="${prevIdx}"]`)?.classList.add("is-selected");
        content.querySelector("#obNextBtn").disabled = false;
    }

    content.querySelectorAll(".ob-answer").forEach(btn => {
        btn.addEventListener("click", () => {
            content.querySelectorAll(".ob-answer").forEach(b => b.classList.remove("is-selected"));
            btn.classList.add("is-selected");
            selectedAnswers[q.id] = parseInt(btn.dataset.index);
            content.querySelector("#obNextBtn").disabled = false;
        });
    });

    content.querySelector("#obNextBtn").addEventListener("click", () => {
        if (stepIndex < QUESTIONS.length - 1) renderStep(stepIndex + 1);
        else finishOnboarding();
    });

    content.querySelector("#obSkipBtn").addEventListener("click", () => {
        if (stepIndex === 0) {
            const eq = getEqualWeights();
            saveWeights(eq); applyWeights(eq); closeOnboarding();
        } else {
            if (stepIndex < QUESTIONS.length - 1) renderStep(stepIndex + 1);
            else finishOnboarding();
        }
    });

    requestAnimationFrame(() => content.querySelector(".ob-step")?.classList.add("ob-step--visible"));
}

function finishOnboarding() {
    const weights = computeWeightsFromAnswers(selectedAnswers);
    const content = document.getElementById("obContent");
    document.getElementById("obProgressBar").style.width = "100%";

    const topMetric = METRICS.reduce((a, b) => weights[a] > weights[b] ? a : b);
    const maxW = Math.max(...METRICS.map(m => weights[m]));

    // Build bars starting at width 0 — JS will animate them after render
    const weightBars = METRICS.map(m => {
        const pct = Math.round((weights[m] / maxW) * 100);
        return `
            <div class="ob-weight-row">
                <span class="ob-weight-label">${METRIC_LABELS[m]}</span>
                <div class="ob-weight-bar-track">
                    <div class="ob-weight-bar-fill" data-target="${pct}" style="width:0%"></div>
                </div>
                <span class="ob-weight-value">${weights[m].toFixed(1)}×</span>
            </div>`;
    }).join("");

    content.innerHTML = `
        <div class="ob-step ob-step--result ob-step--visible">
            <div class="ob-step__top">
                <div class="ob-step__emoji">✦</div>
                <h2 class="ob-step__question">Your spot profile</h2>
                <p class="ob-step__subtitle">Priority: <strong>${METRIC_EMOJIS[topMetric]} ${METRIC_LABELS[topMetric]}</strong></p>
            </div>
            <div class="ob-weights-display">${weightBars}</div>
            <div class="ob-step__footer ob-step__footer--single">
                <button class="ob-btn ob-btn--primary" id="obDoneBtn" type="button">Start exploring →</button>
            </div>
        </div>`;

    // Animate bars: wait two frames so CSS transition fires from 0 → target
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            content.querySelectorAll(".ob-weight-bar-fill").forEach(el => {
                el.style.width = `${el.dataset.target}%`;
            });
        });
    });

    document.getElementById("obDoneBtn").addEventListener("click", () => {
        saveWeights(weights);
        applyWeights(weights);
        closeOnboarding();
        showToast("✦ Scores personalized for you!");
    });
}

function closeOnboarding() {
    const overlay = document.getElementById("onboardingOverlay");
    if (!overlay) return;
    overlay.classList.add("ob-overlay--out");
    setTimeout(() => overlay.remove(), 350);
}

// ─── Prefs button ─────────────────────────────────────────────────────────────

function injectPrefsButton() {
    const btn = document.createElement("button");
    btn.id = "prefsBtn";
    btn.className = "prefs-btn";
    btn.title = "Adjust score preferences";
    btn.innerHTML = `<span>✦</span>`;
    btn.addEventListener("click", showOnboarding);
    document.body.appendChild(btn);
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function saveWeights(weights) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(weights)); } catch (_) {} }
function loadWeights() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && METRICS.every(m => typeof parsed[m] === "number")) return parsed;
    } catch (_) {}
    return null;
}
function getEqualWeights() { return Object.fromEntries(METRICS.map(m => [m, 1])); }

function showToast(msg) {
    const toast = document.createElement("div");
    toast.className = "mp-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("mp-toast--show"));
    setTimeout(() => { toast.classList.remove("mp-toast--show"); setTimeout(() => toast.remove(), 300); }, 3000);
}