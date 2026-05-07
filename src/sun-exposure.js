const RAD = Math.PI / 180;

export function computeSunExposure(lat, lon, now = new Date(), options = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return {
            isSunUp: null,
            altitudeDeg: null,
            azimuthDeg: null,
            minutesUntilChange: null,
            nextChangeTime: null,
            changeType: null,
            lookAheadHours: options.lookAheadHours ?? 12
        };
    }

    const lookAheadHours = Number.isFinite(options.lookAheadHours) ? options.lookAheadHours : 12;
    const stepMinutes = Number.isFinite(options.stepMinutes) ? options.stepMinutes : 5;
    const maxMinutes = Math.max(0, lookAheadHours * 60);

    const position = getSolarPosition(lat, lon, now);
    const altitudeDeg = position.altitudeDeg;
    const azimuthDeg = position.azimuthDeg;
    const isSunUp = Number.isFinite(altitudeDeg) ? altitudeDeg > 0 : null;

    let nextChangeTime = null;
    let minutesUntilChange = null;
    let changeType = null;

    if (isSunUp !== null && maxMinutes > 0) {
        let previousTime = now;
        let previousSunUp = isSunUp;

        for (let elapsed = stepMinutes; elapsed <= maxMinutes; elapsed += stepMinutes) {
            const candidateTime = new Date(now.getTime() + elapsed * 60 * 1000);
            const candidateUp = getSolarPosition(lat, lon, candidateTime).altitudeDeg > 0;

            if (candidateUp !== previousSunUp) {
                nextChangeTime = refineTransitionTime(lat, lon, previousTime, candidateTime, previousSunUp);
                minutesUntilChange = (nextChangeTime.getTime() - now.getTime()) / 60000;
                changeType = previousSunUp ? "sunset" : "sunrise";
                break;
            }

            previousTime = candidateTime;
            previousSunUp = candidateUp;
        }

        if (!nextChangeTime) {
            minutesUntilChange = maxMinutes;
        }
    }

    return {
        isSunUp,
        altitudeDeg,
        azimuthDeg,
        minutesUntilChange,
        nextChangeTime,
        changeType,
        lookAheadHours
    };
}

export function computeSunDirection(lat, lon, date = new Date()) {
    const position = getSolarPosition(lat, lon, date);
    if (!Number.isFinite(position.altitudeDeg) || !Number.isFinite(position.azimuthDeg)) {
        return null;
    }

    const altitudeRad = position.altitudeDeg * RAD;
    const azimuthRad = position.azimuthDeg * RAD;

    const cosAltitude = Math.cos(altitudeRad);
    const east = Math.sin(azimuthRad) * cosAltitude;
    const north = Math.cos(azimuthRad) * cosAltitude;
    const up = Math.sin(altitudeRad);

    return normalizeVec3([east, north, up]);
}

function refineTransitionTime(lat, lon, startTime, endTime, startSunUp) {
    let start = startTime;
    let end = endTime;

    for (let i = 0; i < 10; i += 1) {
        const midTime = new Date((start.getTime() + end.getTime()) / 2);
    const midSunUp = getSolarPosition(lat, lon, midTime).altitudeDeg > 0;

        if (midSunUp === startSunUp) {
            start = midTime;
        } else {
            end = midTime;
        }
    }

    return end;
}

function getSolarPosition(lat, lon, date) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(date instanceof Date)) {
        return { altitudeDeg: NaN, azimuthDeg: NaN };
    }

    const utc = new Date(date.getTime());
    const dayOfYear = getDayOfYearUTC(utc);
    const hours = utc.getUTCHours();
    const minutes = utc.getUTCMinutes();
    const seconds = utc.getUTCSeconds();
    const fractionalHour = hours + minutes / 60 + seconds / 3600;

    const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (fractionalHour - 12) / 24);
    const eqTime = 229.18 * (
        0.000075 +
        0.001868 * Math.cos(gamma) -
        0.032077 * Math.sin(gamma) -
        0.014615 * Math.cos(2 * gamma) -
        0.040849 * Math.sin(2 * gamma)
    );

    const decl =
        0.006918 -
        0.399912 * Math.cos(gamma) +
        0.070257 * Math.sin(gamma) -
        0.006758 * Math.cos(2 * gamma) +
        0.000907 * Math.sin(2 * gamma) -
        0.002697 * Math.cos(3 * gamma) +
        0.00148 * Math.sin(3 * gamma);

    const timeOffset = eqTime + 4 * lon;
    const trueSolarMinutes = (fractionalHour * 60 + timeOffset + 1440) % 1440;
    let hourAngle = trueSolarMinutes / 4 - 180;
    if (hourAngle < -180) hourAngle += 360;

    const hourAngleRad = hourAngle * RAD;
    const latRad = lat * RAD;

    const cosZenith =
        Math.sin(latRad) * Math.sin(decl) +
        Math.cos(latRad) * Math.cos(decl) * Math.cos(hourAngleRad);

    const zenith = Math.acos(Math.min(Math.max(cosZenith, -1), 1));
    const altitude = 90 - (zenith / RAD);

    const azimuth = Math.atan2(
        Math.sin(hourAngleRad),
        Math.cos(hourAngleRad) * Math.sin(latRad) - Math.tan(decl) * Math.cos(latRad)
    );
    const azimuthDeg = (azimuth / RAD + 180) % 360;

    return { altitudeDeg: altitude, azimuthDeg };
}

function getDayOfYearUTC(date) {
    const yearStart = Date.UTC(date.getUTCFullYear(), 0, 0);
    const diff = date.getTime() - yearStart;
    return Math.floor(diff / 86400000);
}

function normalizeVec3(vec) {
    if (!Array.isArray(vec) || vec.length < 3) return null;
    const length = Math.sqrt(vec[0] ** 2 + vec[1] ** 2 + vec[2] ** 2);
    if (!Number.isFinite(length) || length === 0) return null;
    return [vec[0] / length, vec[1] / length, vec[2] / length];
}
