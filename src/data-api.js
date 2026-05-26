import { ACCESS_TOKEN } from "./api-key.js";
import { TEMP_OPTIMAL_C } from "./utils.js";

const WEATHER_BASE_URL = "https://api.netatmo.com/api/getpublicdata";
const OPEN_METEO_BASE_URL = "https://api.open-meteo.com/v1/forecast";
const NOISE_BASE_URL = "https://api.hamburg.de/datasets/v1/strassenverkehr";
const SENSOR_COMMUNITY_BASE_URL = "https://data.sensor.community/airrohr/v1/filter/box=";
const ADDRESS_SEARCH_URL = "https://api.hamburg.de/addr_search";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";

const LDEN_COLLECTION = "strassenverkehr_tag_abend_nacht_2022";
const NETATMO_NEAREST_COUNT = 3;
const NETATMO_RADIUS_KM = 1;
const SENSOR_COMMUNITY_RADIUS_KM = 2;
const NOISE_RADIUS_KM = 1;
const NOISE_PAGE_LIMIT = 1000;
const NOISE_MAX_PAGE_COUNT = 25;
const NETATMO_NEAREST_DISTANCE_FACTOR = 1.5;
const DISTANCE_WEIGHT_MIN_KM = 0.05;
const WEATHER_METRICS = ["temperature", "humidity", "windStrength", "rain24h"];
const CITY_AVERAGE_SAMPLE_POINT_COUNT = 5;

let cachedNoiseFeatures = null;
let cachedNoisePromise = null;

export async function fetchNoiseMapData(options = {}) {
    const { bbox, limit = NOISE_PAGE_LIMIT, offset = 0 } = options;
    const params = new URLSearchParams({
        f: "json",
        limit: String(limit),
        offset: String(offset)
    });

    if (bbox) {
        params.set("bbox", bbox);
    }

    const response = await fetch(
        `${NOISE_BASE_URL}/collections/${LDEN_COLLECTION}/items?${params.toString()}`
    );

    if (!response.ok) {
        throw new Error(`Could not load Hamburg noise data (HTTP ${response.status}).`);
    }

    return response.json();
}

export async function fetchWeatherStationsWithinRadius(lat, lon, radiusKm = NETATMO_RADIUS_KM) {
    if (!ACCESS_TOKEN) {
        throw new Error("Missing Netatmo access token in src/api-key.js.");
    }

    const bbox = getBoundingBoxForRadius(lat, lon, radiusKm);

    const params = new URLSearchParams({
        lat_ne: String(bbox.latNe),
        lon_ne: String(bbox.lonNe),
        lat_sw: String(bbox.latSw),
        lon_sw: String(bbox.lonSw),
        access_token: decodeURIComponent(ACCESS_TOKEN),
        required_data: "temperature",
        filter: "false"
    });

    const response = await fetch(`${WEATHER_BASE_URL}?${params.toString()}`);

    if (!response.ok) {
        throw new Error(`Could not load Netatmo data (HTTP ${response.status}).`);
    }

    const data = await response.json();
    return extractPublicWeatherStations(data?.body ?? [])
        .map((station) => ({
            ...station,
            distanceKm: haversineDistanceKm(lat, lon, station.lat, station.lon)
        }))
        .filter((station) => station.distanceKm <= radiusKm);
}

export async function fetchPointSelectionData(lat, lon, hamburgBounds) {
    const [noiseInfo, weatherSelection, cityTemperatureStats, airQualityInfo] = await Promise.all([
        fetchNoiseInfoForPoint(lat, lon, hamburgBounds),
        buildWeatherSelectionForPoint(lat, lon),
        fetchAverageCityTemperature(hamburgBounds).catch(() => null),
        fetchAirQualityForPoint(lat, lon).catch(() => null)
    ]);

    return {
        noiseInfo,
        weatherSelection,
        cityTemperatureStats,
        airQualityInfo
    };
}

export async function preloadNoiseData(hamburgBounds) {
    await fetchCachedHamburgNoise(hamburgBounds);
}

