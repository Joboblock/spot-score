import proj4 from "https://cdn.jsdelivr.net/npm/proj4@2.9.1/+esm";

const GML_FILES_URL = "./gml-files.json";
const GML_BASE_PATH = "/gml";
const GML_FEATURE_STYLE = {
    color: "#2563eb",
    weight: 1,
    fillColor: "#60a5fa",
    fillOpacity: 0.25
};
const EPSG_25832 = "EPSG:25832";
const EPSG_4326 = "EPSG:4326";
const GML_NS = "http://www.opengis.net/gml";
const BLDG_NS = "http://www.opengis.net/citygml/building/2.0";

proj4.defs(EPSG_25832, "+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs");
proj4.defs(EPSG_4326, "+proj=longlat +datum=WGS84 +no_defs");

let gmlFootprintsLayer;

export async function initGmlFootprintsLayer(map) {
    if (!map || typeof DOMParser === "undefined") return null;

    try {
        const gmlFiles = await fetchGmlFileList();
        console.log("[GML] File list loaded:", gmlFiles);
        if (!gmlFiles.length) {
            console.warn("[GML] No GML files found.");
            return null;
        }

        const gmlTexts = await Promise.all(
            gmlFiles.map((file) =>
                fetch(`${GML_BASE_PATH}/${file}`).then((response) => (response.ok ? response.text() : null))
            )
        );
        console.log(`[GML] Loaded ${gmlTexts.filter(Boolean).length} GML files.`);

        const features = gmlTexts.flatMap((text, index) =>
            text ? parseGmlFootprints(text, gmlFiles[index]) : []
        );
        console.log(`[GML] Parsed features:`, features.length);

        if (!features.length) {
            console.warn("[GML] No features parsed from GML files.");
            return null;
        }

        const featureCollection = {
            type: "FeatureCollection",
            features
        };

        if (gmlFootprintsLayer) {
            map.removeLayer(gmlFootprintsLayer);
        }

        gmlFootprintsLayer = L.geoJSON(featureCollection, {
            style: () => ({ ...GML_FEATURE_STYLE }),
            onEachFeature: (feature, layer) => {
                const label = feature.properties?.source ?? "GML footprint";
                layer.bindPopup(`<strong>${label}</strong>`);
            }
        }).addTo(map);

        const bounds = gmlFootprintsLayer.getBounds();
        console.log("[GML] Layer bounds:", bounds);
        window.gmlFootprintsLayer = gmlFootprintsLayer;
        if (bounds.isValid()) {
            map.fitBounds(bounds, { maxZoom: 14 });
        }

        return gmlFootprintsLayer;
    } catch (error) {
        console.warn("Unable to load GML footprints", error);
        return null;
    }
}

async function fetchGmlFileList() {
    try {
        const response = await fetch(GML_FILES_URL);
        if (!response.ok) return [];
        const files = await response.json();
        return Array.isArray(files) ? files : [];
    } catch (error) {
        return [];
    }
}

function parseGmlFootprints(gmlText, sourceLabel) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(gmlText, "application/xml");

    let posListNodes = [];
    const groundSurfaces = doc.getElementsByTagNameNS(BLDG_NS, "GroundSurface");
    for (const gs of groundSurfaces) {
        const posLists = gs.getElementsByTagNameNS(GML_NS, "posList");
        for (const pl of posLists) posListNodes.push(pl);
    }
    if (posListNodes.length === 0) {
        posListNodes = Array.from(doc.getElementsByTagNameNS(GML_NS, "posList"));
    }
    console.log(`[GML][${sourceLabel}] Found posList nodes:`, posListNodes.length);

    const features = posListNodes
        .map((node, idx) => {
            const text = node.textContent || "";
            const ring = parsePosList(text);
            if (ring.length === 0) {
                console.log(`[GML][${sourceLabel}] posList #${idx} is empty or unparsable:`, text);
                return null;
            }
            const projectedRing = ring.map(([x, y]) => toLonLat(x, y));
            const normalizedRing = normalizeRing(projectedRing);

            if (normalizedRing.length < 4) {
                console.log(
                    `[GML][${sourceLabel}] posList #${idx} has too few points after normalization:`,
                    normalizedRing
                );
                return null;
            }

            return {
                type: "Feature",
                properties: { source: sourceLabel },
                geometry: {
                    type: "Polygon",
                    coordinates: [normalizedRing]
                }
            };
        })
        .filter(Boolean);
    console.log(`[GML][${sourceLabel}] Features parsed:`, features.length);
    return features;
}

function parsePosList(posListText) {
    const values = posListText
        .trim()
        .split(/\s+/)
        .map((value) => Number(value))
        .filter(Number.isFinite);

    const coords = [];
    for (let index = 0; index < values.length; index += 3) {
        const x = values[index];
        const y = values[index + 1];
        if (Number.isFinite(x) && Number.isFinite(y)) {
            coords.push([x, y]);
        }
    }
    return coords;
}

function toLonLat(x, y) {
    const [lon, lat] = proj4(EPSG_25832, EPSG_4326, [x, y]);
    return [lon, lat];
}

function normalizeRing(ring) {
    if (ring.length === 0) return ring;
    const [firstLon, firstLat] = ring[0];
    const [lastLon, lastLat] = ring[ring.length - 1];

    if (firstLon !== lastLon || firstLat !== lastLat) {
        return [...ring, [firstLon, firstLat]];
    }

    return ring;
}
