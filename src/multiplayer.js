/**
 * multiplayer.js — Sprint 2: Multiplayer via Supabase
 *
 * Einbinden in index.html (eine Zeile nach compare.js):
 *   <script type="module" src="./multiplayer.js"></script>
 *
 * Keine Änderungen an script.js, compare.js, utils.js oder data-api.js.
 *
 * SETUP: Supabase URL + anon key hier eintragen:
 */

const SUPABASE_URL  = "https://kbhbixxelsaodatomydx.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtiaGJpeHhlbHNhb2RhdG9teWR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNDA5OTYsImV4cCI6MjA5NDgxNjk5Nn0.Buh5k3Em3QNiYY9noGQaPTIqpbxDrV5rpxKcjwI1-Ss";

// ─── Supabase Client (kein npm nötig, CDN wird via index.html geladen) ────────

function getSupabase() {
    if (window.__supabaseClient) return window.__supabaseClient;
    window.__supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    return window.__supabaseClient;
}

// ─── State ────────────────────────────────────────────────────────────────────

let currentSession = null;   // { id, expiresAt }
let currentUsername = null;
let realtimeChannel = null;
let sessionSpots = [];       // Array of spot objects from Supabase

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    injectMultiplayerUI();
    watchOutputForSpotResults();
    checkUrlForSessionInvite();
});

// ─── Check URL for ?session=CODE on load ──────────────────────────────────────

async function checkUrlForSessionInvite() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("session");
    if (!code) return;

    // Remove from URL bar without reload
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, "", cleanUrl);

    showMultiplayerModal("join", code);
}

// ─── UI Injection ─────────────────────────────────────────────────────────────

function injectMultiplayerUI() {
    // Floating button (bottom-right)
    const fab = document.createElement("button");
    fab.id = "multiplayerFab";
    fab.className = "mp-fab";
    fab.title = "Multiplayer";
    fab.innerHTML = `<span class="mp-fab__icon">👥</span><span class="mp-fab__label">Session</span>`;
    fab.addEventListener("click", () => {
        if (currentSession) {
            showSessionPanel();
        } else {
            showMultiplayerModal("home");
        }
    });
    document.body.appendChild(fab);

    // Modal overlay
    const modal = document.createElement("div");
    modal.id = "mpModal";
    modal.className = "mp-modal is-hidden";
    modal.innerHTML = `
        <div class="mp-modal__backdrop"></div>
        <div class="mp-modal__box">
            <button class="mp-modal__close" id="mpModalClose">✕</button>
            <div id="mpModalContent"></div>
        </div>
    `;
    modal.querySelector(".mp-modal__backdrop").addEventListener("click", closeModal);
    modal.querySelector("#mpModalClose").addEventListener("click", closeModal);
    document.body.appendChild(modal);

    // Session panel (sidebar overlay)
    const panel = document.createElement("div");
    panel.id = "mpPanel";
    panel.className = "mp-panel is-hidden";
    panel.innerHTML = `
        <div class="mp-panel__header">
            <div>
                <p class="mp-panel__eyebrow">Multiplayer Session</p>
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
        <ul class="mp-panel__spots-list" id="mpSpotsList">
            <li class="mp-panel__empty">No spots yet. Click the map to add one!</li>
        </ul>
        <button class="mp-btn mp-btn--danger" id="mpLeaveBtn">Leave session</button>
    `;
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
            <p class="mp-modal__sub">Pin spots together with friends and find the best one.</p>
            <div class="mp-modal__actions">
                <button class="mp-btn mp-btn--primary" id="mpCreateBtn">Create session</button>
                <button class="mp-btn mp-btn--secondary" id="mpJoinHomeBtn">Join with code</button>
            </div>
        `;
        content.querySelector("#mpCreateBtn").addEventListener("click", () => showMultiplayerModal("create"));
        content.querySelector("#mpJoinHomeBtn").addEventListener("click", () => showMultiplayerModal("join"));

    } else if (screen === "create") {
        content.innerHTML = `
            <div class="mp-modal__hero">✨</div>
            <h2 class="mp-modal__title">Create session</h2>
            <p class="mp-modal__sub">Choose a name others will see when you add spots.</p>
            <input class="mp-input" id="mpUsernameInput" type="text" placeholder="Your name" maxlength="24" autocomplete="off"/>
            <button class="mp-btn mp-btn--primary" id="mpConfirmCreateBtn">Create</button>
            <p class="mp-modal__error is-hidden" id="mpCreateError"></p>
        `;
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
            <p class="mp-modal__error is-hidden" id="mpJoinError"></p>
        `;
        const codeInput = content.querySelector("#mpJoinCodeInput");
        const nameInput = content.querySelector("#mpJoinNameInput");
        if (prefillCode) nameInput.focus();
        else codeInput.focus();
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

function closeModal() {
    document.getElementById("mpModal")?.classList.add("is-hidden");
}

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

    closeModal();
    subscribeToSession(code);
    showSessionPanel();
    updateFab(true);
}