export async function fetchAddressSuggestions(query, options = {}) {
    const { limit = 5, signal } = options;
    const response = await fetch(ADDRESS_SEARCH_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            id: "addr_search",
            params: {
                query_str: query,
                size: limit
            }
        }),
        signal
    });

    if (!response.ok) {
        throw new Error(`Address search failed (HTTP ${response.status}).`);
    }

    const data = await response.json();
    const hits = data?.hits?.hits ?? [];

    return hits
        .map((hit) => {
            const source = hit?._source ?? {};
            const coords = source?.geometry?.coordinates ?? [];
            const [lon, lat] = coords;
            const properties = source?.properties ?? {};
            const label = properties.searchfield ?? "";
            const typeLabel = properties.type ?? source.type ?? "Address";

            if (!label || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

            return {
                id: source?.id ?? hit?._id ?? label,
                label,
                typeLabel,
                lat,
                lon
            };
        })
        .filter(Boolean)
        .slice(0, limit);
}

export async function fetchAddressLabelForCoordinates(lat, lon) {
    try {
        const params = new URLSearchParams({
            format: "jsonv2",
            lat: String(lat),
            lon: String(lon),
            zoom: "18",
            addressdetails: "1"
        });
        const response = await fetch(`${NOMINATIM_REVERSE_URL}?${params.toString()}`);
        if (!response.ok) return null;
        const data = await response.json();
        const address = data?.address ?? {};
        const line1 = [address.road, address.house_number].filter(Boolean).join(" ");
        const displayName = data?.display_name ?? "";
        const fallback = displayName.split(",")[0]?.trim();
        return line1 || fallback || null;
    } catch (error) {
        return null;
    }
}

