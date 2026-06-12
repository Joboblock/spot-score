const SCORE_MIN = 0.0;
const SCORE_MAX = 10;
export const TEMP_OPTIMAL_C = 25;
const TEMP_TOLERANCE_C = 12;
const TEMP_SCORE_AT_CITY_AVERAGE = 5;
const HUMIDITY_TOLERANCE_PERCENT = 35;
const WIND_TARGET_MAX_KMH = 30;
const WIND_TOLERANCE_KMH = 30;
const RAIN_WORST_MM = 20;
const AIR_QUALITY_PM25_BEST = 1;
const AIR_QUALITY_PM25_WORST = 15;
const AIR_QUALITY_PM10_BEST = 3;
const AIR_QUALITY_PM10_WORST = 45;
const NOISE_BUCKETS = [
	{ min: 55, max: 60, score: 10 },
	{ min: 60, max: 65, score: 7.5 },
	{ min: 65, max: 70, score: 5 },
	{ min: 70, max: 75, score: 2.5 },
	{ min: 75, max: Infinity, score: 0.0 }
];

export function buildSpotScores(noiseInfo, weatherCombined, cityTemperatureStats, airQualityInfo, sunScore = null) {
	const temperature = scoreTemperature(weatherCombined?.temperature, cityTemperatureStats);
	const humidity = scoreHumidity(weatherCombined?.humidity, weatherCombined?.temperature);

	const scores = {
		noise: scoreNoise(noiseInfo?.klasse),
		airQuality: scoreAirQuality(airQualityInfo?.pm25, airQualityInfo?.pm10),
		temperature,
		humidity,
		wind: scoreWind(weatherCombined?.windStrength, weatherCombined?.temperature),
		rain: scoreRain(weatherCombined?.rain24h),
		sun: Number.isFinite(sunScore) ? roundToOneDecimal(clamp(sunScore, SCORE_MIN, SCORE_MAX)) : null
	};

	const numericScores = Object.values(scores).filter(Number.isFinite);
	const general = numericScores.length
		? roundToOneDecimal(
			  numericScores.reduce((sum, score) => sum + score, 0) / numericScores.length
		  )
		: null;

	return {
		...scores,
		general
	};
}

function scoreNoise(klasseLabel) {
	const noiseDb = parseNoiseDbEstimate(klasseLabel);
	if (!Number.isFinite(noiseDb)) return null;

	const bucket = NOISE_BUCKETS.find((range) => noiseDb >= range.min && noiseDb < range.max);
	return bucket ? bucket.score : null;
}

function scoreTemperature(temperature, cityTemperatureStats) {
	if (!Number.isFinite(temperature)) return null;

	const tempDifference = cityTemperatureStats?.tempDifference;
	if (!Number.isFinite(tempDifference)) return null;

	return scoreTemperatureWithAverage(temperature, TEMP_OPTIMAL_C, tempDifference);
}

function scoreTemperatureWithAverage(temperature, optimalTemperature, tempDifference) {
	if (!Number.isFinite(temperature) || !Number.isFinite(optimalTemperature) || tempDifference < 0) {
		return null;
	}

	const deviation = Math.abs(temperature - optimalTemperature);

	if (tempDifference === 0) {
		return roundToOneDecimal(deviation === 0 ? SCORE_MAX : SCORE_MIN);
	}

	const maxDeviation = tempDifference * 2;

	if (deviation <= tempDifference) {
		return roundToOneDecimal(
			interpolateLinear(deviation, 0, tempDifference, SCORE_MAX, TEMP_SCORE_AT_CITY_AVERAGE)
		);
	}

	if (deviation <= maxDeviation) {
		return roundToOneDecimal(
			interpolateLinear(
				deviation,
				tempDifference,
				maxDeviation,
				TEMP_SCORE_AT_CITY_AVERAGE,
				SCORE_MIN
			)
		);
	}

	return SCORE_MIN;
}

function scoreHumidity(humidity, temperature) {
	if (!Number.isFinite(humidity) || !Number.isFinite(temperature)) return null;
	const optimalHumidity = getOptimalHumidityForTemperature(temperature);
	return scoreByDeviation(humidity, optimalHumidity, HUMIDITY_TOLERANCE_PERCENT);
}

