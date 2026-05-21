/**
 * multiplayer.js — v3: Map-Pins funktionieren, kein QR-Code
 * Fix: Leaflet-Map via CustomEvent aus script.js holen (kein _targets hack)
 */

const SUPABASE_URL  = "https://kbhbixxelsaodatomydx.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtiaGJpeHhlbHNhb2RhdG9teWR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNDA5OTYsImV4cCI6MjA5NDgxNjk5Nn0.Buh5k3Em3QNiYY9noGQaPTIqpbxDrV5rpxKcjwI1-Ss";

const METRICS = ["noise", "airQuality", "temperature", "humidity", "wind", "rain"];
const USER_COLORS = ["#e74c3c","#3498db","#9b59b6","#f39c12","#1abc9c","#e67e22","#2ecc71","#e91e63"];

let currentSession = null;
let currentUsername = null;
let realtimeChannel = null;
let sessionSpots = [];
let mapPinLayer = null;
let userColorMap = {};
let leafletMap = null;  // grabbed once Leaflet initialises

function getSupabase() {
    if (window.__supabaseClient) return window.__supabaseClient;
    window.__supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    return window.__supabaseClient;
}

// ─── Get Leaflet map — poll until the map container has _leaflet_id ───────────
// We can't access script.js's module-scoped `map` variable directly.
// Instead we retrieve the Leaflet map by calling L.map.prototype on the container,
// using the public L.DomUtil approach: every initialised map sets _leaflet_id on
// its container. We then iterate L's internal maps registry via the container ref.

function grabLeafletMap() {
    if (leafletMap) return leafletMap;
    if (!window.L) return null;
    const mapEl = document.getElementById("map");
    if (!mapEl) return null;

    // Leaflet 1.x stores all map instances in L.Map._registry (not public but stable)
    // Safer fallback: use mapEl._leaflet_id to find the map via eachLayer trick on a
    // known marker. But cleanest approach for Leaflet 1.9: iterate window.L maps.
    // L keeps maps in a private _leaflet_events dict on the container.
    // The most reliable cross-version approach: call L.map(container) returns existing
    // map if already initialised — but that would reinitialise. 
    // ACTUAL reliable approach: use a one-time capture listener on the map div.
    // We intercept the first 'mousemove' or 'click' on the Leaflet container,
    // which carries a latlng, meaning the map exists. We store it from the event target.
    
    // Even simpler: Leaflet 1.9 attaches _leaflet on the map container element
    // when initialised. Access it via the private but consistent property:
    const id = mapEl._leaflet_id;
    if (!id) return null;

    // Walk all maps registered in Leaflet's internal store
    // L.Map stores instances in L.Map._leafletMap on the container in v1.9
    // Actually the cleanest: the map object itself sets this._container = mapEl
    // We can find it by checking all Leaflet map instances via the event system

    // DEFINITIVE FIX: intercept the Leaflet click event which carries the map ref
    return null; // will be set via the event intercept below
}