async function fetchNoiseInfoForPoint(lat, lon, hamburgBounds) {
    const features = await fetchCachedHamburgNoise(hamburgBounds);
    if (features.length === 0) {
        return { klasse: "55-60", distanceKm: null };
    }

    const searchBbox = getBoundingBoxForRadius(lat, lon, NOISE_RADIUS_KM);
    const candidateFeatures = features.filter((feature) =>
        isGeometryIntersectingBbox(feature?.geometry, searchBbox)
    );

    if (candidateFeatures.length === 0) {
        return { klasse: "55-60", distanceKm: null };
    }

    const point = { lat, lon };
    const containingFeature = candidateFeatures.find((feature) =>
        isPointInsideGeometry(point, feature?.geometry)
    );

    if (containingFeature) {
        return {
            klasse: containingFeature?.properties?.klasse ?? null,
            distanceKm: 0
        };
    }

    const nearest = candidateFeatures
        .map((feature) => {
            const center = geometryCenter(feature?.geometry);
            if (!center) return null;
            return {
                klasse: feature?.properties?.klasse ?? null,
                distanceKm: haversineDistanceKm(lat, lon, center.lat, center.lon)
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.distanceKm - b.distanceKm)[0];

    if (!nearest) return { klasse: "55-60", distanceKm: null };
    if (nearest.distanceKm > NOISE_RADIUS_KM) {
        return { klasse: "55-60", distanceKm: nearest.distanceKm };
    }

    return nearest;
}

async function fetchCachedHamburgNoise(hamburgBounds) {
    if (cachedNoiseFeatures) return cachedNoiseFeatures;

    if (!cachedNoisePromise) {
        cachedNoisePromise = loadHamburgNoiseFeatures(hamburgBounds)
            .then((features) => {
                cachedNoiseFeatures = features;
                return features;
            })
            .catch((error) => {
                cachedNoisePromise = null;
                throw error;
            });
    }

    return cachedNoisePromise;
}

async function loadHamburgNoiseFeatures(hamburgBounds) {
    if (!Array.isArray(hamburgBounds) || hamburgBounds.length < 2) {
        throw new Error("Hamburg bounds are required to load cached noise features.");
    }

    const [southWest, northEast] = hamburgBounds;
    const bbox = `${southWest[1]},${southWest[0]},${northEast[1]},${northEast[0]}`;
    const allFeatures = [];

    for (let page = 0; page < NOISE_MAX_PAGE_COUNT; page += 1) {
        const offset = page * NOISE_PAGE_LIMIT;
        const data = await fetchNoiseMapData({ bbox, limit: NOISE_PAGE_LIMIT, offset });
        const features = data?.features ?? [];
        allFeatures.push(...features);

        if (features.length < NOISE_PAGE_LIMIT) {
            break;
        }
    }

    return allFeatures;
}

async function buildWeatherSelectionForPoint(lat, lon) {
    const stations = await fetchWeatherStationsWithinRadius(lat, lon, NETATMO_RADIUS_KM);

    if (stations.length === 0) {
        return {
            usedStations: [],
            totalStationsUsed: 0,
            metricStationCounts: {
                temperature: 0,
                humidity: 0,
                windStrength: 0,
                rain24h: 0
            },
            combined: {
                temperature: null,
                windStrength: null,
                rain24h: null,
                humidity: null
            }
        };
    }

    const sortedByDistance = [...stations].sort((a, b) => a.distanceKm - b.distanceKm);
    const stationsByMetric = {
        temperature: selectStationsForMetric(sortedByDistance, "temperature"),
        humidity: selectStationsForMetric(sortedByDistance, "humidity"),
        windStrength: selectStationsForMetric(sortedByDistance, "windStrength"),
        rain24h: selectStationsForMetric(sortedByDistance, "rain24h")
    };

    const allUsedStations = WEATHER_METRICS.flatMap((metric) => stationsByMetric[metric]);
    const uniqueStationsById = new Map(allUsedStations.map((station) => [station.id, station]));
    const usedStations = [...uniqueStationsById.values()].sort((a, b) => a.distanceKm - b.distanceKm);

    const metricStationCounts = {
        temperature: stationsByMetric.temperature.length,
        humidity: stationsByMetric.humidity.length,
        windStrength: stationsByMetric.windStrength.length,
        rain24h: stationsByMetric.rain24h.length
    };

    return {
        usedStations: usedStations.slice(0, NETATMO_NEAREST_COUNT),
        totalStationsUsed: usedStations.length,
        metricStationCounts,
        combined: {
            temperature: computeWeightedMetric(stationsByMetric.temperature, "temperature"),
            humidity: computeWeightedMetric(stationsByMetric.humidity, "humidity"),
            windStrength: computeWeightedMetric(stationsByMetric.windStrength, "windStrength"),
            rain24h: computeWeightedMetric(stationsByMetric.rain24h, "rain24h")
        }
    };
}

async function fetchAverageCityTemperature(hamburgBounds) {
    const samplePoints = getHamburgTemperatureSamplePoints(hamburgBounds);
    const temperatureSamples = await Promise.all(
        samplePoints.map((point) => fetchCurrentTemperatureAtPoint(point.lat, point.lon).catch(() => null))
    );

    const numericSamples = temperatureSamples.filter(Number.isFinite);
    if (numericSamples.length === 0) {
        throw new Error("Open-Meteo did not return current temperatures for Hamburg sample points.");
    }

    const averageCityTemperature =
        numericSamples.reduce((sum, value) => sum + value, 0) / numericSamples.length;
    const tempDifference = Math.abs(TEMP_OPTIMAL_C - averageCityTemperature);

    return {
        averageCityTemperature,
        tempDifference,
        samplePointsUsed: numericSamples.length,
        samplePointsTotal: samplePoints.length
    };
}

async function fetchAirQualityForPoint(lat, lon) {
    const bbox = getBoundingBoxForRadius(lat, lon, SENSOR_COMMUNITY_RADIUS_KM);
    const boxParam = `${bbox.latNe},${bbox.lonSw},${bbox.latSw},${bbox.lonNe}`;
    const response = await fetch(`${SENSOR_COMMUNITY_BASE_URL}${boxParam}`);

    if (!response.ok) {
        throw new Error(`Could not load Sensor.Community data (HTTP ${response.status}).`);
    }

    const data = await response.json();
    const rawEntries = Array.isArray(data) ? data : [];
    const readings = rawEntries
        .map((entry) => extractSensorCommunityReading(entry))
        .filter(Boolean)
        .map((reading) => ({
            ...reading,
            distanceKm: haversineDistanceKm(lat, lon, reading.lat, reading.lon)
        }));

    if (readings.length === 0) {
        return { pm10: null, pm25: null, usedSensors: 0, nearestDistanceKm: null };
    }

    const nearbyReadings = readings.filter((reading) => reading.distanceKm <= SENSOR_COMMUNITY_RADIUS_KM);
    const candidates = nearbyReadings.length ? nearbyReadings : readings;

    const weightedPm10 = computeWeightedValue(candidates, "pm10");
    const weightedPm25 = computeWeightedValue(candidates, "pm25");
    const nearestDistanceKm = candidates.reduce(
        (min, reading) => Math.min(min, reading.distanceKm),
        Infinity
    );

    return {
        pm10: weightedPm10,
        pm25: weightedPm25,
        usedSensors: candidates.length,
        nearestDistanceKm: Number.isFinite(nearestDistanceKm) ? nearestDistanceKm : null
    };
}

function getHamburgTemperatureSamplePoints(hamburgBounds) {
    const [southWest, northEast] = hamburgBounds;
    const latMin = southWest[0];
    const lonMin = southWest[1];
    const latMax = northEast[0];
    const lonMax = northEast[1];

    const centerLat = (latMin + latMax) / 2;
    const centerLon = (lonMin + lonMax) / 2;

    const points = [
        { lat: centerLat, lon: centerLon },
        { lat: latMin, lon: lonMin },
        { lat: latMin, lon: lonMax },
        { lat: latMax, lon: lonMin },
        { lat: latMax, lon: lonMax }
    ];

    return points.slice(0, CITY_AVERAGE_SAMPLE_POINT_COUNT);
}

async function fetchCurrentTemperatureAtPoint(lat, lon) {
    const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        current: "temperature_2m",
        timezone: "auto"
    });

    const response = await fetch(`${OPEN_METEO_BASE_URL}?${params.toString()}`);
    if (!response.ok) {
        throw new Error(`Could not load Open-Meteo current data (HTTP ${response.status}).`);
    }

    const data = await response.json();
    const currentTemperature = data?.current?.temperature_2m;

    if (!Number.isFinite(currentTemperature)) {
        throw new Error("Open-Meteo response did not include current temperature.");
    }

    return currentTemperature;
}

