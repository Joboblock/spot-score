/**
 * onboarding.js — Sprint 3: Gewichtungs-Onboarding
 *
 * Einbinden in index.html (letzte Zeile vor </body>):
 *   <script type="module" src="./onboarding.js"></script>
 *
 * Keine Änderungen an script.js, utils.js, compare.js oder multiplayer.js.
 *
 * Was es tut:
 * - Zeigt beim ersten Besuch ein 3-Fragen-Onboarding
 * - Leitet daraus einen Gewichtungsvektor für die 6 Score-Metriken ab
 * - Patcht window.__spotScoreWeights, den compare.js + multiplayer.js
 *   bereits respektieren (via gewichteten Durchschnitt statt simplem)
 * - Gewichtung wird in localStorage gespeichert und kann jederzeit
 *   über ein Preferences-Icon neu gesetzt werden
 */

// ─── Gewichtungs-Presets ──────────────────────────────────────────────────────
// Jede Frage mappt Antworten auf einen Boost-Vektor.
// Die Vektoren werden am Ende addiert und normalisiert.

const QUESTIONS = [
    {
        id: "vibe",
        emoji: "🎯",
        question: "What kind of spot are you looking for?",
        subtitle: "This shapes what matters most.",
        answers: [
            {
                label: "Chill & relax",
                emoji: "🛋️",
                desc: "Quiet, comfortable, no stress",
                weights: { noise: 2.5, temperature: 1.5, humidity: 1.0, wind: 0.5, airQuality: 0.5, rain: 0.5 }
            },
            {
                label: "Active & outdoors",
                emoji: "🏃",
                desc: "Fresh air, some breeze, get moving",
                weights: { airQuality: 2.0, wind: 1.5, temperature: 1.5, noise: 0.5, humidity: 0.5, rain: 1.0 }
            },
            {
                label: "Work & focus",
                emoji: "💻",
                desc: "Minimal distractions, stable conditions",
                weights: { noise: 3.0, rain: 1.5, humidity: 0.5, temperature: 0.5, airQuality: 0.5, wind: 0.0 }
            },
            {
                label: "Social hangout",
                emoji: "👥",
                desc: "Good vibes for a group",
                weights: { temperature: 2.0, noise: 1.0, rain: 1.5, airQuality: 1.0, humidity: 0.5, wind: 0.5 }
            }
        ]
    },
    {
        id: "sensitivity",
        emoji: "🌡️",
        question: "How do you feel about heat?",
        subtitle: "Helps us calibrate the temperature score for you.",
        answers: [
            {
                label: "Love the sun",
                emoji: "☀️",
                desc: "The hotter the better",
                weights: { temperature: 0.5, humidity: 1.5, wind: 0.5, noise: 0.5, airQuality: 0.5, rain: 1.0 }
            },
            {
                label: "Somewhere in the middle",
                emoji: "😌",
                desc: "Not too hot, not too cold",
                weights: { temperature: 1.5, humidity: 1.0, wind: 1.0, noise: 0.5, airQuality: 0.5, rain: 0.5 }
            },
            {
                label: "Easily overheated",
                emoji: "🥵",
                desc: "Shadow and breeze please",
                weights: { temperature: 2.5, wind: 1.5, humidity: 1.5, noise: 0.0, airQuality: 0.5, rain: 0.0 }
            },
            {
                label: "Always freezing",
                emoji: "🥶",
                desc: "More warmth, less wind",
                weights: { temperature: 2.5, wind: 0.0, humidity: 0.5, noise: 0.5, airQuality: 0.5, rain: 1.0 }
            }
        ]
    },
    {
        id: "dealbreaker",
        emoji: "🚫",
        question: "What's your biggest dealbreaker?",
        subtitle: "We'll heavily penalise this in scoring.",
        answers: [
            {
                label: "Too loud",
                emoji: "🔊",
                desc: "Noise ruins everything for me",
                weights: { noise: 3.5, airQuality: 0.5, temperature: 0.5, humidity: 0.5, wind: 0.0, rain: 0.5 }
            },
            {
                label: "Bad air quality",
                emoji: "😷",
                desc: "Pollution and dust are a no-go",
                weights: { airQuality: 3.5, noise: 0.5, temperature: 0.5, humidity: 0.5, wind: 0.5, rain: 0.0 }
            },
            {
                label: "Rain or wind",
                emoji: "🌧️",
                desc: "I hate getting wet or blown around",
                weights: { rain: 2.5, wind: 1.5, temperature: 0.5, noise: 0.5, airQuality: 0.5, humidity: 0.0 }
            },
            {
                label: "Uncomfortable temp",
                emoji: "🌡️",
                desc: "Temperature makes or breaks it",
                weights: { temperature: 3.0, humidity: 1.5, wind: 0.5, noise: 0.5, airQuality: 0.0, rain: 0.0 }
            }
        ]
    }
];