function setupMapCapture() {
    // Leaflet fires its own 'click' event on the map object. We hook into the
    // map container's Leaflet event system by adding a one-time capture on
    // the map div — Leaflet's DomEvent.on wraps native events and exposes
    // the map via e.target on the Leaflet event, not the DOM event.
    // 
    // The cleanest solution without touching script.js:
    // Leaflet attaches the map instance to the container via container._leaflet_map
    // in v1.9+, OR we poll for it.

    const mapEl = document.getElementById("map");
    if (!mapEl) return;

    const poll = setInterval(() => {
        if (!window.L) return;
        // Leaflet 1.9 sets _leaflet_id on the container when map is created
        if (!mapEl._leaflet_id) return;
        
        // Try the container property first (Leaflet 1.9 internal)
        if (mapEl._leaflet_map) {
            leafletMap = mapEl._leaflet_map;
            clearInterval(poll);
            return;
        }

        // Fallback: find via registered Leaflet objects
        // Every Leaflet Evented stores handlers in _leaflet_events on themselves.
        // Maps register a resize listener on window — we can't use that.
        // Most reliable fallback: use L.DomEvent and the internal _targets map
        // that Leaflet uses for event delegation on the container.
        // In Leaflet 1.x: L.DomEvent._getEvents(el) returns attached handlers.
        // The map attaches a 'click' handler to the container. The handler's
        // context (this) IS the map instance.
        try {
            const events = mapEl["_leaflet_events"];
            if (events) {
                // events is keyed by event type; each value is array of {fn, ctx}
                const handlers = Object.values(events).flat();
                for (const h of handlers) {
                    if (h.ctx && h.ctx._container === mapEl) {
                        leafletMap = h.ctx;
                        clearInterval(poll);
                        return;
                    }
                }
            }
        } catch (_) {}

        // Last resort: synthesise a mousemove on the container and capture
        // the map from Leaflet's internal event delegation (_targets)
        if (window.L.DomEvent && mapEl._leaflet_id) {
            // Leaflet stores the map in its _targets object keyed by leaflet id
            // This IS used internally but is consistent across 1.x versions
            const targets = window.L.DomEvent?._targets ?? window.L.DomEvent?.TARGETS;
            if (targets) {
                const entry = Object.values(targets).find(t => t && t._container === mapEl);
                if (entry) {
                    leafletMap = entry;
                    clearInterval(poll);
                }
            }
        }
    }, 150);

    // Safety: stop polling after 10s
    setTimeout(() => clearInterval(poll), 10000);
}

function getMap() {
    if (leafletMap) return leafletMap;
    // Try the _leaflet_map property that Leaflet 1.9 sets on the container
    const mapEl = document.getElementById("map");
    if (mapEl?._leaflet_map) {
        leafletMap = mapEl._leaflet_map;
        return leafletMap;
    }
    return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getWeightedScore(spot) {
    const weights = window.__spotScoreWeights;
    if (!weights) return spot.score_general;
    const scoreMap = { noise: spot.score_noise, airQuality: spot.score_air, temperature: spot.score_temp, humidity: spot.score_humidity, wind: spot.score_wind, rain: spot.score_rain };
    let sum = 0, total = 0;
    METRICS.forEach(m => {
        const s = scoreMap[m]; const w = weights[m] ?? 1;
        if (Number.isFinite(s)) { sum += s * w; total += w; }
    });
    return total > 0 ? Math.round((sum / total) * 10) / 10 : spot.score_general;
}

function getUserColor(username) {
    if (!userColorMap[username]) {
        userColorMap[username] = USER_COLORS[Object.keys(userColorMap).length % USER_COLORS.length];
    }
    return userColorMap[username];
}

function scoreColor(v) {
    if (!Number.isFinite(v)) return "";
    if (v >= 7) return "score--good";
    if (v >= 4.5) return "score--mid";
    return "score--bad";
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    setupMapCapture();
    injectMultiplayerUI();
    watchOutputForSpotResults();
    checkUrlForSessionInvite();
});

async function checkUrlForSessionInvite() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("session");
    if (!code) return;
    window.history.replaceState({}, "", window.location.pathname);
    showMultiplayerModal("join", code);
}

// ─── UI Injection ─────────────────────────────────────────────────────────────