function selectStationsForMetric(sortedStations, metricName) {
    const metricStations = sortedStations.filter((station) => Number.isFinite(station?.[metricName]));
    if (metricStations.length === 0) return [];

    const nearestDistanceKm = metricStations[0].distanceKm;
    const maxAcceptedDistanceKm = nearestDistanceKm * NETATMO_NEAREST_DISTANCE_FACTOR;

    return metricStations.filter((station, index) => {
        if (index === 0) return true;
        return station.distanceKm <= maxAcceptedDistanceKm;
    });
}

function computeWeightedMetric(stations, metricName) {
    let weightedSum = 0;
    let totalWeight = 0;

    stations.forEach((station) => {
        const value = station?.[metricName];
        if (!Number.isFinite(value)) return;

        const distance = Math.max(station.distanceKm, DISTANCE_WEIGHT_MIN_KM);
        const weight = 1 / distance;
        weightedSum += value * weight;
        totalWeight += weight;
    });

    if (totalWeight === 0) return null;
    return weightedSum / totalWeight;
}

function computeWeightedValue(entries, metricName) {
    let weightedSum = 0;
    let totalWeight = 0;

    entries.forEach((entry) => {
        const value = entry?.[metricName];
        if (!Number.isFinite(value)) return;

        const distance = Math.max(entry.distanceKm, DISTANCE_WEIGHT_MIN_KM);
        const weight = 1 / distance;
        weightedSum += value * weight;
        totalWeight += weight;
    });

    if (totalWeight === 0) return null;
    return weightedSum / totalWeight;
}

function extractPublicWeatherStations(rawStations) {
    return rawStations
        .map((station) => {
            const location = station?.place?.location;
            if (!Array.isArray(location) || location.length < 2) return null;

            const [lon, lat] = location;
            const city = station?.place?.city ?? "Unknown city";

            const weather = extractStationWeather(station?.measures ?? {});
            if (!weather || !Number.isFinite(weather.temperature)) return null;

            return {
                id: station?._id ?? `${lon}-${lat}`,
                lat,
                lon,
                city,
                street: station?.place?.street ?? "Unknown street",
                ...weather
            };
        })
        .filter(Boolean);
}

function extractStationWeather(measures) {
    let temperature;
    let humidity;
    let pressure;
    let rain24h;
    let windStrength;
    let timestamp = 0;

    for (const value of Object.values(measures)) {
        const types = value?.type;
        const res = value?.res;

        if (Array.isArray(types) && res && typeof res === "object") {
            const [latestTs, latestValues] = Object.entries(res).sort((a, b) => Number(b[0]) - Number(a[0]))[0] ?? [];

            if (latestTs && Array.isArray(latestValues)) {
                timestamp = Math.max(timestamp, Number(latestTs));

                types.forEach((type, index) => {
                    const measureValue = latestValues[index];
                    if (type === "temperature" && Number.isFinite(measureValue)) temperature = measureValue;
                    if (type === "humidity" && Number.isFinite(measureValue)) humidity = measureValue;
                    if (type === "pressure" && Number.isFinite(measureValue)) pressure = measureValue;
                });
            }
        }

        if (Number.isFinite(value?.rain_24h)) rain24h = value.rain_24h;
        if (Number.isFinite(value?.wind_strength)) windStrength = value.wind_strength;

        if (Number.isFinite(value?.rain_timeutc)) {
            timestamp = Math.max(timestamp, value.rain_timeutc);
        }

        if (Number.isFinite(value?.wind_timeutc)) {
            timestamp = Math.max(timestamp, value.wind_timeutc);
        }
    }

    if (!Number.isFinite(temperature)) return null;

    return {
        temperature,
        humidity,
        pressure,
        rain24h,
        windStrength,
        timestamp
    };
}

