const DEFAULT_B3DM_PATH = "./Area 1 neu";
const DEFAULT_BOUNDS = [
    [53.41062884725186, 9.732240484945219],
    [53.72838568700598, 10.29272015751267]
];

const B3DM_TILES = [
    "6431.b3dm",
    "6432.b3dm",
    "6433.b3dm",
    "6434.b3dm",
    "6528.b3dm",
    "6529.b3dm",
    "6530.b3dm",
    "6531.b3dm",
    "6532.b3dm",
    "6533.b3dm",
    "6534.b3dm",
    "6627.b3dm",
    "6628.b3dm",
    "6629.b3dm",
    "6630.b3dm",
    "6631.b3dm",
    "6632.b3dm",
    "6633.b3dm",
    "6634.b3dm",
    "6728.b3dm",
    "6729.b3dm",
    "6730.b3dm",
    "6731.b3dm",
    "6732.b3dm",
    "6733.b3dm",
    "6734.b3dm",
    "6829.b3dm",
    "6830.b3dm",
    "6831.b3dm",
    "6832.b3dm",
    "6833.b3dm",
    "6834.b3dm",
    "6835.b3dm",
    "6836.b3dm",
    "6929.b3dm",
    "6930.b3dm",
    "6931.b3dm",
    "6932.b3dm",
    "6933.b3dm",
    "6934.b3dm",
    "6935.b3dm",
    "6936.b3dm",
    "7029.b3dm",
    "7030.b3dm",
    "7031.b3dm",
    "7032.b3dm",
    "7033.b3dm",
    "7034.b3dm",
    "7035.b3dm",
    "7036.b3dm",
    "7129.b3dm",
    "7130.b3dm",
    "7131.b3dm",
    "7132.b3dm",
    "7133.b3dm",
    "7134.b3dm",
    "7135.b3dm",
    "7229.b3dm",
    "7230.b3dm",
    "7231.b3dm",
    "7232.b3dm",
    "7233.b3dm",
    "7234.b3dm",
    "7235.b3dm",
    "7329.b3dm",
    "7330.b3dm",
    "7331.b3dm",
    "7332.b3dm",
    "7333.b3dm",
    "7334.b3dm",
    "7335.b3dm",
    "7431.b3dm",
    "7432.b3dm",
    "7433.b3dm",
    "7434.b3dm",
    "7435.b3dm",
    "7533.b3dm",
    "7534.b3dm",
    "7535.b3dm",
    "7633.b3dm",
    "7634.b3dm",
    "7635.b3dm"
];

const TILE_INDEX = buildTileIndex(B3DM_TILES);

export async function loadNearbyBuildingData(lat, lon, options = {}) {
    const {
        debug = true,
        path = DEFAULT_B3DM_PATH,
        bounds = DEFAULT_BOUNDS,
        neighborRadius = 1,
        maxTiles = 9
    } = options;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        if (debug) {
            console.warn("[b3dm] Skipping building data load: invalid coordinates.");
        }
        return [];
    }

    const { tiles, targetKey } = pickNearbyTiles(lat, lon, bounds, neighborRadius, maxTiles);

    if (debug) {
        console.info("[b3dm] Attempting to load nearby tiles", {
            lat,
            lon,
            targetKey,
            tiles
        });
    }

    const results = await Promise.all(
        tiles.map(async (tile) => {
            const url = `${path}/${tile}`;
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const buffer = await response.arrayBuffer();
                const header = parseB3dmHeader(buffer);

                if (debug) {
                    console.info("[b3dm] Loaded tile", {
                        tile,
                        sizeBytes: buffer.byteLength,
                        header
                    });
                }

                return { tile, buffer, header };
            } catch (error) {
                if (debug) {
                    console.warn("[b3dm] Failed to load tile", {
                        tile,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
                return null;
            }
        })
    );

    const loaded = results.filter(Boolean);

    if (debug) {
        console.info("[b3dm] Building data load summary", {
            requested: tiles.length,
            loaded: loaded.length
        });
    }

    return loaded;
}

function pickNearbyTiles(lat, lon, bounds, neighborRadius, maxTiles) {
    const [[minLat, minLon], [maxLat, maxLon]] = bounds;
    const normalizedX = clamp((lon - minLon) / (maxLon - minLon), 0, 1);
    const normalizedY = clamp((lat - minLat) / (maxLat - minLat), 0, 1);

    const gridMinX = TILE_INDEX.minX;
    const gridMaxX = TILE_INDEX.maxX;
    const gridMinY = TILE_INDEX.minY;
    const gridMaxY = TILE_INDEX.maxY;

    const xIndex = Math.round(gridMinX + normalizedX * (gridMaxX - gridMinX));
    const yIndex = Math.round(gridMinY + normalizedY * (gridMaxY - gridMinY));

    const candidates = [];

    for (let dx = -neighborRadius; dx <= neighborRadius; dx += 1) {
        for (let dy = -neighborRadius; dy <= neighborRadius; dy += 1) {
            const key = `${xIndex + dx}-${yIndex + dy}`;
            const tile = TILE_INDEX.tiles.get(key);
            if (tile) {
                candidates.push(tile);
            }
        }
    }

    const tiles = candidates.slice(0, Math.max(1, maxTiles));
    return { tiles, targetKey: `${xIndex}-${yIndex}` };
}

function buildTileIndex(tiles) {
    const entries = tiles
        .map((tile) => {
            const match = tile.match(/^(\d)(\d)(\d)(\d)\.b3dm$/);
            if (!match) return null;
            const x = Number(match[1] + match[2]);
            const y = Number(match[3] + match[4]);
            return { tile, x, y };
        })
        .filter(Boolean);

    const minX = Math.min(...entries.map((entry) => entry.x));
    const maxX = Math.max(...entries.map((entry) => entry.x));
    const minY = Math.min(...entries.map((entry) => entry.y));
    const maxY = Math.max(...entries.map((entry) => entry.y));

    const map = new Map();
    entries.forEach((entry) => {
        map.set(`${entry.x}-${entry.y}`, entry.tile);
    });

    return { tiles: map, minX, maxX, minY, maxY };
}

function parseB3dmHeader(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 28) {
        return { magic: null, version: null, byteLength: null };
    }

    const view = new DataView(buffer);
    const magic = String.fromCharCode(
        view.getUint8(0),
        view.getUint8(1),
        view.getUint8(2),
        view.getUint8(3)
    );
    const version = view.getUint32(4, true);
    const byteLength = view.getUint32(8, true);

    return { magic, version, byteLength };
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