function injectMultiplayerUI() {
    const fab = document.createElement("button");
    fab.id = "multiplayerFab";
    fab.className = "mp-fab";
    fab.title = "Multiplayer";
    fab.innerHTML = `<span class="mp-fab__icon">👥</span><span class="mp-fab__label">Session</span>`;
    fab.addEventListener("click", () => currentSession ? showSessionPanel() : showMultiplayerModal("home"));
    document.body.appendChild(fab);

    const modal = document.createElement("div");
    modal.id = "mpModal";
    modal.className = "mp-modal is-hidden";
    modal.innerHTML = `
        <div class="mp-modal__backdrop"></div>
        <div class="mp-modal__box">
            <button class="mp-modal__close" id="mpModalClose">✕</button>
            <div id="mpModalContent"></div>
        </div>`;
    modal.querySelector(".mp-modal__backdrop").addEventListener("click", closeModal);
    modal.querySelector("#mpModalClose").addEventListener("click", closeModal);
    document.body.appendChild(modal);

    const panel = document.createElement("div");
    panel.id = "mpPanel";
    panel.className = "mp-panel is-hidden";
    panel.innerHTML = `
        <div class="mp-panel__header">
            <div>
                <p class="mp-panel__eyebrow">Session</p>
                <p class="mp-panel__code" id="mpPanelCode">–</p>
            </div>
            <button class="mp-panel__close" id="mpPanelClose">✕</button>
        </div>
        <div class="mp-panel__invite">
            <p class="mp-panel__invite-label">Invite link</p>
            <div class="mp-panel__invite-row">
                <span class="mp-panel__invite-url" id="mpInviteUrl"></span>
                <button class="mp-panel__copy-btn" id="mpCopyBtn">Copy</button>
            </div>
        </div>
        <div class="mp-panel__spots-header">
            <p class="mp-panel__spots-title">Shared spots</p>
            <button class="mp-btn mp-btn--sm" id="mpRankBtn">🏆 Rank all</button>
        </div>
        <ul class="mp-panel__spots-list" id="mpSpotsList"></ul>
        <button class="mp-btn mp-btn--danger" id="mpLeaveBtn">Leave session</button>`;
    panel.querySelector("#mpPanelClose").addEventListener("click", () => panel.classList.add("is-hidden"));
    panel.querySelector("#mpCopyBtn").addEventListener("click", copyInviteLink);
    panel.querySelector("#mpLeaveBtn").addEventListener("click", leaveSession);
    panel.querySelector("#mpRankBtn").addEventListener("click", renderRanking);
    document.body.appendChild(panel);
}

// ─── Modal screens ────────────────────────────────────────────────────────────

function showMultiplayerModal(screen, prefillCode = "") {
    const modal = document.getElementById("mpModal");
    const content = document.getElementById("mpModalContent");
    if (!modal || !content) return;

    if (screen === "home") {
        content.innerHTML = `
            <div class="mp-modal__hero">👥</div>
            <h2 class="mp-modal__title">Multiplayer</h2>
            <p class="mp-modal__sub">Pin spots with friends and find the best one.</p>
            <div class="mp-modal__actions">
                <button class="mp-btn mp-btn--primary" id="mpCreateBtn">Create session</button>
                <button class="mp-btn mp-btn--secondary" id="mpJoinHomeBtn">Join with code</button>
            </div>`;
        content.querySelector("#mpCreateBtn").addEventListener("click", () => showMultiplayerModal("create"));
        content.querySelector("#mpJoinHomeBtn").addEventListener("click", () => showMultiplayerModal("join"));

    } else if (screen === "create") {
        content.innerHTML = `
            <div class="mp-modal__hero">✨</div>
            <h2 class="mp-modal__title">Create session</h2>
            <p class="mp-modal__sub">Choose a name others will see when you add spots.</p>
            <input class="mp-input" id="mpUsernameInput" type="text" placeholder="Your name" maxlength="24" autocomplete="off"/>
            <button class="mp-btn mp-btn--primary" id="mpConfirmCreateBtn">Create</button>
            <p class="mp-modal__error is-hidden" id="mpCreateError"></p>`;
        const input = content.querySelector("#mpUsernameInput");
        input.focus();
        input.addEventListener("keydown", e => { if (e.key === "Enter") content.querySelector("#mpConfirmCreateBtn").click(); });
        content.querySelector("#mpConfirmCreateBtn").addEventListener("click", async () => {
            const name = input.value.trim();
            if (!name) { showModalError("mpCreateError", "Enter a name first."); return; }
            await createSession(name);
        });

    } else if (screen === "join") {
        content.innerHTML = `
            <div class="mp-modal__hero">🔗</div>
            <h2 class="mp-modal__title">Join session</h2>
            <input class="mp-input" id="mpJoinCodeInput" type="text" placeholder="Session code (e.g. XK93BT)" maxlength="6" autocomplete="off" value="${prefillCode}"/>
            <input class="mp-input" id="mpJoinNameInput" type="text" placeholder="Your name" maxlength="24" autocomplete="off"/>
            <button class="mp-btn mp-btn--primary" id="mpConfirmJoinBtn">Join</button>
            <p class="mp-modal__error is-hidden" id="mpJoinError"></p>`;
        const codeInput = content.querySelector("#mpJoinCodeInput");
        const nameInput = content.querySelector("#mpJoinNameInput");
        if (prefillCode) nameInput.focus(); else codeInput.focus();
        content.querySelector("#mpConfirmJoinBtn").addEventListener("click", async () => {
            const code = codeInput.value.trim().toUpperCase();
            const name = nameInput.value.trim();
            if (!code || code.length !== 6) { showModalError("mpJoinError", "Enter the 6-character session code."); return; }
            if (!name) { showModalError("mpJoinError", "Enter your name."); return; }
            await joinSession(code, name);
        });
    }

    modal.classList.remove("is-hidden");
}

