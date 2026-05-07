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
        maxTiles = 9,
        ray = null,
        rayOptions = {}
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
                const gltf = extractGltfFromB3dm(buffer);
                const validation = gltf ? validateGltfPayload(gltf) : null;
                                const rayCheck = gltf && ray ? rayIntersectsGltf(gltf, ray, rayOptions) : null;

                if (debug) {
                    console.info("[b3dm] Loaded tile", {
                        tile,
                        sizeBytes: buffer.byteLength,
                        header,
                        gltf: gltf
                            ? {
                                  jsonByteLength: gltf.jsonByteLength,
                                  binaryByteLength: gltf.binaryByteLength,
                                  hasBinaryChunk: Boolean(gltf.binaryChunk),
                                  parsedJson: Boolean(gltf.json),
                                  validation
                              }
                            : null
                    });

                    if (rayCheck) {
                        console.info("[b3dm] Ray check", {
                            tile,
                            hit: rayCheck.hit,
                            trianglesTested: rayCheck.trianglesTested,
                            reason: rayCheck.reason
                        });
                    }
                }

                return { tile, buffer, header, gltf, validation, rayCheck };
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

export function extractGltfFromB3dm(buffer) {
    const header = parseB3dmHeader(buffer);
    if (!header || header.magic !== "b3dm") {
        return null;
    }

    const view = new DataView(buffer);
    const featureTableJsonByteLength = view.getUint32(12, true);
    const featureTableBinaryByteLength = view.getUint32(16, true);
    const batchTableJsonByteLength = view.getUint32(20, true);
    const batchTableBinaryByteLength = view.getUint32(24, true);

    const gltfStart =
        28 +
        featureTableJsonByteLength +
        featureTableBinaryByteLength +
        batchTableJsonByteLength +
        batchTableBinaryByteLength;

    if (gltfStart >= buffer.byteLength) {
        return null;
    }

    const gltfBuffer = buffer.slice(gltfStart);
    const gltfView = new DataView(gltfBuffer);
    const magic = String.fromCharCode(
        gltfView.getUint8(0),
        gltfView.getUint8(1),
        gltfView.getUint8(2),
        gltfView.getUint8(3)
    );

    if (magic !== "glTF") {
        return null;
    }

    const version = gltfView.getUint32(4, true);
    const length = gltfView.getUint32(8, true);

    let offset = 12;
    let jsonChunk = null;
    let binaryChunk = null;
    let jsonByteLength = 0;
    let binaryByteLength = 0;

    while (offset + 8 <= length) {
        const chunkLength = gltfView.getUint32(offset, true);
        const chunkType = gltfView.getUint32(offset + 4, true);
        const chunkStart = offset + 8;
        const chunkEnd = chunkStart + chunkLength;

        if (chunkEnd > gltfBuffer.byteLength) {
            break;
        }

        if (chunkType === 0x4e4f534a) {
            jsonChunk = new TextDecoder("utf-8").decode(
                new Uint8Array(gltfBuffer.slice(chunkStart, chunkEnd))
            );
            jsonByteLength = chunkLength;
        } else if (chunkType === 0x004e4942) {
            binaryChunk = gltfBuffer.slice(chunkStart, chunkEnd);
            binaryByteLength = chunkLength;
        }

        offset = chunkEnd;
    }

    let json = null;
    let jsonError = null;

    if (jsonChunk) {
        try {
            json = JSON.parse(jsonChunk);
        } catch (error) {
            jsonError = error instanceof Error ? error.message : String(error);
        }
    }

    return {
        version,
        length,
        jsonChunk,
        binaryChunk,
        jsonByteLength,
        binaryByteLength,
        json,
        jsonError
    };
}

export function validateGltfPayload(gltf) {
    const issues = [];

    if (!gltf?.json) {
        issues.push(gltf?.jsonError ?? "Missing glTF JSON chunk");
    }

    if (!gltf?.binaryChunk) {
        issues.push("Missing binary chunk");
    }

    const json = gltf?.json ?? {};

    if (!Array.isArray(json.buffers) || json.buffers.length === 0) {
        issues.push("No buffers declared in glTF JSON");
    }

    if (!Array.isArray(json.bufferViews) || json.bufferViews.length === 0) {
        issues.push("No bufferViews declared in glTF JSON");
    }

    if (!Array.isArray(json.accessors) || json.accessors.length === 0) {
        issues.push("No accessors declared in glTF JSON");
    }

    if (!Array.isArray(json.meshes) || json.meshes.length === 0) {
        issues.push("No meshes declared in glTF JSON");
    }

    return {
        isValid: issues.length === 0,
        issues,
        meshCount: Array.isArray(json.meshes) ? json.meshes.length : 0,
        accessorCount: Array.isArray(json.accessors) ? json.accessors.length : 0
    };
}