const STORAGE_KEY = "spotscore_weights_v1";
const METRICS = ["noise", "airQuality", "temperature", "humidity", "wind", "rain"];

// ─── State ────────────────────────────────────────────────────────────────────

let currentStep = 0;
let selectedAnswers = {};   // { vibe: 0, sensitivity: 2, dealbreaker: 1 }

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    const saved = loadWeights();

    if (saved) {
        applyWeights(saved);
    } else {
        // First visit — show onboarding after short delay
        setTimeout(showOnboarding, 600);
    }

    injectPrefsButton();
});

// ─── Weight computation ───────────────────────────────────────────────────────

function computeWeightsFromAnswers(answers) {
    // Sum up all selected boost vectors
    const raw = { noise: 0, airQuality: 0, temperature: 0, humidity: 0, wind: 0, rain: 0 };

    QUESTIONS.forEach(q => {
        const idx = answers[q.id];
        if (idx == null) return;
        const w = q.answers[idx].weights;
        METRICS.forEach(m => { raw[m] += w[m] ?? 0; });
    });

    // Normalize so weights sum to number of metrics (keeps scale consistent)
    const total = METRICS.reduce((s, m) => s + raw[m], 0);
    const normalized = {};
    METRICS.forEach(m => {
        normalized[m] = total > 0 ? (raw[m] / total) * METRICS.length : 1;
    });

    return normalized;
}

function applyWeights(weights) {
    // Store globally so compare.js and multiplayer.js can read it
    window.__spotScoreWeights = weights;

    // Patch the scoring function used by script.js via module override trick:
    // script.js imports buildSpotScores from utils.js directly, so we can't
    // replace it there. Instead we intercept at the output level:
    // After renderPointResults runs, we re-compute and re-render the scores
    // using weighted math. The MutationObserver below handles this.
    patchScoreDisplay();
}

function weightedGeneral(scores, weights) {
    let weightedSum = 0;
    let weightTotal = 0;

    METRICS.forEach(m => {
        const score = scores[m];
        const w = weights[m] ?? 1;
        if (Number.isFinite(score)) {
            weightedSum += score * w;
            weightTotal += w;
        }
    });

    return weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 10) / 10 : null;
}

// ─── DOM patch: re-render score display after renderPointResults ───────────────

