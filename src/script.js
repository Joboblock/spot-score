const DATASETS = {
    traffic_tag_abend_nacht: {
        id: "traffic_tag_abend_nacht",
        baseUrl: "https://api.hamburg.de/datasets/v1/strassenverkehr",
        collection: "strassenverkehr_tag_abend_nacht_2022",
        title: "Straßenverkehr Tag/Abend/Nacht 2022",
        source: "API Hamburg – dataset strassenverkehr",
        categoryProperty: "klasse",
        categoryLabel: "Klasse",
        legendTitle: "dB(A) levels",
        loadingText: "Loading traffic noise classes...",
        mapModeLabel: "All available dB classes shown together",
        colorResolver: (category) => getTrafficKlasseColor(category),
        categorySorter: (a, b) => parseLowerDbBound(a) - parseLowerDbBound(b)
    },
    traffic_nacht: {
        id: "traffic_nacht",
        baseUrl: "https://api.hamburg.de/datasets/v1/strassenverkehr",
        collection: "strassenverkehr_nacht_2022",
        title: "Straßenverkehr Nacht 2022",
        source: "API Hamburg – dataset strassenverkehr",
        categoryProperty: "klasse",
        categoryLabel: "Klasse",
        legendTitle: "dB(A) levels",
        loadingText: "Loading traffic noise classes...",
        mapModeLabel: "All available dB classes shown together",
        colorResolver: (category) => getTrafficKlasseColor(category),
        categorySorter: (a, b) => parseLowerDbBound(a) - parseLowerDbBound(b)
    },
    kaltlufteinwirkbereich: {
        id: "kaltlufteinwirkbereich",
        baseUrl: "https://api.hamburg.de/datasets/v1/stadtklimaanalyse_hamburg_2023",
        collection: "kaltlufteinwirkbereich",
        title: "Stadtklimaanalyse 2023 – Kaltlufteinwirkbereich",
        source: "API Hamburg – dataset stadtklimaanalyse_hamburg_2023",
        categoryProperty: "einwirkbereich",
        categoryLabel: "Einwirkbereich",
        legendTitle: "Kaltlufteinwirkbereich",
        loadingText: "Loading cold-air impact areas...",
        mapModeLabel: "All available impact classes shown together",
        colorResolver: (category) => getKaltluftColor(category),
        categorySorter: (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })
    }
};

const MAX_PAGES = 50;
const PAGE_SIZE = 1000;
const DEFAULT_CENTER = [53.5511, 9.9937];
const BRIGHTSKY_CURRENT_WEATHER_URL = "https://api.brightsky.dev/current_weather";
const HAMBURG_COORDINATES = {
    lat: 53.5511,
    lon: 9.9937
};
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
    const datasetSelect = document.getElementById("collectionSelect");

    if (form) {
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            loadSelectedData();
        });
    }

    if (datasetSelect) {
        datasetSelect.addEventListener("change", () => {
            loadSelectedData();
        });
    }

    initMap();
    updateHamburgTemperature();
    loadSelectedData();
});

async function getHamburgTemperature() {
    const requestUrl = `${BRIGHTSKY_CURRENT_WEATHER_URL}?lat=${HAMBURG_COORDINATES.lat}&lon=${HAMBURG_COORDINATES.lon}`;
    const response = await fetch(requestUrl);

    if (!response.ok) {
        throw new Error("Could not load Hamburg temperature from Bright Sky API.");
    }

    const data = await response.json();
    const temperature = data?.weather?.temperature;

    if (typeof temperature !== "number") {
        throw new Error("Bright Sky did not return a valid Hamburg temperature.");
    }

    return {
        temperature,
        timestamp: data?.weather?.timestamp,
        stationName: data?.sources?.[0]?.station_name ?? "Unknown station"
    };
}

async function updateHamburgTemperature() {
    const temperatureElement = document.getElementById("hamburgTemperature");
    if (!temperatureElement) return;

    temperatureElement.textContent = "Hamburg temperature: loading...";

    try {
        const currentWeather = await getHamburgTemperature();
        const formattedTimestamp = currentWeather.timestamp
            ? new Date(currentWeather.timestamp).toLocaleString()
            : "unknown time";

        temperatureElement.textContent = `Hamburg temperature: ${currentWeather.temperature.toFixed(1)}°C (${currentWeather.stationName}, ${formattedTimestamp})`;
    } catch {
        temperatureElement.textContent = "Hamburg temperature currently unavailable.";
    }
}

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

function getSelectedDatasetConfig() {
    const selectedId = document.getElementById("collectionSelect")?.value;
    return DATASETS[selectedId] ?? DATASETS.traffic_tag_abend_nacht;
}

function updateHeader(config) {
    const title = document.getElementById("appTitle");
    const source = document.getElementById("datasetSource");

    if (title) title.textContent = config.title;
    if (source) source.innerHTML = `Source: ${config.source}`;
}

async function loadSelectedData() {
    const output = document.getElementById("output");
    const config = getSelectedDatasetConfig();

    updateHeader(config);

    if (!config) {
        output.innerHTML = "<div class='error'>Please select a dataset.</div>";
        return;
    }

    output.innerHTML = `<div class='loading'>${config.loadingText}</div>`;

    try {
        const data = await fetchCollectionItems(config);
        renderResults(data, config);
        renderMap(data, config);
    } catch (error) {
        output.innerHTML = `<div class='error'>${error.message}</div>`;
        clearMap();
    }
}