async function joinSession(code, username) {
    const sb = getSupabase();

    const { data, error } = await sb.from("sessions").select("id, expires_at").eq("id", code).single();
    if (error || !data) { showModalError("mpJoinError", "Session not found. Check the code."); return; }

    if (data.expires_at && new Date(data.expires_at) < new Date()) {
        showModalError("mpJoinError", "This session has expired.");
        return;
    }

    currentSession = { id: code, expiresAt: data.expires_at };
    currentUsername = username;

    // Load existing spots
    const { data: spots } = await sb.from("spots").select("*").eq("session_id", code).order("created_at");
    sessionSpots = spots ?? [];

    closeModal();
    subscribeToSession(code);
    showSessionPanel();
    updateFab(true);
}

async function leaveSession() {
    if (!currentSession) return;
    const sb = getSupabase();

    // Check if anyone else is in the session by looking at distinct added_by values
    const { data: otherSpots } = await sb
        .from("spots")
        .select("added_by")
        .eq("session_id", currentSession.id)
        .neq("added_by", currentUsername);

    // If no one else has added spots, delete the session (ephemeral)
    if (!otherSpots || otherSpots.length === 0) {
        await sb.from("sessions").delete().eq("id", currentSession.id);
    }

    realtimeChannel?.unsubscribe();
    realtimeChannel = null;
    currentSession = null;
    currentUsername = null;
    sessionSpots = [];

    document.getElementById("mpPanel")?.classList.add("is-hidden");
    updateFab(false);
}

// ─── Realtime ─────────────────────────────────────────────────────────────────

function subscribeToSession(sessionId) {
    const sb = getSupabase();

    realtimeChannel = sb
        .channel(`session:${sessionId}`)
        .on("postgres_changes", {
            event: "INSERT",
            schema: "public",
            table: "spots",
            filter: `session_id=eq.${sessionId}`
        }, (payload) => {
            const spot = payload.new;
            if (!sessionSpots.find(s => s.id === spot.id)) {
                sessionSpots.push(spot);
                refreshSpotsList();
                showToast(`📍 ${spot.added_by} added "${spot.name}"`);
            }
        })
        .on("postgres_changes", {
            event: "DELETE",
            schema: "public",
            table: "spots",
            filter: `session_id=eq.${sessionId}`
        }, (payload) => {
            sessionSpots = sessionSpots.filter(s => s.id !== payload.old.id);
            refreshSpotsList();
        })
        .subscribe();
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
        if (resultStack.querySelector(".mp-add-btn")) return; // already injected

        // Inject "Add to session" button
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

    const nameEl = resultStack.querySelector(".result-card--hero h3");
    const coordEl = resultStack.querySelector(".coordinates");
    const spotName = nameEl?.textContent?.trim() ?? "Unnamed spot";
    const coordMatch = coordEl?.textContent?.match(/([\d.]+),\s*([\d.]+)/);
    const lat = coordMatch ? parseFloat(coordMatch[1]) : null;
    const lon = coordMatch ? parseFloat(coordMatch[2]) : null;

    // Read scores from DOM
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
        session_id: currentSession.id,
        added_by: currentUsername,
        lat, lon,
        name: spotName,
        ...scorePayload
    });

    if (error) { showToast("❌ Failed to add spot."); return; }
    showToast(`✅ "${spotName}" added to session!`);

    // Update button state
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

    list.innerHTML = sessionSpots.map(spot => `
        <li class="mp-spot-item" data-id="${spot.id}">
            <div class="mp-spot-item__main">
                <div class="mp-spot-item__info">
                    <strong class="mp-spot-item__name">${spot.name}</strong>
                    <span class="mp-spot-item__by">by ${spot.added_by}</span>
                </div>
                <div class="mp-spot-item__score">${spot.score_general != null ? spot.score_general.toFixed(1) : "n/a"}</div>
            </div>
            ${spot.added_by === currentUsername ? `<button class="mp-spot-item__remove" data-id="${spot.id}">✕</button>` : ""}
        </li>
    `).join("");

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

// ─── Ranking view ─────────────────────────────────────────────────────────────

function renderRanking() {
    const output = document.getElementById("output");
    if (!output) return;

    const sorted = [...sessionSpots].sort((a, b) => (b.score_general ?? 0) - (a.score_general ?? 0));

    const medals = ["🥇", "🥈", "🥉"];

    const rows = sorted.map((spot, i) => `
        <li class="mp-rank-item ${i === 0 ? "mp-rank-item--winner" : ""}">
            <span class="mp-rank-item__medal">${medals[i] ?? `#${i + 1}`}</span>
            <div class="mp-rank-item__info">
                <strong>${spot.name}</strong>
                <span class="mp-rank-item__by">by ${spot.added_by}</span>
            </div>
            <span class="mp-rank-item__score">${spot.score_general != null ? spot.score_general.toFixed(1) : "n/a"}</span>
        </li>
    `).join("");

    output.innerHTML = `
        <div class="result-stack">
            <section class="result-card result-card--hero">
                <div class="hero-meta">
                    <span class="pill">Session ${currentSession?.id}</span>
                    <span class="pill pill--accent">${sorted.length} spots</span>
                </div>
                <h3>Session ranking</h3>
            </section>
            <section class="result-card">
                <ul class="mp-rank-list">${rows}</ul>
            </section>
            <button type="button" class="mp-btn mp-btn--secondary" id="mpBackFromRank">← Back to map</button>
        </div>
    `;
    output.classList.remove("is-hidden");

    document.getElementById("mpBackFromRank")?.addEventListener("click", () => {
        output.innerHTML = "";
        output.classList.add("is-hidden");
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