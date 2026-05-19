const DEFAULT_TILESET_URL =
    "https://daten-hamburg.de/gdi3d/datasource-data/LoD3_untexturiert/tileset.json";

let tilesetIndexPromise = null;
const IDENTITY_MATRIX_4 = Object.freeze([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
]);
const B3DM_Y_UP_TO_Z_UP_MATRIX = Object.freeze([
    1, 0, 0, 0,
    0, 0, 1, 0,
    0, -1, 0, 0,
    0, 0, 0, 1
]);
const DEFAULT_FOOTPRINT_MAX_POINTS = 12000;
const DEFAULT_BUILDING_FOOTPRINT_MAX_POINTS = 1200;
const GLTF_MATRIX_APPLY_MODE = "cesium-column-major";
const ACCESSOR_CACHE = new WeakMap();

export async function loadNearbyBuildingData(lat, lon, options = {}) {
    const {
        debug = true,
        neighborRadius = 1,
        maxTiles = 9,
        ray = null,
        rayOptions = {},
        includeFootprints = true,
        tilesetUrl = DEFAULT_TILESET_URL
    } = options;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        if (debug) {
            console.warn("[b3dm] Skipping building data load: invalid coordinates.");
        }
        return [];
    }

    const tilesetIndex = await loadTilesetIndex(tilesetUrl, debug);
    const tileRequests = pickNearbyTilesetEntries(lat, lon, tilesetIndex, {
        maxTiles: Math.max(1, maxTiles),
        neighborRadius
    }).map((entry) => ({
        tile: entry.tile,
        url: entry.url,
        tileCenter: entry.center,
        selectionDistanceMeters: entry.distanceMeters,
        tilesetEntry: entry
    }));

    if (debug) {
        console.info("[b3dm] Attempting to load nearby tiles", {
            lat,
            lon,
            selectionMode: "tileset-regions",
            tiles: tileRequests.map((request) => request.tile)
        });
    }

    const results = await Promise.all(
        tileRequests.map(async (tileRequest) => {
            const { tile, url, tileCenter, selectionDistanceMeters, tilesetEntry } = tileRequest;
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const buffer = await response.arrayBuffer();
                const header = parseB3dmHeader(buffer);
                const featureTable = extractFeatureTableJson(buffer);
                const gltf = extractGltfFromB3dm(buffer);
                const validation = gltf ? validateGltfPayload(gltf) : null;
                const tilesetCenter = tilesetEntry?.region
                    ? getRegionCenter(tilesetEntry.region)
                    : tileCenter;
                const featureRtcCenter = getFeatureRtcCenter(featureTable);
                const gltfRtcCenter = getGltfRtcCenter(gltf);
                const rtcCenter = featureRtcCenter ?? gltfRtcCenter;
                const modelMatrix = buildModelMatrix(
                    {
                        featureRtcCenter,
                        gltfRtcCenter
                    },
                    tilesetEntry?.transform
                );
                const footprint = gltf && includeFootprints && tilesetCenter
                    ? computeGltfFootprint(gltf, {
                          modelMatrix,
                          referenceCenter: tilesetCenter
                      })
                    : null;
                const buildingFootprints = gltf && includeFootprints && tilesetCenter
                    ? computeGltfBuildingFootprints(gltf, {
                          modelMatrix,
                          referenceCenter: tilesetCenter
                      })
                    : [];
                const rayCheck = gltf && ray
                    ? rayIntersectsGltf(gltf, ray, {
                          ...rayOptions,
                          modelMatrix
                      })
                    : null;

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
                            : null,
                        rtcCenter,
                        selectionDistanceMeters,
                        footprint: footprint
                            ? {
                                  hullPointCount: footprint.hullPointCount,
                                  sourcePointCount: footprint.sourcePointCount
                              }
                            : null,
                        buildingFootprints: Array.isArray(buildingFootprints)
                            ? buildingFootprints.length
                            : 0,
                        tileset: tilesetCenter
                            ? {
                                  centerLat: tilesetCenter.lat,
                                  centerLon: tilesetCenter.lon,
                                  centerHeight: tilesetCenter.height
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

                    if (!tilesetEntry) {
                        console.info("[b3dm] No tileset mapping for tile", {
                            tile,
                            tilesetUrl
                        });
                    }
                }

                return {
                    tile,
                    buffer,
                    header,
                    featureTable,
                    gltf,
                    validation,
                    rayCheck,
                    tilesetEntry,
                    tilesetCenter,
                    rtcCenter,
                    modelMatrix,
                    selectionDistanceMeters,
                    footprint,
                    buildingFootprints,
                    matrixApplyMode: GLTF_MATRIX_APPLY_MODE
                };
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
    const debugSummary = {
    selectionMode: "tileset-regions",
        requested: tileRequests.length,
        loaded: loaded.length,
        requestedTiles: tileRequests.map((request) => ({
            tile: request.tile,
            selectionDistanceMeters: request.selectionDistanceMeters,
            tileCenter: request.tileCenter
        }))
    };

    if (debug) {
        console.info("[b3dm] Building data load summary", {
            requested: debugSummary.requested,
            loaded: debugSummary.loaded
        });
    }

    Object.defineProperty(loaded, "debugSummary", {
        value: debugSummary,
        configurable: true,
        enumerable: false,
        writable: true
    });

    return loaded;
}

export async function loadTilesetIndex(tilesetUrl = DEFAULT_TILESET_URL, debug = false) {
    if (!tilesetIndexPromise) {
        tilesetIndexPromise = buildTilesetIndex(tilesetUrl, debug);
    }

    return tilesetIndexPromise;
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

function extractFeatureTableJson(buffer) {
    const header = parseB3dmHeader(buffer);
    if (!header || header.magic !== "b3dm" || buffer.byteLength < 28) {
        return null;
    }

    const view = new DataView(buffer);
    const featureTableJsonByteLength = view.getUint32(12, true);

    if (featureTableJsonByteLength <= 0) {
        return null;
    }

    const jsonStart = 28;
    const jsonEnd = jsonStart + featureTableJsonByteLength;

    if (jsonEnd > buffer.byteLength) {
        return null;
    }

    try {
        const featureTableJson = new TextDecoder("utf-8").decode(
            new Uint8Array(buffer.slice(jsonStart, jsonEnd))
        );
        return JSON.parse(featureTableJson);
    } catch (_error) {
        return null;
    }
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
    const sceneRootNodes = getSceneRootNodes(json);
    const modelMatrix = isMatrix4(options.modelMatrix) ? options.modelMatrix : IDENTITY_MATRIX_4;
    let trianglesTested = 0;

    for (const nodeIndex of sceneRootNodes) {
        const hit = testRayAgainstNode(
            gltf,
            nodeIndex,
            modelMatrix,
            origin,
            direction,
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

    return {
        hit: false,
        trianglesTested,
        reason: "No hit"
    };
}

export function computeGltfFootprint(gltf, options = {}) {
    const validation = validateGltfPayload(gltf);
    if (!validation.isValid) {
        return null;
    }

    const referenceCenter = options.referenceCenter;
    if (
        !referenceCenter ||
        !Number.isFinite(referenceCenter.lat) ||
        !Number.isFinite(referenceCenter.lon)
    ) {
        return null;
    }

    const json = gltf.json;
    const sceneRootNodes = getSceneRootNodes(json);
    const modelMatrix = isMatrix4(options.modelMatrix) ? options.modelMatrix : IDENTITY_MATRIX_4;
    const maxPointCount =
        Number.isFinite(options.maxPointCount) && options.maxPointCount > 0
            ? Math.floor(options.maxPointCount)
            : DEFAULT_FOOTPRINT_MAX_POINTS;
    const footprintPoints = [];
    const footprintSources = [];
    const footprintStats = {
        sampledPointCount: 0,
        totalVertexCount: 0,
        maxPointCount,
        isSampled: false
    };

    for (const nodeIndex of sceneRootNodes) {
        collectFootprintSourcesForNode(gltf, nodeIndex, modelMatrix, footprintSources);
    }

    if (footprintSources.length === 0) {
        return null;
    }

    footprintStats.totalVertexCount = footprintSources.reduce(
        (sum, source) => sum + (Number.isFinite(source.vertexCount) ? source.vertexCount : 0),
        0
    );

    for (
        let sourceIndex = 0;
        sourceIndex < footprintSources.length && footprintStats.sampledPointCount < footprintStats.maxPointCount;
        sourceIndex += 1
    ) {
        appendFootprintSourcePoints(
            gltf,
            footprintSources[sourceIndex],
            referenceCenter,
            footprintPoints,
            footprintStats,
            footprintSources.length - sourceIndex
        );
    }

    if (footprintPoints.length < 3) {
        return null;
    }

    const hull = buildConvexHull2d(footprintPoints);

    if (hull.length < 3) {
        return null;
    }

    return {
        polygonLatLon: hull.map((point) => [point.lat, point.lon]),
        hullPointCount: hull.length,
        sourcePointCount: footprintPoints.length,
        sampledPointCount: footprintStats.sampledPointCount,
        totalVertexCount: footprintStats.totalVertexCount,
        isSampled: footprintStats.isSampled
    };
}

export function computeGltfBuildingFootprints(gltf, options = {}) {
    const validation = validateGltfPayload(gltf);
    if (!validation.isValid) {
        return [];
    }

    const referenceCenter = options.referenceCenter;
    if (
        !referenceCenter ||
        !Number.isFinite(referenceCenter.lat) ||
        !Number.isFinite(referenceCenter.lon)
    ) {
        return [];
    }

    const modelMatrix = isMatrix4(options.modelMatrix) ? options.modelMatrix : IDENTITY_MATRIX_4;
    const maxPointsPerBuilding =
        Number.isFinite(options.maxPointsPerBuilding) && options.maxPointsPerBuilding > 0
            ? Math.floor(options.maxPointsPerBuilding)
            : DEFAULT_BUILDING_FOOTPRINT_MAX_POINTS;
    const minAreaSquareMeters =
        Number.isFinite(options.minAreaSquareMeters) && options.minAreaSquareMeters >= 0
            ? options.minAreaSquareMeters
            : 4;
    const buildingSources = [];
    const sceneRootNodes = getSceneRootNodes(gltf.json);

    for (const nodeIndex of sceneRootNodes) {
        collectBuildingFootprintSourcesForNode(
            gltf,
            nodeIndex,
            modelMatrix,
            buildingSources
        );
    }

    if (buildingSources.length === 0) {
        return [];
    }

    return buildingSources
        .map((sourceGroup) =>
            computeFootprintFromSources(
                gltf,
                sourceGroup.sources,
                referenceCenter,
                maxPointsPerBuilding
            )
        )
        .filter((footprint) => {
            if (!footprint || !Array.isArray(footprint.polygonLatLon)) return false;
            return (footprint.areaSquareMeters ?? 0) >= minAreaSquareMeters;
        });
}

export function buildingTilesToGeoJson(buildingData = []) {
    const features = [];

    for (const tile of buildingData) {
        const tileName = tile?.tile ?? "unknown-tile";
        const footprints = Array.isArray(tile?.buildingFootprints) ? tile.buildingFootprints : [];

        footprints.forEach((footprint, index) => {
            const ring = Array.isArray(footprint?.polygonLatLon)
                ? footprint.polygonLatLon
                      .filter(
                          (point) =>
                              Array.isArray(point) &&
                              point.length >= 2 &&
                              Number.isFinite(point[0]) &&
                              Number.isFinite(point[1])
                      )
                      .map(([lat, lon]) => [lon, lat])
                : [];

            if (ring.length < 3) return;
            const closedRing = [...ring];
            const [firstLon, firstLat] = ring[0];
            const [lastLon, lastLat] = ring[ring.length - 1];
            if (firstLon !== lastLon || firstLat !== lastLat) {
                closedRing.push([firstLon, firstLat]);
            }

            features.push({
                type: "Feature",
                properties: {
                    tile: tileName,
                    buildingIndex: index,
                    areaSquareMeters: footprint?.areaSquareMeters ?? null,
                    hullPointCount: footprint?.hullPointCount ?? 0,
                    sampledPointCount: footprint?.sampledPointCount ?? 0,
                    totalVertexCount: footprint?.totalVertexCount ?? 0
                },
                geometry: {
                    type: "Polygon",
                    coordinates: [closedRing]
                }
            });
        });
    }

    return {
        type: "FeatureCollection",
        features
    };
}

function collectFootprintSourcesForNode(gltf, nodeIndex, parentMatrix, footprintSources) {
    const node = gltf?.json?.nodes?.[nodeIndex];
    if (!node) return;

    const localMatrix = getNodeLocalMatrix(node);
    const worldMatrix = multiplyMat4(parentMatrix, localMatrix);

    if (Number.isInteger(node.mesh)) {
        const mesh = gltf.json.meshes?.[node.mesh];
        collectFootprintSourcesForMesh(gltf, mesh, worldMatrix, footprintSources);
    }

    for (const childIndex of node.children ?? []) {
        collectFootprintSourcesForNode(gltf, childIndex, worldMatrix, footprintSources);
    }
}

function collectBuildingFootprintSourcesForNode(gltf, nodeIndex, parentMatrix, groups) {
    const node = gltf?.json?.nodes?.[nodeIndex];
    if (!node) return;

    const localMatrix = getNodeLocalMatrix(node);
    const worldMatrix = multiplyMat4(parentMatrix, localMatrix);

    if (Number.isInteger(node.mesh)) {
        const mesh = gltf.json.meshes?.[node.mesh];
        collectBuildingFootprintGroupsForMesh(gltf, mesh, worldMatrix, groups, nodeIndex, node.mesh);
    }

    for (const childIndex of node.children ?? []) {
        collectBuildingFootprintSourcesForNode(gltf, childIndex, worldMatrix, groups);
    }
}

function collectBuildingFootprintGroupsForMesh(
    gltf,
    mesh,
    worldMatrix,
    groups,
    nodeIndex,
    meshIndex
) {
    for (const primitive of mesh?.primitives ?? []) {
        const positionAccessorIndex = primitive.attributes?.POSITION;
        if (positionAccessorIndex === undefined) continue;

        const positions = getAccessorData(gltf, positionAccessorIndex);
        const accessor = gltf?.json?.accessors?.[positionAccessorIndex];
        const vertexCount = Number.isFinite(accessor?.count)
            ? accessor.count
            : Math.floor((positions?.length ?? 0) / 3);

        if (!positions || vertexCount < 3) {
            groups.push({
                nodeIndex,
                meshIndex,
                sources: [
                    {
                        accessorIndex: positionAccessorIndex,
                        worldMatrix,
                        vertexCount: Number.isFinite(accessor?.count) ? accessor.count : 8
                    }
                ]
            });
            continue;
        }

        const rawIndices =
            primitive.indices !== undefined ? getAccessorData(gltf, primitive.indices) : null;
        const batchAccessorIndex = getBatchIdAccessorIndex(primitive);
        const batchIds = Number.isInteger(batchAccessorIndex)
            ? getAccessorData(gltf, batchAccessorIndex)
            : null;
        const batchGroups = splitPrimitiveVerticesByBatchId(batchIds, rawIndices, vertexCount);

        if (batchGroups && batchGroups.length > 0) {
            batchGroups.forEach((componentVertexIndices) => {
                if (!Array.isArray(componentVertexIndices) || componentVertexIndices.length < 3) return;
                groups.push({
                    nodeIndex,
                    meshIndex,
                    sources: [
                        {
                            accessorIndex: positionAccessorIndex,
                            worldMatrix,
                            vertexCount: componentVertexIndices.length,
                            vertexIndices: componentVertexIndices
                        }
                    ]
                });
            });
            continue;
        }

        const components = rawIndices
            ? splitIndexedPrimitiveIntoConnectedComponents(rawIndices, vertexCount)
            : null;

        if (!components || components.length <= 1) {
            groups.push({
                nodeIndex,
                meshIndex,
                sources: [
                    {
                        accessorIndex: positionAccessorIndex,
                        worldMatrix,
                        vertexCount
                    }
                ]
            });
            continue;
        }

        components.forEach((componentVertexIndices) => {
            if (!Array.isArray(componentVertexIndices) || componentVertexIndices.length < 3) return;
            groups.push({
                nodeIndex,
                meshIndex,
                sources: [
                    {
                        accessorIndex: positionAccessorIndex,
                        worldMatrix,
                        vertexCount: componentVertexIndices.length,
                        vertexIndices: componentVertexIndices
                    }
                ]
            });
        });
    }
}

function getBatchIdAccessorIndex(primitive) {
    const attributes = primitive?.attributes ?? {};
    const candidates = ["_BATCHID", "BATCHID", "BATCH_ID", "batchId"];
    for (const candidate of candidates) {
        if (Number.isInteger(attributes[candidate])) {
            return attributes[candidate];
        }
    }
    return null;
}

function splitPrimitiveVerticesByBatchId(batchIds, indices, vertexCount) {
    if (!batchIds || batchIds.length < vertexCount || vertexCount < 3) {
        return null;
    }

    const groupMap = new Map();
    const addToGroup = (batchId, vertexIndex) => {
        if (!Number.isFinite(batchId)) return;
        if (!groupMap.has(batchId)) {
            groupMap.set(batchId, new Set());
        }
        groupMap.get(batchId).add(vertexIndex);
    };

    if (indices) {
        const triangleCount = Math.floor(indices.length / 3);
        for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
            const base = triangleIndex * 3;
            const a = indices[base];
            const b = indices[base + 1];
            const c = indices[base + 2];
            if (!isValidVertexIndex(a, vertexCount) || !isValidVertexIndex(b, vertexCount) || !isValidVertexIndex(c, vertexCount)) {
                continue;
            }

            const batchA = Number(batchIds[a]);
            const batchB = Number(batchIds[b]);
            const batchC = Number(batchIds[c]);
            if (batchA === batchB && batchB === batchC) {
                addToGroup(batchA, a);
                addToGroup(batchA, b);
                addToGroup(batchA, c);
            } else {
                addToGroup(batchA, a);
                addToGroup(batchB, b);
                addToGroup(batchC, c);
            }
        }
    } else {
        for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
            addToGroup(Number(batchIds[vertexIndex]), vertexIndex);
        }
    }

    if (groupMap.size === 0) {
        return null;
    }

    return [...groupMap.values()]
        .map((vertexSet) => [...vertexSet])
        .filter((vertexIndices) => vertexIndices.length >= 3);
}

function collectFootprintSourcesForMesh(gltf, mesh, worldMatrix, footprintSources) {
    for (const primitive of mesh?.primitives ?? []) {
        const positionAccessorIndex = primitive.attributes?.POSITION;
        if (positionAccessorIndex === undefined) continue;

        const accessor = gltf.json.accessors?.[positionAccessorIndex];
        footprintSources.push({
            accessorIndex: positionAccessorIndex,
            worldMatrix,
            vertexCount: Number.isFinite(accessor?.count) ? accessor.count : 8
        });
    }
}

function appendFootprintSourcePoints(
    gltf,
    source,
    referenceCenter,
    footprintPoints,
    footprintStats,
    remainingSourceCount
) {
    const remainingBudget = Math.max(0, footprintStats.maxPointCount - footprintStats.sampledPointCount);
    if (remainingBudget === 0) {
        footprintStats.isSampled = true;
        return;
    }

    const sourceBudget = Math.max(1, Math.ceil(remainingBudget / Math.max(1, remainingSourceCount)));
    const accessor = gltf?.json?.accessors?.[source.accessorIndex];
    const positions = getAccessorData(gltf, source.accessorIndex);

    if (positions) {
        const vertexCount = Math.floor(positions.length / 3);
        const useTransform = !isIdentityMatrix4(source.worldMatrix);
        const sourceVertexIndices = Array.isArray(source.vertexIndices)
            ? source.vertexIndices.filter(
                  (vertexIndex) => Number.isInteger(vertexIndex) && vertexIndex >= 0 && vertexIndex < vertexCount
              )
            : null;
        const candidateCount = sourceVertexIndices ? sourceVertexIndices.length : vertexCount;
        const stride = Math.max(1, Math.ceil(candidateCount / sourceBudget));

        if (stride > 1) {
            footprintStats.isSampled = true;
        }

        if (sourceVertexIndices) {
            for (
                let vertexOffset = 0;
                vertexOffset < sourceVertexIndices.length &&
                footprintStats.sampledPointCount < footprintStats.maxPointCount;
                vertexOffset += stride
            ) {
                const vertexIndex = sourceVertexIndices[vertexOffset];
                const worldPoint = readVec3(
                    positions,
                    vertexIndex * 3,
                    source.worldMatrix,
                    useTransform
                );
                const latLonHeight = ecefToLatLonHeight(worldPoint);
                if (!latLonHeight) continue;

                footprintPoints.push(projectLatLonToLocalPoint(latLonHeight, referenceCenter));
                footprintStats.sampledPointCount += 1;
            }
        } else {
            for (
                let vertexIndex = 0;
                vertexIndex < vertexCount && footprintStats.sampledPointCount < footprintStats.maxPointCount;
                vertexIndex += stride
            ) {
                const worldPoint = readVec3(
                    positions,
                    vertexIndex * 3,
                    source.worldMatrix,
                    useTransform
                );
                const latLonHeight = ecefToLatLonHeight(worldPoint);
                if (!latLonHeight) continue;

                footprintPoints.push(projectLatLonToLocalPoint(latLonHeight, referenceCenter));
                footprintStats.sampledPointCount += 1;
            }
        }

        return;
    }

    const corners = getTransformedAccessorCorners(accessor, source.worldMatrix);
    if (!corners.length) {
        return;
    }

    const stride = Math.max(1, Math.ceil(corners.length / sourceBudget));
    if (stride > 1) {
        footprintStats.isSampled = true;
    }

    for (
        let pointIndex = 0;
        pointIndex < corners.length && footprintStats.sampledPointCount < footprintStats.maxPointCount;
        pointIndex += stride
    ) {
        const latLonHeight = ecefToLatLonHeight(corners[pointIndex]);
        if (!latLonHeight) continue;

        footprintPoints.push(projectLatLonToLocalPoint(latLonHeight, referenceCenter));
        footprintStats.sampledPointCount += 1;
    }
}

function splitIndexedPrimitiveIntoConnectedComponents(indices, vertexCount) {
    const triangleCount = Math.floor(indices.length / 3);
    if (triangleCount <= 1 || vertexCount < 3) return null;

    const parent = new Int32Array(vertexCount);
    const rank = new Uint8Array(vertexCount);
    for (let i = 0; i < vertexCount; i += 1) {
        parent[i] = i;
    }

    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
        const base = triangleIndex * 3;
        const a = indices[base];
        const b = indices[base + 1];
        const c = indices[base + 2];
        if (!isValidVertexIndex(a, vertexCount) || !isValidVertexIndex(b, vertexCount) || !isValidVertexIndex(c, vertexCount)) {
            continue;
        }
        unionDisjointSet(parent, rank, a, b);
        unionDisjointSet(parent, rank, b, c);
    }

    const componentMap = new Map();
    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
        const base = triangleIndex * 3;
        const tri = [indices[base], indices[base + 1], indices[base + 2]];
        if (!tri.every((index) => isValidVertexIndex(index, vertexCount))) continue;

        const root = findDisjointSetRoot(parent, tri[0]);
        if (!componentMap.has(root)) {
            componentMap.set(root, new Set());
        }
        const componentVertices = componentMap.get(root);
        tri.forEach((vertexIndex) => componentVertices.add(vertexIndex));
    }

    return [...componentMap.values()].map((vertexSet) => [...vertexSet]);
}

function findDisjointSetRoot(parent, value) {
    let node = value;
    while (parent[node] !== node) {
        parent[node] = parent[parent[node]];
        node = parent[node];
    }
    return node;
}

function unionDisjointSet(parent, rank, a, b) {
    const rootA = findDisjointSetRoot(parent, a);
    const rootB = findDisjointSetRoot(parent, b);
    if (rootA === rootB) return;

    if (rank[rootA] < rank[rootB]) {
        parent[rootA] = rootB;
    } else if (rank[rootA] > rank[rootB]) {
        parent[rootB] = rootA;
    } else {
        parent[rootB] = rootA;
        rank[rootA] += 1;
    }
}

function isValidVertexIndex(value, vertexCount) {
    return Number.isInteger(value) && value >= 0 && value < vertexCount;
}

function computeFootprintFromSources(gltf, sources, referenceCenter, maxPointCount) {
    const footprintPoints = [];
    const footprintStats = {
        sampledPointCount: 0,
        totalVertexCount: 0,
        maxPointCount,
        isSampled: false
    };

    footprintStats.totalVertexCount = sources.reduce(
        (sum, source) => sum + (Number.isFinite(source.vertexCount) ? source.vertexCount : 0),
        0
    );

    for (
        let sourceIndex = 0;
        sourceIndex < sources.length && footprintStats.sampledPointCount < footprintStats.maxPointCount;
        sourceIndex += 1
    ) {
        appendFootprintSourcePoints(
            gltf,
            sources[sourceIndex],
            referenceCenter,
            footprintPoints,
            footprintStats,
            sources.length - sourceIndex
        );
    }

    if (footprintPoints.length < 3) {
        return null;
    }

    const hull = buildConvexHull2d(footprintPoints);
    if (hull.length < 3) {
        return null;
    }

    const polygonLocal = hull.map((point) => ({ x: point.x, y: point.y }));
    const areaSquareMeters = Math.abs(computePolygonArea2d(polygonLocal));

    return {
        polygonLatLon: hull.map((point) => [point.lat, point.lon]),
        hullPointCount: hull.length,
        sourcePointCount: footprintPoints.length,
        sampledPointCount: footprintStats.sampledPointCount,
        totalVertexCount: footprintStats.totalVertexCount,
        isSampled: footprintStats.isSampled,
        areaSquareMeters
    };
}

function testRayAgainstNode(gltf, nodeIndex, parentMatrix, origin, direction, maxTriangles, startCount) {
    const node = gltf?.json?.nodes?.[nodeIndex];
    if (!node) {
        return { hit: false, trianglesTested: startCount };
    }

    const localMatrix = getNodeLocalMatrix(node);
    const worldMatrix = multiplyMat4(parentMatrix, localMatrix);
    let trianglesTested = startCount;

    if (Number.isInteger(node.mesh)) {
        const mesh = gltf.json.meshes?.[node.mesh];
        const hit = testRayAgainstMesh(
            gltf,
            mesh,
            worldMatrix,
            origin,
            direction,
            maxTriangles,
            trianglesTested
        );
        trianglesTested = hit.trianglesTested;

        if (hit.hit || trianglesTested >= maxTriangles) {
            return { hit: hit.hit, trianglesTested };
        }
    }

    for (const childIndex of node.children ?? []) {
        const hit = testRayAgainstNode(
            gltf,
            childIndex,
            worldMatrix,
            origin,
            direction,
            maxTriangles,
            trianglesTested
        );
        trianglesTested = hit.trianglesTested;

        if (hit.hit || trianglesTested >= maxTriangles) {
            return { hit: hit.hit, trianglesTested };
        }
    }

    return { hit: false, trianglesTested };
}

function testRayAgainstMesh(gltf, mesh, worldMatrix, origin, direction, maxTriangles, startCount) {
    let trianglesTested = startCount;

    for (const primitive of mesh?.primitives ?? []) {
        const positionAccessorIndex = primitive.attributes?.POSITION;
        if (positionAccessorIndex === undefined) continue;

        const positionAccessor = gltf.json.accessors?.[positionAccessorIndex];
        const worldBounds = getTransformedAccessorBounds(positionAccessor, worldMatrix);
        if (worldBounds && !rayIntersectsAabb(origin, direction, worldBounds.min, worldBounds.max)) {
            continue;
        }

        const positions = getAccessorData(gltf, positionAccessorIndex);
        if (!positions) continue;

        const indices =
            primitive.indices !== undefined ? getAccessorData(gltf, primitive.indices) : null;

        const hit = testRayAgainstPrimitive(
            origin,
            direction,
            positions,
            indices,
            worldMatrix,
            maxTriangles,
            trianglesTested
        );

        trianglesTested = hit.trianglesTested;

        if (hit.hit || trianglesTested >= maxTriangles) {
            return { hit: hit.hit, trianglesTested };
        }
    }

    return { hit: false, trianglesTested };
}

function testRayAgainstPrimitive(origin, direction, positions, indices, worldMatrix, maxTriangles, startCount) {
    let trianglesTested = startCount;

    const positionStride = 3;
    const indexArray = indices ? Array.from(indices) : null;
    const useTransform = !isIdentityMatrix4(worldMatrix);

    const triangleCount = indexArray ? Math.floor(indexArray.length / 3) : positions.length / 9;

    for (let i = 0; i < triangleCount; i += 1) {
        if (trianglesTested >= maxTriangles) break;

        const indexBase = i * 3;
        const idx0 = indexArray ? indexArray[indexBase] : indexBase;
        const idx1 = indexArray ? indexArray[indexBase + 1] : indexBase + 1;
        const idx2 = indexArray ? indexArray[indexBase + 2] : indexBase + 2;

        const v0 = readVec3(positions, idx0 * positionStride, worldMatrix, useTransform);
        const v1 = readVec3(positions, idx1 * positionStride, worldMatrix, useTransform);
        const v2 = readVec3(positions, idx2 * positionStride, worldMatrix, useTransform);

        trianglesTested += 1;

        if (rayIntersectsTriangle(origin, direction, v0, v1, v2)) {
            return { hit: true, trianglesTested };
        }
    }

    return { hit: false, trianglesTested };
}

function getAccessorData(gltf, accessorIndex) {
    if (!ACCESSOR_CACHE.has(gltf)) {
        ACCESSOR_CACHE.set(gltf, new Map());
    }

    const cache = ACCESSOR_CACHE.get(gltf);
    if (cache.has(accessorIndex)) {
        return cache.get(accessorIndex);
    }

    const accessor = gltf?.json?.accessors?.[accessorIndex];
    if (!accessor) return null;

    const bufferView = gltf.json.bufferViews?.[accessor.bufferView];
    if (!bufferView || !gltf.binaryChunk) return null;

    const componentType = accessor.componentType;
    const componentSize = getComponentSize(componentType);
    const elementSize = getAccessorTypeSize(accessor.type);

    if (!componentSize || !elementSize) return null;

    const itemComponentCount = accessor.count * elementSize;
    const itemByteSize = elementSize * componentSize;
    const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const byteStride = bufferView.byteStride ?? itemByteSize;
    const byteLength = (accessor.count - 1) * byteStride + itemByteSize;

    if (byteOffset + byteLength > gltf.binaryChunk.byteLength) return null;

    if (byteStride < itemByteSize) {
        return null;
    }

    const result = createAccessorArray(componentType, itemComponentCount);
    if (!result) {
        return null;
    }

    const view = new DataView(gltf.binaryChunk);

    for (let itemIndex = 0; itemIndex < accessor.count; itemIndex += 1) {
        const sourceOffset = byteOffset + itemIndex * byteStride;
        const targetOffset = itemIndex * elementSize;

        for (let componentIndex = 0; componentIndex < elementSize; componentIndex += 1) {
            result[targetOffset + componentIndex] = readComponent(
                view,
                sourceOffset + componentIndex * componentSize,
                componentType
            );
        }
    }

    cache.set(accessorIndex, result);
    return result;
}

function createAccessorArray(componentType, length) {
    switch (componentType) {
        case 5120:
            return new Int8Array(length);
        case 5121:
            return new Uint8Array(length);
        case 5122:
            return new Int16Array(length);
        case 5123:
            return new Uint16Array(length);
        case 5125:
            return new Uint32Array(length);
        case 5126:
            return new Float32Array(length);
        default:
            return null;
    }
}

function readComponent(view, byteOffset, componentType) {
    switch (componentType) {
        case 5120:
            return view.getInt8(byteOffset);
        case 5121:
            return view.getUint8(byteOffset);
        case 5122:
            return view.getInt16(byteOffset, true);
        case 5123:
            return view.getUint16(byteOffset, true);
        case 5125:
            return view.getUint32(byteOffset, true);
        case 5126:
            return view.getFloat32(byteOffset, true);
        default:
            return 0;
    }
}

function getComponentSize(componentType) {
    switch (componentType) {
        case 5120:
        case 5121:
            return 1;
        case 5122:
        case 5123:
            return 2;
        case 5125:
        case 5126:
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

function rayIntersectsAabb(origin, direction, min, max) {
    let tMin = -Infinity;
    let tMax = Infinity;

    for (let axis = 0; axis < 3; axis += 1) {
        const axisOrigin = origin[axis];
        const axisDirection = direction[axis];
        const axisMin = min[axis];
        const axisMax = max[axis];

        if (Math.abs(axisDirection) < 1e-12) {
            if (axisOrigin < axisMin || axisOrigin > axisMax) {
                return false;
            }
            continue;
        }

        const inverseDirection = 1 / axisDirection;
        let t1 = (axisMin - axisOrigin) * inverseDirection;
        let t2 = (axisMax - axisOrigin) * inverseDirection;

        if (t1 > t2) {
            const temp = t1;
            t1 = t2;
            t2 = temp;
        }

        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);

        if (tMax < tMin) {
            return false;
        }
    }

    return tMax >= Math.max(0, tMin);
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

function readVec3(buffer, index, matrix = IDENTITY_MATRIX_4, applyTransform = false) {
    const point = [buffer[index], buffer[index + 1], buffer[index + 2]];
    return applyTransform ? transformPointGltfMat4(matrix, point) : point;
}

function getTransformedAccessorBounds(accessor, worldMatrix) {
    const min = accessor?.min;
    const max = accessor?.max;

    if (
        !Array.isArray(min) ||
        !Array.isArray(max) ||
        min.length < 3 ||
        max.length < 3 ||
        !min.every(Number.isFinite) ||
        !max.every(Number.isFinite)
    ) {
        return null;
    }

    const corners = [
        [min[0], min[1], min[2]],
        [min[0], min[1], max[2]],
        [min[0], max[1], min[2]],
        [min[0], max[1], max[2]],
        [max[0], min[1], min[2]],
        [max[0], min[1], max[2]],
        [max[0], max[1], min[2]],
        [max[0], max[1], max[2]]
    ].map((corner) => transformPointGltfMat4(worldMatrix, corner));

    const worldMin = [Infinity, Infinity, Infinity];
    const worldMax = [-Infinity, -Infinity, -Infinity];

    for (const corner of corners) {
        for (let axis = 0; axis < 3; axis += 1) {
            worldMin[axis] = Math.min(worldMin[axis], corner[axis]);
            worldMax[axis] = Math.max(worldMax[axis], corner[axis]);
        }
    }

    return { min: worldMin, max: worldMax };
}

function getTransformedAccessorCorners(accessor, worldMatrix) {
    const min = accessor?.min;
    const max = accessor?.max;

    if (
        !Array.isArray(min) ||
        !Array.isArray(max) ||
        min.length < 3 ||
        max.length < 3 ||
        !min.every(Number.isFinite) ||
        !max.every(Number.isFinite)
    ) {
        return [];
    }

    return [
        [min[0], min[1], min[2]],
        [min[0], min[1], max[2]],
        [min[0], max[1], min[2]],
        [min[0], max[1], max[2]],
        [max[0], min[1], min[2]],
        [max[0], min[1], max[2]],
        [max[0], max[1], min[2]],
        [max[0], max[1], max[2]]
    ].map((corner) => transformPointGltfMat4(worldMatrix, corner));
}

async function buildTilesetIndex(tilesetUrl, debug) {
    const index = [];
    const queue = [{ url: tilesetUrl, parentTransform: IDENTITY_MATRIX_4 }];
    const visited = new Set();

    while (queue.length) {
        const { url, parentTransform } = queue.shift();
        if (visited.has(url)) continue;
        visited.add(url);

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const tileset = await response.json();
            const baseUrl = new URL(url, url).href;
            collectTilesetEntries(tileset?.root, baseUrl, index, queue, parentTransform);
        } catch (error) {
            if (debug) {
                console.warn("[b3dm] Failed to load tileset index", {
                    url,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    }

    if (debug) {
        console.info("[b3dm] Tileset index loaded", {
            entries: index.length
        });
    }

    return index;
}

function collectTilesetEntries(
    node,
    baseUrl,
    index,
    queue,
    parentTransform = IDENTITY_MATRIX_4
) {
    if (!node) return;

    const nodeTransform = isMatrix4(node.transform) ? node.transform : IDENTITY_MATRIX_4;
    const accumulatedTransform = multiplyMat4(parentTransform, nodeTransform);
    const contentUri = node.content?.uri || node.content?.url;
    const contentBounding = node.content?.boundingVolume?.region || node.boundingVolume?.region;

    if (contentUri) {
        const resolved = new URL(contentUri, baseUrl).href;
        if (contentUri.endsWith(".json")) {
            queue.push({ url: resolved, parentTransform: accumulatedTransform });
        } else if (contentUri.endsWith(".b3dm") && contentBounding) {
            const fileName = resolved.split("/").pop();
            if (fileName) {
                index.push({
                    tile: fileName,
                    region: contentBounding,
                    url: resolved,
                    transform: accumulatedTransform,
                    center: getRegionCenter(contentBounding)
                });
            }
        }
    }

    if (Array.isArray(node.children)) {
        node.children.forEach((child) =>
            collectTilesetEntries(child, baseUrl, index, queue, accumulatedTransform)
        );
    }
}

function getRegionCenter(region) {
    if (!Array.isArray(region) || region.length < 6) return null;
    const [west, south, east, north, minHeight, maxHeight] = region;
    const lon = ((west + east) / 2) * (180 / Math.PI);
    const lat = ((south + north) / 2) * (180 / Math.PI);
    const height = (minHeight + maxHeight) / 2;
    return { lat, lon, height };
}

export function latLonHeightToEnu(lat, lon, height, origin) {
    if (!origin || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const originLat = origin.lat;
    const originLon = origin.lon;
    const originHeight = origin.height ?? 0;

    const pointEcef = toEcef(lat, lon, height ?? 0);
    const originEcef = toEcef(originLat, originLon, originHeight);

    const dx = pointEcef[0] - originEcef[0];
    const dy = pointEcef[1] - originEcef[1];
    const dz = pointEcef[2] - originEcef[2];

    const latRad = originLat * (Math.PI / 180);
    const lonRad = originLon * (Math.PI / 180);

    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);

    const east = -sinLon * dx + cosLon * dy;
    const north = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
    const up = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;

    return [east, north, up];
}

export function latLonHeightToEcef(lat, lon, height = 0) {
    return toEcef(lat, lon, height);
}

export function enuDirectionToEcef(direction, lat, lon) {
    if (!Array.isArray(direction) || direction.length < 3) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const latRad = lat * (Math.PI / 180);
    const lonRad = lon * (Math.PI / 180);
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);

    const eastAxis = [-sinLon, cosLon, 0];
    const northAxis = [-sinLat * cosLon, -sinLat * sinLon, cosLat];
    const upAxis = [cosLat * cosLon, cosLat * sinLon, sinLat];

    return normalizeVec3([
        direction[0] * eastAxis[0] + direction[1] * northAxis[0] + direction[2] * upAxis[0],
        direction[0] * eastAxis[1] + direction[1] * northAxis[1] + direction[2] * upAxis[1],
        direction[0] * eastAxis[2] + direction[1] * northAxis[2] + direction[2] * upAxis[2]
    ]);
}

function ecefToLatLonHeight(point) {
    if (!Array.isArray(point) || point.length < 3 || point.some((value) => !Number.isFinite(value))) {
        return null;
    }

    const [x, y, z] = point;
    const a = 6378137.0;
    const f = 1 / 298.257223563;
    const e2 = f * (2 - f);
    const b = a * Math.sqrt(1 - e2);
    const ep2 = (a * a - b * b) / (b * b);
    const p = Math.sqrt(x * x + y * y);
    const theta = Math.atan2(a * z, b * p);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const lon = Math.atan2(y, x);
    const lat = Math.atan2(
        z + ep2 * b * sinTheta * sinTheta * sinTheta,
        p - e2 * a * cosTheta * cosTheta * cosTheta
    );
    const sinLat = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const height = p / Math.cos(lat) - N;

    return {
        lat: lat * (180 / Math.PI),
        lon: lon * (180 / Math.PI),
        height
    };
}

function toEcef(lat, lon, height) {
    const a = 6378137.0;
    const f = 1 / 298.257223563;
    const e2 = f * (2 - f);

    const latRad = lat * (Math.PI / 180);
    const lonRad = lon * (Math.PI / 180);

    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);

    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);

    const x = (N + height) * cosLat * cosLon;
    const y = (N + height) * cosLat * sinLon;
    const z = (N * (1 - e2) + height) * sinLat;

    return [x, y, z];
}

function projectLatLonToLocalPoint(point, referenceCenter) {
    const avgLatRad = referenceCenter.lat * (Math.PI / 180);
    return {
        lat: point.lat,
        lon: point.lon,
        x: (point.lon - referenceCenter.lon) * 111320 * Math.cos(avgLatRad),
        y: (point.lat - referenceCenter.lat) * 111320
    };
}


function pickNearbyTilesetEntries(lat, lon, tilesetIndex, options = {}) {
    const maxTiles = Number.isFinite(options.maxTiles) ? options.maxTiles : 9;
    const entries = Array.isArray(tilesetIndex) ? tilesetIndex : [];

    return entries
        .map((entry) => ({
            ...entry,
            distanceMeters: distanceMetersToRegion(lat, lon, entry.region)
        }))
        .sort((a, b) => a.distanceMeters - b.distanceMeters)
        .slice(0, maxTiles);
}


function distanceMetersBetweenLatLon(latA, lonA, latB, lonB) {
    const avgLatRad = ((latA + latB) / 2) * (Math.PI / 180);
    const dx = (lonB - lonA) * 111320 * Math.cos(avgLatRad);
    const dy = (latB - latA) * 111320;
    return Math.hypot(dx, dy);
}

function distanceMetersToRegion(lat, lon, region) {
    if (!Array.isArray(region) || region.length < 4) {
        return Number.POSITIVE_INFINITY;
    }

    const west = region[0] * (180 / Math.PI);
    const south = region[1] * (180 / Math.PI);
    const east = region[2] * (180 / Math.PI);
    const north = region[3] * (180 / Math.PI);

    const clampedLat = clamp(lat, south, north);
    const clampedLon = clamp(lon, west, east);

    return distanceMetersBetweenLatLon(lat, lon, clampedLat, clampedLon);
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

function getFeatureRtcCenter(featureTable) {
    const featureRtc = featureTable?.RTC_CENTER;
    if (Array.isArray(featureRtc) && featureRtc.length >= 3 && featureRtc.every(Number.isFinite)) {
        return featureRtc.slice(0, 3);
    }

    return null;
}

function getGltfRtcCenter(gltf) {
    const gltfRtc = gltf?.json?.extensions?.CESIUM_RTC?.center;
    if (Array.isArray(gltfRtc) && gltfRtc.length >= 3 && gltfRtc.every(Number.isFinite)) {
        return gltfRtc.slice(0, 3);
    }

    return null;
}

function buildModelMatrix(rtcTransforms, tilesetTransform) {
    let modelMatrix = isMatrix4(tilesetTransform) ? tilesetTransform : IDENTITY_MATRIX_4;

    const featureRtcCenter = rtcTransforms?.featureRtcCenter;
    if (Array.isArray(featureRtcCenter)) {
        modelMatrix = multiplyMat4(
            modelMatrix,
            makeTranslationMatrix(featureRtcCenter[0], featureRtcCenter[1], featureRtcCenter[2])
        );
    }

    const gltfRtcCenter = rtcTransforms?.gltfRtcCenter;
    if (Array.isArray(gltfRtcCenter)) {
        modelMatrix = multiplyMat4(
            modelMatrix,
            makeTranslationMatrix(gltfRtcCenter[0], gltfRtcCenter[1], gltfRtcCenter[2])
        );
    }

    return multiplyMat4(modelMatrix, B3DM_Y_UP_TO_Z_UP_MATRIX);
}

function getSceneRootNodes(json) {
    const sceneIndex = Number.isInteger(json?.scene) ? json.scene : 0;
    const sceneNodes = json?.scenes?.[sceneIndex]?.nodes;

    if (Array.isArray(sceneNodes) && sceneNodes.length > 0) {
        return sceneNodes;
    }

    return Array.isArray(json?.nodes) ? json.nodes.map((_node, index) => index) : [];
}

function getNodeLocalMatrix(node) {
    if (isMatrix4(node?.matrix)) {
        return node.matrix;
    }

    const translation = Array.isArray(node?.translation) ? node.translation : [0, 0, 0];
    const rotation = Array.isArray(node?.rotation) ? node.rotation : [0, 0, 0, 1];
    const scale = Array.isArray(node?.scale) ? node.scale : [1, 1, 1];

    return composeTrsMatrix(translation, rotation, scale);
}

function composeTrsMatrix(translation, rotation, scale) {
    const [x, y, z, w] = rotation;
    const [sx, sy, sz] = scale;

    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;

    return [
        (1 - (yy + zz)) * sx,
        (xy + wz) * sx,
        (xz - wy) * sx,
        0,
        (xy - wz) * sy,
        (1 - (xx + zz)) * sy,
        (yz + wx) * sy,
        0,
        (xz + wy) * sz,
        (yz - wx) * sz,
        (1 - (xx + yy)) * sz,
        0,
        translation[0],
        translation[1],
        translation[2],
        1
    ];
}

function buildConvexHull2d(points) {
    if (!Array.isArray(points) || points.length < 3) {
        return Array.isArray(points) ? points.slice() : [];
    }

    const sortedPoints = [...points].sort((a, b) => {
        if (a.x !== b.x) return a.x - b.x;
        if (a.y !== b.y) return a.y - b.y;
        if (a.lat !== b.lat) return a.lat - b.lat;
        return a.lon - b.lon;
    });

    const lower = [];
    for (const point of sortedPoints) {
        while (lower.length >= 2 && cross2d(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
            lower.pop();
        }
        lower.push(point);
    }

    const upper = [];
    for (let index = sortedPoints.length - 1; index >= 0; index -= 1) {
        const point = sortedPoints[index];
        while (upper.length >= 2 && cross2d(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
            upper.pop();
        }
        upper.push(point);
    }

    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

function multiplyMat4(a, b) {
    const result = new Array(16).fill(0);

    for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 4; row += 1) {
            let sum = 0;

            for (let i = 0; i < 4; i += 1) {
                sum += a[i * 4 + row] * b[column * 4 + i];
            }

            result[column * 4 + row] = sum;
        }
    }

    return result;
}

function cross2d(origin, pointA, pointB) {
    return (pointA.x - origin.x) * (pointB.y - origin.y) - (pointA.y - origin.y) * (pointB.x - origin.x);
}

function computePolygonArea2d(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += points[j].x * points[i].y - points[i].x * points[j].y;
    }
    return area / 2;
}

function transformPointGltfMat4(matrix, point) {
    const [x, y, z] = point;

    // glTF and 3D Tiles use column-major matrices with column vectors.
    return [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
    ];
}

function makeTranslationMatrix(x, y, z) {
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        x, y, z, 1
    ];
}

function isMatrix4(value) {
    return Array.isArray(value) && value.length === 16 && value.every(Number.isFinite);
}

function isIdentityMatrix4(matrix) {
    return matrix.every((value, index) => value === IDENTITY_MATRIX_4[index]);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