function getOptimalHumidityForTemperature(temperature) {
	const targetHumidity = 60 - 0.8 * (temperature - 20);
	return clamp(targetHumidity, 30, 75);
}

function scoreWind(windStrength, temperature) {
	if (!Number.isFinite(windStrength) || !Number.isFinite(temperature)) return null;

	const targetWind = getTargetWindForTemperature(temperature);
	return scoreByDeviation(windStrength, targetWind, WIND_TOLERANCE_KMH);
}

function scoreRain(rain24h) {
	if (!Number.isFinite(rain24h)) return null;
	return scoreLowerIsBetter(rain24h, 0, RAIN_WORST_MM);
}

function scoreAirQuality(pm25, pm10) {
	const hasPm25 = Number.isFinite(pm25);
	const hasPm10 = Number.isFinite(pm10);

	if (hasPm25 && hasPm10) {
		const s25 = scoreAirQualityLinear(pm25, AIR_QUALITY_PM25_BEST, AIR_QUALITY_PM25_WORST);
		const s10 = scoreAirQualityLinear(pm10, AIR_QUALITY_PM10_BEST, AIR_QUALITY_PM10_WORST);
		if (Number.isFinite(s25) && Number.isFinite(s10)) {
			return Math.min(s25, s10);
		}
		return Number.isFinite(s25) ? s25 : Number.isFinite(s10) ? s10 : null;
	}

	if (hasPm25) return scoreAirQualityLinear(pm25, AIR_QUALITY_PM25_BEST, AIR_QUALITY_PM25_WORST);
	if (hasPm10) return scoreAirQualityLinear(pm10, AIR_QUALITY_PM10_BEST, AIR_QUALITY_PM10_WORST);

	return null;
}

function scoreAirQualityLinear(value, bestThreshold, worstThreshold) {
	if (!Number.isFinite(value)) return null;
	return scoreLowerIsBetter(value, bestThreshold, worstThreshold);
}

function getTargetWindForTemperature(temperature) {
	const hotterDelta = Math.max(0, temperature - TEMP_OPTIMAL_C);
	const heatRatio = clamp(hotterDelta / TEMP_TOLERANCE_C, 0, 1);
	return heatRatio * WIND_TARGET_MAX_KMH;
}

function scoreByDeviation(value, optimalValue, tolerance) {
	if (!Number.isFinite(value) || !Number.isFinite(optimalValue) || tolerance <= 0) return null;

	const deviationRatio = clamp(Math.abs(value - optimalValue) / tolerance, 0, 1);
	const score = SCORE_MAX - deviationRatio * (SCORE_MAX - SCORE_MIN);
	return roundToOneDecimal(score);
}

function scoreLowerIsBetter(value, idealMin, worstMax) {
	if (!Number.isFinite(value) || !Number.isFinite(idealMin) || !Number.isFinite(worstMax) || worstMax <= idealMin) {
		return null;
	}

	const normalized = clamp((value - idealMin) / (worstMax - idealMin), 0, 1);
	const score = SCORE_MAX - normalized * (SCORE_MAX - SCORE_MIN);
	return roundToOneDecimal(score);
}

function parseNoiseDbEstimate(klasseLabel) {
	if (typeof klasseLabel !== "string") return null;

	const rangeMatch = klasseLabel.match(/(\d+)\s*-\s*(\d+)/);
	if (rangeMatch) {
		const lower = Number(rangeMatch[1]);
		const upper = Number(rangeMatch[2]);
		if (Number.isFinite(lower) && Number.isFinite(upper)) {
			return (lower + upper) / 2;
		}
	}

	const atLeastMatch = klasseLabel.match(/>=\s*(\d+)/);
	if (atLeastMatch) return Number(atLeastMatch[1]);

	return null;
}

function roundToOneDecimal(value) {
	return Math.round(value * 10) / 10;
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function interpolateLinear(value, inputMin, inputMax, outputMin, outputMax) {
	if (!Number.isFinite(value) || !Number.isFinite(inputMin) || !Number.isFinite(inputMax)) {
		return outputMin;
	}

	if (inputMax === inputMin) {
		return outputMax;
	}

	const t = clamp((value - inputMin) / (inputMax - inputMin), 0, 1);
	return outputMin + t * (outputMax - outputMin);
}