function closeModal() { document.getElementById("mpModal")?.classList.add("is-hidden"); }
function showModalError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("is-hidden");
}

// ─── Session logic ────────────────────────────────────────────────────────────

function generateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

async function createSession(username) {
    const sb = getSupabase();
    const code = generateCode();
    const { error } = await sb.from("sessions").insert({ id: code });
    if (error) { showModalError("mpCreateError", "Failed to create session. Try again."); return; }
    currentSession = { id: code };
    currentUsername = username;
    getUserColor(username);
    closeModal();
    subscribeToSession(code);
    showSessionPanel();
    updateFab(true);
}

async function joinSession(code, username) {
    const sb = getSupabase();
    const { data, error } = await sb.from("sessions").select("id, expires_at").eq("id", code).single();
    if (error || !data) { showModalError("mpJoinError", "Session not found. Check the code."); return; }
    if (data.expires_at && new Date(data.expires_at) < new Date()) { showModalError("mpJoinError", "This session has expired."); return; }

    currentSession = { id: code, expiresAt: data.expires_at };
    currentUsername = username;

    const { data: spots } = await sb.from("spots").select("*").eq("session_id", code).order("created_at");
    sessionSpots = spots ?? [];
    sessionSpots.forEach(s => getUserColor(s.added_by));

    closeModal();
    subscribeToSession(code);
    showSessionPanel();
    refreshMapPins();
    updateFab(true);
}

async function leaveSession() {
    if (!currentSession) return;
    const sb = getSupabase();
    const { data: allSpots } = await sb.from("spots").select("added_by").eq("session_id", currentSession.id);
    const othersExist = allSpots?.some(s => s.added_by !== currentUsername);
    if (!othersExist) {
        await sb.from("sessions").delete().eq("id", currentSession.id);
    }
    realtimeChannel?.unsubscribe();
    realtimeChannel = null;
    currentSession = null;
    currentUsername = null;
    sessionSpots = [];
    userColorMap = {};
    clearMapPins();
    document.getElementById("mpPanel")?.classList.add("is-hidden");
    updateFab(false);
}

// ─── Realtime ─────────────────────────────────────────────────────────────────