export function rayIntersectsGltf(gltf, ray, options = {}) {
    const validation = validateGltfPayload(gltf);
    if (!validation.isValid) {
        return {
            hit: false,
            trianglesTested: 0,
            reason: "Invalid glTF payload"
        };
    }

    const maxTriangles = Number.isFinite(options.maxTriangles) ? options.maxTriangles : 20000;
    const direction = normalizeVec3(ray?.direction);
    const origin = ray?.origin;
    if (!origin || !direction) {
        return {
            hit: false,
            trianglesTested: 0,
            reason: "Invalid ray"
        };
    }

    const json = gltf.json;
    let trianglesTested = 0;

    for (const mesh of json.meshes ?? []) {
        for (const primitive of mesh.primitives ?? []) {
            const positionAccessorIndex = primitive.attributes?.POSITION;
            if (positionAccessorIndex === undefined) continue;

            const positions = getAccessorData(gltf, positionAccessorIndex);
            if (!positions) continue;

            const indices =
                primitive.indices !== undefined ? getAccessorData(gltf, primitive.indices) : null;

            const hit = testRayAgainstPrimitive(
                origin,
                direction,
                positions,
                indices,
                maxTriangles,
                trianglesTested
            );

            trianglesTested = hit.trianglesTested;

            if (hit.hit) {
                return {
                    hit: true,
                    trianglesTested,
                    reason: "Hit geometry"
                };
            }

            if (trianglesTested >= maxTriangles) {
                return {
                    hit: false,
                    trianglesTested,
                    reason: "Triangle limit reached"
                };
            }
        }
    }

    return {
        hit: false,
        trianglesTested,
        reason: "No hit"
    };
}

function testRayAgainstPrimitive(origin, direction, positions, indices, maxTriangles, startCount) {
    let trianglesTested = startCount;

    const positionStride = 3;
    const indexArray = indices ? Array.from(indices) : null;

    const triangleCount = indexArray ? Math.floor(indexArray.length / 3) : positions.length / 9;

    for (let i = 0; i < triangleCount; i += 1) {
        if (trianglesTested >= maxTriangles) break;

        const indexBase = i * 3;
        const idx0 = indexArray ? indexArray[indexBase] : indexBase;
        const idx1 = indexArray ? indexArray[indexBase + 1] : indexBase + 1;
        const idx2 = indexArray ? indexArray[indexBase + 2] : indexBase + 2;

        const v0 = readVec3(positions, idx0 * positionStride);
        const v1 = readVec3(positions, idx1 * positionStride);
        const v2 = readVec3(positions, idx2 * positionStride);

        trianglesTested += 1;

        if (rayIntersectsTriangle(origin, direction, v0, v1, v2)) {
            return { hit: true, trianglesTested };
        }
    }

    return { hit: false, trianglesTested };
}

function getAccessorData(gltf, accessorIndex) {
    const accessor = gltf?.json?.accessors?.[accessorIndex];
    if (!accessor) return null;

    const bufferView = gltf.json.bufferViews?.[accessor.bufferView];
    if (!bufferView || !gltf.binaryChunk) return null;

    const componentType = accessor.componentType;
    const componentSize = getComponentSize(componentType);
    const elementSize = getAccessorTypeSize(accessor.type);

    if (!componentSize || !elementSize) return null;

    const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const byteLength = accessor.count * elementSize * componentSize;

    if (byteOffset + byteLength > gltf.binaryChunk.byteLength) return null;

    const slice = gltf.binaryChunk.slice(byteOffset, byteOffset + byteLength);

    switch (componentType) {
        case 5126:
            return new Float32Array(slice);
        case 5123:
            return new Uint16Array(slice);
        case 5125:
            return new Uint32Array(slice);
        default:
            return null;
    }
}

function getComponentSize(componentType) {
    switch (componentType) {
        case 5126:
            return 4;
        case 5123:
            return 2;
        case 5125:
            return 4;
        default:
            return null;
    }
}

function getAccessorTypeSize(type) {
    switch (type) {
        case "SCALAR":
            return 1;
        case "VEC2":
            return 2;
        case "VEC3":
            return 3;
        case "VEC4":
            return 4;
        default:
            return null;
    }
}

function rayIntersectsTriangle(origin, direction, v0, v1, v2) {
    const epsilon = 1e-8;
    const edge1 = subtractVec3(v1, v0);
    const edge2 = subtractVec3(v2, v0);
    const h = crossVec3(direction, edge2);
    const a = dotVec3(edge1, h);

    if (a > -epsilon && a < epsilon) return false;

    const f = 1 / a;
    const s = subtractVec3(origin, v0);
    const u = f * dotVec3(s, h);
    if (u < 0 || u > 1) return false;

    const q = crossVec3(s, edge1);
    const v = f * dotVec3(direction, q);
    if (v < 0 || u + v > 1) return false;

    const t = f * dotVec3(edge2, q);
    return t > epsilon;
}

function normalizeVec3(vec) {
    if (!Array.isArray(vec) || vec.length < 3) return null;
    const length = Math.sqrt(vec[0] ** 2 + vec[1] ** 2 + vec[2] ** 2);
    if (length === 0) return null;
    return [vec[0] / length, vec[1] / length, vec[2] / length];
}

function subtractVec3(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function crossVec3(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
    ];
}

function dotVec3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function readVec3(buffer, index) {
    return [buffer[index], buffer[index + 1], buffer[index + 2]];
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
