const BASE_URL = "https://api.hamburg.de/datasets/v1/strassenverkehr";
const DEFAULT_CENTER = [53.5511, 9.9937];
const DEFAULT_ZOOM = 11;
let map;
let featureLayer;

document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("trafficForm");

    if (form) {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            loadTrafficData();
        });
    }

    initMap();
    loadTrafficData();
});

function initMap() {
    if (typeof L === "undefined") return;

    map = L.map("map").setView(DEFAULT_CENTER, DEFAULT_ZOOM);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);
}

async function loadTrafficData() {
    const output = document.getElementById("output");
    const collection = document.getElementById("collectionSelect")?.value;
    const klasse = document.getElementById("klasseInput")?.value.trim();

    if (!collection) {
        output.innerHTML = "<div class='error'>Please select a dataset.</div>";
        return;
    }

    output.innerHTML = "<div class='loading'>Loading traffic noise classes...</div>";

    try {
        const params = new URLSearchParams({
            f: "json",
            limit: "100"
        });

        if (klasse) params.set("klasse", klasse);

        const response = await fetch(
            `${BASE_URL}/collections/${collection}/items?${params.toString()}`
        );

        if (!response.ok) {
            throw new Error("Could not load data from Hamburg API.");
        }

        const data = await response.json();
        renderResults(data, collection, klasse);
        renderMap(data, collection);
    } catch (error) {
        output.innerHTML = `<div class='error'>${error.message}</div>`;
        clearMap();
    }
}

function clearMap() {
    if (!map || !featureLayer) return;
    map.removeLayer(featureLayer);
    featureLayer = null;
}

function renderMap(data, collection) {
    if (!map) return;

    clearMap();

    const features = data?.features ?? [];
    const mapFeatures = features.filter((feature) => feature?.geometry);

    if (mapFeatures.length === 0) return;

    const color =
        collection === "strassenverkehr_nacht_2022" ? "#ef4444" : "#0f62fe";

    featureLayer = L.geoJSON(
        {
            type: "FeatureCollection",
            features: mapFeatures
        },
        {
            style: {
                color,
                weight: 1,
                fillColor: color,
                fillOpacity: 0.35
            },
            onEachFeature: (feature, layer) => {
                const klasse = feature?.properties?.klasse ?? "Unknown";
                layer.bindPopup(`<strong>Klasse:</strong> ${klasse}`);
            }
        }
    ).addTo(map);

    const bounds = featureLayer.getBounds();
    if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.1));
    }
}

function renderResults(data, collection, klasseFilter) {
    const output = document.getElementById("output");
    const features = data?.features ?? [];

    if (features.length === 0) {
        output.innerHTML = "<div class='error'>No matching results found.</div>";
        return;
    }

    const counts = features.reduce((acc, feature) => {
        const klasse = feature?.properties?.klasse ?? "Unknown";
        acc[klasse] = (acc[klasse] ?? 0) + 1;
        return acc;
    }, {});

    const rows = Object.entries(counts)
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(
            ([klasse, count]) => `<li><strong>${klasse}</strong><span>${count}</span></li>`
        )
        .join("");

    const title =
        collection === "strassenverkehr_nacht_2022"
            ? "Straßenverkehr Nacht_2022"
            : "Straßenverkehr Tag/Abend/Nacht_2022";

    output.innerHTML = `
        <h3>${title}</h3>
        <p><strong>Returned features:</strong> ${data.numberReturned ?? features.length}</p>
        <p><strong>Total matched:</strong> ${data.numberMatched ?? features.length}</p>
        ${klasseFilter ? `<p><strong>Filter:</strong> klasse = ${klasseFilter}</p>` : ""}
        <ul class="klasse-list">${rows}</ul>
        <p class="timestamp">Updated: ${new Date(data.timeStamp).toLocaleString()}</p>
    `;
}