function extractSensorCommunityReading(entry) {
    const location = entry?.location ?? {};
    const lat = Number(location?.latitude);
    const lon = Number(location?.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const values = Array.isArray(entry?.sensordatavalues) ? entry.sensordatavalues : [];
    let pm10;
    let pm25;

    values.forEach((value) => {
        const type = value?.value_type;
        const numericValue = Number(value?.value);
        if (!Number.isFinite(numericValue)) return;
        if (type === "P1") pm10 = numericValue;
        if (type === "P2") pm25 = numericValue;
    });

    if (!Number.isFinite(pm10) && !Number.isFinite(pm25)) return null;

    return {
        lat,
        lon,
        pm10: Number.isFinite(pm10) ? pm10 : null,
        pm25: Number.isFinite(pm25) ? pm25 : null,
        timestamp: entry?.timestamp ?? null
    };
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
    const earthRadiusKm = 6371;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
}

function toRadians(value) {
    return (value * Math.PI) / 180;
}

function getBoundingBoxForRadius(lat, lon, radiusKm) {
    const latDelta = radiusKm / 111;
    const safeCos = Math.max(Math.cos(toRadians(lat)), 0.01);
    const lonDelta = radiusKm / (111 * safeCos);

    return {
        latNe: lat + latDelta,
        lonNe: lon + lonDelta,
        latSw: lat - latDelta,
        lonSw: lon - lonDelta
    };
}

function geometryCenter(geometry) {
    const coords = geometry?.coordinates;
    if (!coords) return null;

    const points = flattenGeometryCoordinates(geometry);
    if (points.length === 0) return null;

    const sums = points.reduce(
        (acc, [lon, lat]) => {
            acc.lat += lat;
            acc.lon += lon;
            return acc;
        },
        { lat: 0, lon: 0 }
    );

    return {
        lat: sums.lat / points.length,
        lon: sums.lon / points.length
    };
}

function isGeometryIntersectingBbox(geometry, bbox) {
    if (!geometry || !bbox) return false;
    const points = flattenGeometryCoordinates(geometry);
    if (points.length === 0) return false;

    const bounds = points.reduce(
        (acc, [lon, lat]) => {
            acc.minLat = Math.min(acc.minLat, lat);
            acc.maxLat = Math.max(acc.maxLat, lat);
            acc.minLon = Math.min(acc.minLon, lon);
            acc.maxLon = Math.max(acc.maxLon, lon);
            return acc;
        },
        { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity }
    );

    if (!Number.isFinite(bounds.minLat) || !Number.isFinite(bounds.minLon)) return false;

    const bboxMinLat = bbox.latSw;
    const bboxMaxLat = bbox.latNe;
    const bboxMinLon = bbox.lonSw;
    const bboxMaxLon = bbox.lonNe;

    const latOverlap = bounds.minLat <= bboxMaxLat && bounds.maxLat >= bboxMinLat;
    const lonOverlap = bounds.minLon <= bboxMaxLon && bounds.maxLon >= bboxMinLon;
    return latOverlap && lonOverlap;
}

function flattenGeometryCoordinates(geometry) {
    if (!geometry) return [];
    if (geometry.type === "Point") return [geometry.coordinates];
    if (geometry.type === "Polygon") return geometry.coordinates.flat();
    if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(2);
    return [];
}

function isPointInsideGeometry(point, geometry) {
    if (!geometry) return false;
    if (geometry.type === "Polygon") {
        return isPointInsidePolygon(point, geometry.coordinates[0]);
    }

    if (geometry.type === "MultiPolygon") {
        return geometry.coordinates.some((polygon) => isPointInsidePolygon(point, polygon[0]));
    }

    return false;
}

function isPointInsidePolygon(point, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    const x = point.lon;
    const y = point.lat;
    let isInside = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];

        const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersects) isInside = !isInside;
    }

    return isInside;
}
