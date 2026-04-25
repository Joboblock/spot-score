const BASE_URL = "https://api.hamburg.de/datasets/v1/strassenverkehr";
const DEFAULT_CENTER = [53.5511, 9.9937];
const DEFAULT_ZOOM = 11;
const MIN_ZOOM = 10;
const MAX_ZOOM = 16;
const HAMBURG_BOUNDS = [
    [53.41062884725186, 9.732240484945219],
    [53.72838568700598, 10.29272015751267]
];
let map;
let featureLayer;
let legendControl;

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
}

async function loadTrafficData() {
    const output = document.getElementById("output");
    const collection = document.getElementById("collectionSelect")?.value;

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

        const response = await fetch(
            `${BASE_URL}/collections/${collection}/items?${params.toString()}`
        );

        if (!response.ok) {
            throw new Error("Could not load data from Hamburg API.");
        }

        const data = await response.json();
        renderResults(data, collection);
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

    featureLayer = L.geoJSON(
        {
            type: "FeatureCollection",
            features: mapFeatures
        },
        {
            style: (feature) => {
                const klasse = feature?.properties?.klasse ?? "Unknown";
                const fillColor = getKlasseColor(klasse);

                return {
                    color: "#ffffff",
                    weight: 0.6,
                    fillColor,
                    fillOpacity: 0.75
                };
            },
            onEachFeature: (feature, layer) => {
                const klasse = feature?.properties?.klasse ?? "Unknown";
                const collectionLabel =
                    collection === "strassenverkehr_nacht_2022"
                        ? "Nacht 2022"
                        : "Tag / Abend / Nacht 2022";

                layer.bindPopup(
                    `<strong>Klasse:</strong> ${klasse}<br/><strong>Collection:</strong> ${collectionLabel}`
                );
            }
        }
    ).addTo(map);

    updateLegend(mapFeatures);

    const bounds = featureLayer.getBounds();
    if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.05), { maxZoom: 14 });
    }
}

function renderResults(data, collection) {
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
        <p><strong>Map mode:</strong> All available dB classes shown together</p>
        <ul class="klasse-list">${rows}</ul>
        <p class="timestamp">Updated: ${new Date(data.timeStamp).toLocaleString()}</p>
    `;
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

    if (lowerDb >= 75) return "#7f0000";
    if (lowerDb >= 70) return "#b30000";
    if (lowerDb >= 65) return "#e34a33";
    if (lowerDb >= 60) return "#fc8d59";
    if (lowerDb >= 55) return "#fdbb84";
    return "#fee8c8";
}

function updateLegend(features) {
    if (!map) return;

    if (legendControl) {
        map.removeControl(legendControl);
    }

    const classes = [...new Set(features.map((feature) => feature?.properties?.klasse ?? "Unknown"))]
        .sort((a, b) => parseLowerDbBound(a) - parseLowerDbBound(b));

    legendControl = L.control({ position: "bottomright" });
    legendControl.onAdd = () => {
        const div = L.DomUtil.create("div", "map-legend");
        div.innerHTML = `
            <h4>dB(A) levels</h4>
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