async function fetchCollectionItems(config) {
    let nextUrl = `${config.baseUrl}/collections/${config.collection}/items?f=json&limit=${PAGE_SIZE}`;
    const allFeatures = [];
    let pagesFetched = 0;
    let numberMatched = 0;
    let timeStamp;

    while (nextUrl && pagesFetched < MAX_PAGES) {
        const response = await fetch(nextUrl);

        if (!response.ok) {
            throw new Error("Could not load data from Hamburg API.");
        }

        const data = await response.json();
        const pageFeatures = data?.features ?? [];

        allFeatures.push(...pageFeatures);
        numberMatched = data?.numberMatched ?? numberMatched;
        timeStamp = data?.timeStamp ?? timeStamp;
        pagesFetched += 1;
        nextUrl = data?.links?.find((link) => link?.rel === "next")?.href ?? "";
    }

    const hasMorePages = Boolean(nextUrl);

    return {
        type: "FeatureCollection",
        features: allFeatures,
        numberReturned: allFeatures.length,
        numberMatched: numberMatched || allFeatures.length,
        timeStamp,
        truncated: hasMorePages
    };
}

function clearMap() {
    if (map && featureLayer) {
        map.removeLayer(featureLayer);
        featureLayer = null;
    }

    if (map && legendControl) {
        map.removeControl(legendControl);
        legendControl = null;
    }
}

function renderMap(data, config) {
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
                const category = getFeatureCategory(feature, config);
                const fillColor = config.colorResolver(category);

                return {
                    color: "#ffffff",
                    weight: 0.6,
                    fillColor,
                    fillOpacity: 0.75
                };
            },
            onEachFeature: (feature, layer) => {
                const category = getFeatureCategory(feature, config);

                layer.bindPopup(
                    `<strong>${config.categoryLabel}:</strong> ${category}<br/><strong>Dataset:</strong> ${config.title}`
                );
            }
        }
    ).addTo(map);

    updateLegend(mapFeatures, config);

    const bounds = featureLayer.getBounds();
    if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.05), { maxZoom: 14 });
    }
}

function renderResults(data, config) {
    const output = document.getElementById("output");
    const features = data?.features ?? [];

    if (features.length === 0) {
        output.innerHTML = "<div class='error'>No matching results found.</div>";
        return;
    }

    const counts = features.reduce((acc, feature) => {
        const category = getFeatureCategory(feature, config);
        acc[category] = (acc[category] ?? 0) + 1;
        return acc;
    }, {});

    const rows = Object.entries(counts)
        .sort(([a], [b]) => config.categorySorter(a, b))
        .map(
            ([category, count]) => `<li><strong>${category}</strong><span>${count}</span></li>`
        )
        .join("");
    const truncatedNotice = data?.truncated
        ? `<p class="timestamp">Showing first ${features.length.toLocaleString()} features (partial dataset).</p>`
        : "";
    const formattedTimestamp = data?.timeStamp
        ? new Date(data.timeStamp).toLocaleString()
        : "Not provided";

    output.innerHTML = `
        <h3>${config.title}</h3>
        <p><strong>Returned features:</strong> ${data.numberReturned ?? features.length}</p>
        <p><strong>Total matched:</strong> ${data.numberMatched ?? features.length}</p>
        <p><strong>Map mode:</strong> ${config.mapModeLabel}</p>
        <ul class="klasse-list">${rows}</ul>
        ${truncatedNotice}
        <p class="timestamp">Updated: ${formattedTimestamp}</p>
    `;
}

function getFeatureCategory(feature, config) {
    return feature?.properties?.[config.categoryProperty] ?? "Unknown";
}

function parseLowerDbBound(klasseLabel) {
    const lowerBoundMatch = klasseLabel.match(/(\d+)\s*-\s*\d+/);
    if (lowerBoundMatch) return Number(lowerBoundMatch[1]);

    const atLeastMatch = klasseLabel.match(/>=\s*(\d+)/);
    if (atLeastMatch) return Number(atLeastMatch[1]);

    return 0;
}

function getTrafficKlasseColor(klasseLabel) {
    const lowerDb = parseLowerDbBound(klasseLabel);

    if (lowerDb >= 75) return "#7f0000";
    if (lowerDb >= 70) return "#b30000";
    if (lowerDb >= 65) return "#e34a33";
    if (lowerDb >= 60) return "#fc8d59";
    if (lowerDb >= 55) return "#fdbb84";
    return "#fee8c8";
}

function getKaltluftColor(einwirkbereichLabel) {
    const colors = {
        Bebauung: "#377eb8",
        Verkehrsflächen: "#ff7f00"
    };

    return colors[einwirkbereichLabel] ?? "#8dd3c7";
}

function updateLegend(features, config) {
    if (!map) return;

    const classes = [...new Set(features.map((feature) => getFeatureCategory(feature, config)))]
        .sort((a, b) => config.categorySorter(a, b));

    legendControl = L.control({ position: "bottomright" });
    legendControl.onAdd = () => {
        const div = L.DomUtil.create("div", "map-legend");
        div.innerHTML = `
            <h4>${config.legendTitle}</h4>
            ${classes
                .map(
                    (klasse) =>
                        `<div class="legend-item"><span class="legend-color" style="background:${config.colorResolver(klasse)}"></span>${klasse}</div>`
                )
                .join("")}
        `;
        return div;
    };

    legendControl.addTo(map);
}
