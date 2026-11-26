/**
 * US AQI helpers. Bands follow the US EPA Air Quality Index scale.
 * @see https://www.airnow.gov/aqi/aqi-basics/
 */

export const AQI_BANDS = Object.freeze([
  { max: 50, level: 'good', label: 'Good', color: '#2e7d32' },
  { max: 100, level: 'moderate', label: 'Moderate', color: '#b28704' },
  { max: 150, level: 'sensitive', label: 'Unhealthy for Sensitive Groups', color: '#e65100' },
  { max: 200, level: 'unhealthy', label: 'Unhealthy', color: '#c62828' },
  { max: 300, level: 'very-unhealthy', label: 'Very Unhealthy', color: '#6a1b9a' },
  { max: Infinity, level: 'hazardous', label: 'Hazardous', color: '#4e0d1f' },
]);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Map a US AQI value to its band.
 * @param {number} aqi
 * @returns {{max:number, level:string, label:string, color:string}}
 */
export function categorize(aqi) {
  if (!isNum(aqi) || aqi < 0) {
    return { max: NaN, level: 'unknown', label: 'Unknown', color: '#546e7a' };
  }
  return AQI_BANDS.find((band) => aqi <= band.max);
}

/** WHO 2021 24-hour PM2.5 guideline, in µg/m³. */
export const WHO_PM25_24H = 15;

/**
 * How many times above the WHO daily PM2.5 guideline a reading is.
 * @param {number} pm25
 * @returns {number|null}
 */
export function pm25Multiple(pm25) {
  if (!isNum(pm25) || pm25 < 0) return null;
  return Math.round((pm25 / WHO_PM25_24H) * 10) / 10;
}

/** EPA PM2.5 breakpoints (2024 revision): [concLow, concHigh, aqiLow, aqiHigh]. */
const PM25_BREAKPOINTS = [
  [0, 9.0, 0, 50],
  [9.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 125.4, 151, 200],
  [125.5, 225.4, 201, 300],
  [225.5, 325.4, 301, 500],
];

/**
 * Convert a PM2.5 concentration to US AQI with the EPA linear formula.
 * Used as a fallback when the upstream AQI value is missing.
 * @param {number} pm25 µg/m³
 * @returns {number|null}
 */
export function pm25ToUsAqi(pm25) {
  if (!isNum(pm25) || pm25 < 0) return null;
  const c = Math.floor(pm25 * 10) / 10; // EPA truncates to 0.1
  if (c > 325.4) return 500;
  const [cLo, cHi, iLo, iHi] = PM25_BREAKPOINTS.find(([, hi]) => c <= hi);
  return Math.round(((iHi - iLo) / (cHi - cLo)) * (c - cLo) + iLo);
}

export const POLLUTANT_NAMES = Object.freeze({
  pm2_5: 'PM2.5 (fine particles)',
  pm10: 'PM10 (dust and coarse particles)',
  nitrogen_dioxide: 'NO₂ (traffic exhaust)',
  ozone: 'Ozone (sunlight smog)',
  carbon_monoxide: 'CO (combustion)',
  sulphur_dioxide: 'SO₂ (coal and industry)',
});

/**
 * Pick the pollutant driving the overall AQI from per-pollutant sub-indices.
 * @param {Record<string, number|null|undefined>} subIndices e.g. { pm2_5: 180, ozone: 20 }
 * @returns {{key:string, name:string, aqi:number}|null}
 */
export function dominantPollutant(subIndices = {}) {
  let best = null;
  for (const [key, aqi] of Object.entries(subIndices)) {
    if (isNum(aqi) && POLLUTANT_NAMES[key] && (!best || aqi > best.aqi)) {
      best = { key, name: POLLUTANT_NAMES[key], aqi };
    }
  }
  return best;
}

/**
 * Find the hours in the next day with the lowest AQI (best windows to go out / ventilate).
 * @param {{time:string[], us_aqi:(number|null)[]}} hourly
 * @param {number} [count=3]
 * @returns {{time:string, aqi:number}[]}
 */
export function cleanestHours(hourly, count = 3) {
  if (!hourly?.time?.length || !hourly?.us_aqi?.length) return [];
  return hourly.time
    .slice(0, 24)
    .map((time, i) => ({ time, aqi: hourly.us_aqi[i] }))
    .filter((h) => isNum(h.aqi))
    .sort((a, b) => a.aqi - b.aqi)
    .slice(0, count)
    .sort((a, b) => a.time.localeCompare(b.time));
}

/** An AQI drop smaller than this is not worth re-planning the day around. */
export const MEANINGFUL_DROP = 15;

/**
 * Describe whether air gets meaningfully cleaner in the next 24 h.
 * @param {number} currentAqi
 * @param {{time:string, aqi:number}[]} hours output of cleanestHours()
 * @returns {{improves:boolean, bestAqi:number|null, drop:number}}
 */
export function outlook(currentAqi, hours) {
  if (!isNum(currentAqi) || !hours?.length) return { improves: false, bestAqi: null, drop: 0 };
  const bestAqi = Math.min(...hours.map((h) => h.aqi));
  const drop = Math.max(0, currentAqi - bestAqi);
  return { improves: drop >= MEANINGFUL_DROP, bestAqi, drop };
}

/**
 * Safety guidance per band, used to ground both the prompt and the rules engine.
 * Based on EPA AQI activity guidance.
 */
export const BAND_GUIDANCE = Object.freeze({
  good: { outdoorExercise: 'fine for everyone', windows: 'open to ventilate', mask: 'not needed' },
  moderate: { outdoorExercise: 'fine; very sensitive people take it easy', windows: 'open briefly to ventilate', mask: 'not needed' },
  sensitive: { outdoorExercise: 'sensitive groups move it indoors', windows: 'open only in the cleanest hours', mask: 'N95 for sensitive groups outdoors' },
  unhealthy: { outdoorExercise: 'move indoors for everyone', windows: 'keep closed except the cleanest hour', mask: 'N95 for everyone outdoors' },
  'very-unhealthy': { outdoorExercise: 'avoid; stay indoors', windows: 'keep closed', mask: 'N95 essential outdoors' },
  hazardous: { outdoorExercise: 'avoid all outdoor activity', windows: 'keep closed and seal gaps', mask: 'N95 essential; limit any trip outside' },
  unknown: { outdoorExercise: 'use caution', windows: 'use caution', mask: 'consider an N95 in heavy traffic' },
});
