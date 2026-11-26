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

/**
 * Map a US AQI value to its band.
 * @param {number} aqi
 * @returns {{max:number, level:string, label:string, color:string}}
 */
export function categorize(aqi) {
  if (typeof aqi !== 'number' || !Number.isFinite(aqi) || aqi < 0) {
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
  if (typeof pm25 !== 'number' || !Number.isFinite(pm25) || pm25 < 0) return null;
  return Math.round((pm25 / WHO_PM25_24H) * 10) / 10;
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
    .filter((h) => typeof h.aqi === 'number')
    .sort((a, b) => a.aqi - b.aqi)
    .slice(0, count)
    .sort((a, b) => a.time.localeCompare(b.time));
}
