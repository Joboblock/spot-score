const SCORE_MIN = 0.1;
const SCORE_MAX = 10;
export const TEMP_OPTIMAL_C = 25;
const TEMP_TOLERANCE_C = 12;
const TEMP_SCORE_AT_CITY_AVERAGE = 5;
const HUMIDITY_OPTIMAL_PERCENT = 45;
const HUMIDITY_TOLERANCE_PERCENT = 35;
const WIND_TARGET_MAX_KMH = 30;
const WIND_TOLERANCE_KMH = 30;
const RAIN_WORST_MM = 20;
const NOISE_GOOD_DB = 55;
const NOISE_WORST_DB = 80;

export function buildSpotScores(noiseInfo, weatherCombined, cityTemperatureStats) {
	const temperature = scoreTemperature(weatherCombined?.temperature, cityTemperatureStats);
	const humidity = scoreHumidity(weatherCombined?.humidity);

	const scores = {
		noise: scoreNoise(noiseInfo?.klasse),
		temperature,
		humidity,
		wind: scoreWind(weatherCombined?.windStrength, weatherCombined?.temperature),
		rain: scoreRain(weatherCombined?.rain24h)
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
	return scoreLowerIsBetter(noiseDb, NOISE_GOOD_DB, NOISE_WORST_DB);
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

function scoreHumidity(humidity) {
	if (!Number.isFinite(humidity)) return null;
	return scoreByDeviation(humidity, HUMIDITY_OPTIMAL_PERCENT, HUMIDITY_TOLERANCE_PERCENT);
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