function patchScoreDisplay() {
    const output = document.getElementById("output");
    if (!output) return;

    const observer = new MutationObserver(() => {
        const weights = window.__spotScoreWeights;
        if (!weights) return;

        const resultStack = output.querySelector(".result-stack");
        if (!resultStack) return;

        // Already patched this render
        if (resultStack.dataset.weightPatched === "1") return;
        resultStack.dataset.weightPatched = "1";

        // Read individual scores from DOM
        const scores = readScoresFromDOM(resultStack);
        if (!Object.keys(scores).length) return;

        const weighted = weightedGeneral(scores, weights);
        if (!Number.isFinite(weighted)) return;

        // Update score display
        const scoreDisplay = resultStack.querySelector(".score-display");
        if (scoreDisplay) scoreDisplay.textContent = weighted.toFixed(1);

        const accordionMeta = resultStack.querySelector(".accordion[open] .accordion__meta");
        if (accordionMeta && accordionMeta.textContent.includes("/")) {
            accordionMeta.textContent = `${weighted.toFixed(1)} / 10`;
        }

        // Add weight badge to hero card
        const heroPills = resultStack.querySelector(".hero-meta");
        if (heroPills && !heroPills.querySelector(".pill--weighted")) {
            const badge = document.createElement("span");
            badge.className = "pill pill--weighted";
            badge.textContent = "✦ Personalized";
            badge.title = "Score weighted by your preferences";
            heroPills.appendChild(badge);
        }
    });

    observer.observe(output, { childList: true, subtree: false });
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
    return scores;
}

// ─── Onboarding UI ────────────────────────────────────────────────────────────