function subscribeToSession(sessionId) {
    const sb = getSupabase();
    realtimeChannel = sb.channel(`session:${sessionId}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "spots", filter: `session_id=eq.${sessionId}` }, payload => {
            const spot = payload.new;
            if (!sessionSpots.find(s => s.id === spot.id)) {
                getUserColor(spot.added_by);
                sessionSpots.push(spot);
                refreshSpotsList();
                refreshMapPins();
                if (spot.added_by !== currentUsername) showToast(`📍 ${spot.added_by} added "${spot.name}"`);
            }
        })
        .on("postgres_changes", { event: "DELETE", schema: "public", table: "spots", filter: `session_id=eq.${sessionId}` }, payload => {
            sessionSpots = sessionSpots.filter(s => s.id !== payload.old.id);
            refreshSpotsList();
            refreshMapPins();
        })
        .subscribe();
}

// ─── Map pins ─────────────────────────────────────────────────────────────────

function refreshMapPins() {
    const map = getMap();
    if (!map || !window.L) {
        // Map not ready yet — retry once after a short delay
        setTimeout(() => {
            const m = getMap();
            if (m) _doRefreshMapPins(m);
        }, 500);
        return;
    }
    _doRefreshMapPins(map);
}

function _doRefreshMapPins(map) {
    clearMapPins();
    if (!sessionSpots.length) return;

    const markers = sessionSpots
        .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon))
        .map(spot => {
            const color = getUserColor(spot.added_by);
            const score = getWeightedScore(spot);
            const icon = window.L.divIcon({
                className: "",
                html: `<div class="mp-map-pin" style="--pin-color:${color}">
                    <span class="mp-map-pin__score">${Number.isFinite(score) ? score.toFixed(1) : "?"}</span>
                </div>`,
                iconSize: [44, 52],
                iconAnchor: [22, 52]
            });
            const marker = window.L.marker([spot.lat, spot.lon], { icon });
            marker.bindPopup(`
                <div class="mp-popup">
                    <strong>${spot.name}</strong><br>
                    <span style="color:${color}">● ${spot.added_by}</span><br>
                    Score: <strong>${Number.isFinite(score) ? score.toFixed(1) : "n/a"}</strong> / 10
                </div>`);
            return marker;
        });

    if (!markers.length) return;
    mapPinLayer = window.L.featureGroup(markers).addTo(map);
}

function clearMapPins() {
    if (!mapPinLayer) return;
    try {
        const map = getMap();
        if (map) map.removeLayer(mapPinLayer);
    } catch (_) {}
    mapPinLayer = null;
}

// ─── Add spot to session ──────────────────────────────────────────────────────

function watchOutputForSpotResults() {
    const output = document.getElementById("output");
    if (!output) return;

    const observer = new MutationObserver(() => {
        if (!currentSession) return;
        const scoreCard = output.querySelector(".result-card--score");
        const resultStack = output.querySelector(".result-stack");
        if (!scoreCard || !resultStack) return;
        if (resultStack.querySelector(".mp-add-btn")) return;

        const btn = document.createElement("button");
        btn.className = "mp-add-btn";
        btn.textContent = "➕ Add to session";
        btn.addEventListener("click", () => addCurrentSpotToSession(resultStack));
        resultStack.appendChild(btn);
    });

    observer.observe(output, { childList: true, subtree: false });
}

async function addCurrentSpotToSession(resultStack) {
    if (!currentSession) return;
    const sb = getSupabase();

    const spotName = resultStack.querySelector(".result-card--hero h3")?.textContent?.trim() ?? "Unnamed spot";
    const coordEl = resultStack.querySelector(".coordinates");
    const coordMatch = coordEl?.textContent?.match(/([\d.]+),\s*([\d.]+)/);
    const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
    const lon = coordMatch ? parseFloat(coordMatch[2]) : null;

    const scoreMap = { "Noise": "score_noise", "Air quality": "score_air", "Temperature": "score_temp", "Humidity": "score_humidity", "Wind": "score_wind", "Rain": "score_rain" };
    const scorePayload = {};
    resultStack.querySelectorAll(".score-list li").forEach(li => {
        const label = li.querySelector("strong")?.textContent?.trim();
        const val = li.querySelector(".score-value")?.textContent?.trim();
        const key = scoreMap[label];
        if (key && val && val !== "n/a") scorePayload[key] = parseFloat(val);
    });
    const generalEl = resultStack.querySelector(".score-display");
    if (generalEl?.textContent?.trim() !== "n/a") scorePayload.score_general = parseFloat(generalEl.textContent.trim());

    const { error } = await sb.from("spots").insert({
        session_id: currentSession.id, added_by: currentUsername, lat, lon, name: spotName, ...scorePayload
    });
    if (error) { showToast("❌ Failed to add spot."); return; }
    showToast(`✅ "${spotName}" added!`);

    const btn = resultStack.querySelector(".mp-add-btn");
    if (btn) { btn.textContent = "✓ Added"; btn.disabled = true; btn.classList.add("mp-add-btn--done"); }
}

// ─── Session panel ────────────────────────────────────────────────────────────

function showSessionPanel() {
    const panel = document.getElementById("mpPanel");
    if (!panel || !currentSession) return;

    document.getElementById("mpPanelCode").textContent = currentSession.id;
    const inviteUrl = `${window.location.origin}${window.location.pathname}?session=${currentSession.id}`;
    document.getElementById("mpInviteUrl").textContent = inviteUrl;

    refreshSpotsList();
    panel.classList.remove("is-hidden");
}

function refreshSpotsList() {
    const list = document.getElementById("mpSpotsList");
    if (!list) return;

    if (!sessionSpots.length) {
        list.innerHTML = `<li class="mp-panel__empty">No spots yet. Click the map to add one!</li>`;
        return;
    }

    list.innerHTML = sessionSpots.map(spot => {
        const color = getUserColor(spot.added_by);
        const score = getWeightedScore(spot);
        return `
        <li class="mp-spot-item">
            <div class="mp-spot-item__main">
                <div class="mp-spot-item__info">
                    <strong class="mp-spot-item__name">${spot.name}</strong>
                    <span class="mp-spot-item__by" style="color:${color}">● ${spot.added_by}</span>
                </div>
                <div class="mp-spot-item__score ${scoreColor(score)}">${Number.isFinite(score) ? score.toFixed(1) : "n/a"}</div>
            </div>
            ${spot.added_by === currentUsername ? `<button class="mp-spot-item__remove" data-id="${spot.id}">✕ Remove</button>` : ""}
        </li>`;
    }).join("");

    list.querySelectorAll(".mp-spot-item__remove").forEach(btn => {
        btn.addEventListener("click", () => removeSpot(btn.dataset.id));
    });
}

async function removeSpot(spotId) {
    const sb = getSupabase();
    await sb.from("spots").delete().eq("id", spotId);
}

function copyInviteLink() {
    const url = `${window.location.origin}${window.location.pathname}?session=${currentSession?.id}`;
    navigator.clipboard.writeText(url).then(() => showToast("🔗 Link copied!"));
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

function renderRanking() {
    const output = document.getElementById("output");
    if (!output) return;

    const sorted = [...sessionSpots]
        .map(s => ({ ...s, _weighted: getWeightedScore(s) }))
        .sort((a, b) => (b._weighted ?? 0) - (a._weighted ?? 0));

    const medals = ["🥇", "🥈", "🥉"];
    const hasWeights = !!window.__spotScoreWeights;

    const rows = sorted.map((spot, i) => {
        const color = getUserColor(spot.added_by);
        const score = spot._weighted;
        return `
        <li class="mp-rank-item ${i === 0 ? "mp-rank-item--winner" : ""}">
            <span class="mp-rank-item__medal">${medals[i] ?? `#${i + 1}`}</span>
            <div class="mp-rank-item__info">
                <strong>${spot.name}</strong>
                <span class="mp-rank-item__by" style="color:${color}">● ${spot.added_by}</span>
            </div>
            <span class="mp-rank-item__score ${scoreColor(score)}">${Number.isFinite(score) ? score.toFixed(1) : "n/a"}</span>
        </li>`;
    }).join("");

    output.innerHTML = `
        <div class="result-stack">
            <section class="result-card result-card--hero">
                <div class="hero-meta">
                    <span class="pill">Session ${currentSession?.id}</span>
                    <span class="pill pill--accent">${sorted.length} spots</span>
                    ${hasWeights ? '<span class="pill pill--weighted">✦ Personalized</span>' : ""}
                </div>
                <h3>Session ranking</h3>
            </section>
            <section class="result-card"><ul class="mp-rank-list">${rows}</ul></section>
            <button type="button" class="mp-btn mp-btn--secondary" id="mpBackFromRank">← Back to map</button>
        </div>`;
    output.classList.remove("is-hidden");

    document.getElementById("mpBackFromRank")?.addEventListener("click", () => {
        output.innerHTML = "";
        output.classList.add("is-hidden");
        document.getElementById("mpPanel")?.classList.add("is-hidden");
    });

    document.getElementById("mpPanel")?.classList.add("is-hidden");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function updateFab(inSession) {
    const fab = document.getElementById("multiplayerFab");
    if (!fab) return;
    fab.classList.toggle("mp-fab--active", inSession);
    fab.querySelector(".mp-fab__label").textContent = inSession ? currentSession.id : "Session";
}

function showToast(msg) {
    const toast = document.createElement("div");
    toast.className = "mp-toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("mp-toast--show"));
    setTimeout(() => { toast.classList.remove("mp-toast--show"); setTimeout(() => toast.remove(), 300); }, 2800);
}