function showOnboarding() {
    const existing = document.getElementById("onboardingOverlay");
    if (existing) existing.remove();

    currentStep = 0;
    selectedAnswers = {};

    const overlay = document.createElement("div");
    overlay.id = "onboardingOverlay";
    overlay.className = "ob-overlay";
    overlay.innerHTML = `
        <div class="ob-box">
            <div class="ob-progress" id="obProgress">
                <div class="ob-progress__bar" id="obProgressBar"></div>
            </div>
            <div class="ob-content" id="obContent"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    renderStep(0);
}

function renderStep(stepIndex) {
    const content = document.getElementById("obContent");
    const progressBar = document.getElementById("obProgressBar");
    if (!content) return;

    const q = QUESTIONS[stepIndex];
    const progress = ((stepIndex) / QUESTIONS.length) * 100;
    progressBar.style.width = `${progress}%`;

    const isLast = stepIndex === QUESTIONS.length - 1;

    content.innerHTML = `
        <div class="ob-step" data-step="${stepIndex}">
            <div class="ob-step__top">
                <span class="ob-step__counter">${stepIndex + 1} / ${QUESTIONS.length}</span>
                <div class="ob-step__emoji">${q.emoji}</div>
                <h2 class="ob-step__question">${q.question}</h2>
                <p class="ob-step__subtitle">${q.subtitle}</p>
            </div>
            <div class="ob-answers" id="obAnswers">
                ${q.answers.map((a, i) => `
                    <button class="ob-answer" data-index="${i}" type="button">
                        <span class="ob-answer__emoji">${a.emoji}</span>
                        <div class="ob-answer__text">
                            <strong>${a.label}</strong>
                            <span>${a.desc}</span>
                        </div>
                        <span class="ob-answer__check">✓</span>
                    </button>
                `).join("")}
            </div>
            <div class="ob-step__footer">
                <button class="ob-btn ob-btn--ghost" id="obSkipBtn" type="button">
                    ${stepIndex === 0 ? "Skip setup" : "Skip question"}
                </button>
                <button class="ob-btn ob-btn--primary" id="obNextBtn" type="button" disabled>
                    ${isLast ? "See my scores →" : "Next →"}
                </button>
            </div>
        </div>
    `;

    // Restore previously selected answer if user went back (not implemented but future-proof)
    const prevIdx = selectedAnswers[q.id];
    if (prevIdx != null) {
        const btn = content.querySelector(`.ob-answer[data-index="${prevIdx}"]`);
        if (btn) { btn.classList.add("is-selected"); content.querySelector("#obNextBtn").disabled = false; }
    }

    // Answer selection
    content.querySelectorAll(".ob-answer").forEach(btn => {
        btn.addEventListener("click", () => {
            content.querySelectorAll(".ob-answer").forEach(b => b.classList.remove("is-selected"));
            btn.classList.add("is-selected");
            selectedAnswers[q.id] = parseInt(btn.dataset.index);
            content.querySelector("#obNextBtn").disabled = false;
        });
    });

    content.querySelector("#obNextBtn").addEventListener("click", () => {
        if (stepIndex < QUESTIONS.length - 1) {
            renderStep(stepIndex + 1);
        } else {
            finishOnboarding();
        }
    });

    content.querySelector("#obSkipBtn").addEventListener("click", () => {
        if (stepIndex === 0) {
            // Skip entire setup → use equal weights
            closeOnboarding();
            saveWeights(getEqualWeights());
            applyWeights(getEqualWeights());
        } else {
            // Skip this question, continue
            if (stepIndex < QUESTIONS.length - 1) {
                renderStep(stepIndex + 1);
            } else {
                finishOnboarding();
            }
        }
    });

    // Animate in
    requestAnimationFrame(() => {
        content.querySelector(".ob-step")?.classList.add("ob-step--visible");
    });
}

function finishOnboarding() {
    const weights = computeWeightsFromAnswers(selectedAnswers);

    // Show result screen
    const content = document.getElementById("obContent");
    const progressBar = document.getElementById("obProgressBar");
    progressBar.style.width = "100%";

    const topMetric = METRICS.reduce((a, b) => weights[a] > weights[b] ? a : b);
    const metricLabels = { noise: "Quiet spots", airQuality: "Fresh air", temperature: "Perfect temp", humidity: "Comfortable humidity", wind: "Ideal breeze", rain: "Dry conditions" };
    const metricEmojis = { noise: "🔇", airQuality: "🌿", temperature: "🌡️", humidity: "💧", wind: "🍃", rain: "☀️" };

    // Build weight bars
    const maxW = Math.max(...METRICS.map(m => weights[m]));
    const weightBars = METRICS.map(m => {
        const pct = Math.round((weights[m] / maxW) * 100);
        const label = metricLabels[m];
        return `
            <div class="ob-weight-row">
                <span class="ob-weight-label">${label}</span>
                <div class="ob-weight-bar-track">
                    <div class="ob-weight-bar-fill" style="width: ${pct}%"></div>
                </div>
                <span class="ob-weight-value">${weights[m].toFixed(1)}×</span>
            </div>
        `;
    }).join("");

    content.innerHTML = `
        <div class="ob-step ob-step--result ob-step--visible">
            <div class="ob-step__top">
                <div class="ob-step__emoji">✦</div>
                <h2 class="ob-step__question">Your spot profile</h2>
                <p class="ob-step__subtitle">Scores are now personalized for you. Priority: <strong>${metricEmojis[topMetric]} ${metricLabels[topMetric]}</strong></p>
            </div>
            <div class="ob-weights-display">
                ${weightBars}
            </div>
            <div class="ob-step__footer ob-step__footer--single">
                <button class="ob-btn ob-btn--primary" id="obDoneBtn" type="button">Start exploring →</button>
            </div>
        </div>
    `;

    document.getElementById("obDoneBtn").addEventListener("click", () => {
        saveWeights(weights);
        applyWeights(weights);
        closeOnboarding();
        showToast(`✦ Scores personalized for you`);
    });
}

function closeOnboarding() {
    const overlay = document.getElementById("onboardingOverlay");
    if (!overlay) return;
    overlay.classList.add("ob-overlay--out");
    setTimeout(() => overlay.remove(), 350);
}

// ─── Preferences button ───────────────────────────────────────────────────────

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

function saveWeights(weights) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(weights)); } catch (_) {}
}

function loadWeights() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && METRICS.every(m => typeof parsed[m] === "number")) return parsed;
    } catch (_) {}
    return null;
}

function getEqualWeights() {
    const w = {};
    METRICS.forEach(m => { w[m] = 1; });
    return w;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg) {
    const toast = document.createElement("div");
    toast.className = "mp-toast"; // reuse multiplayer toast styles
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("mp-toast--show"));
    setTimeout(() => { toast.classList.remove("mp-toast--show"); setTimeout(() => toast.remove(), 300); }, 2800);
}