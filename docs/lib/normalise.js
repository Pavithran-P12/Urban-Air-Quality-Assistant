/**
 * Turn provider responses into one air-report shape, so the rest of the app never cares where the
 * data came from. All conversions are deterministic and documented.
 */
import {
  POLLUTANT_NAMES,
  categorize,
  cleanestHours,
  dominantPollutant,
  outlook,
  pm25Multiple,
  pm25ToUsAqi,
} from './aqi.js';
import { SOURCES } from './sources.js';
import { isNum, isText, numOrNull } from './guards.js';
import { FORECAST_HOURS } from './forecast.js';

export { SOURCES };

/** Molar volume of an ideal gas at 25 °C and 1 atm, in litres. µg/m³ = ppb × molecular weight / 24.45. */
export const MOLAR_VOLUME_L = 24.45;

/** Molecular weights (g/mol) for ppb → µg/m³ conversion. */
const MOLECULAR_WEIGHT = Object.freeze({ no2: 46.01, o3: 48.0, co: 28.01, so2: 64.07 });

/** Google pollutant codes → our keys. */
const GOOGLE_CODES = Object.freeze({
  pm25: 'pm2_5',
  pm10: 'pm10',
  no2: 'nitrogen_dioxide',
  o3: 'ozone',
  co: 'carbon_monoxide',
  so2: 'sulphur_dioxide',
});

/**
 * Keep a provider's local index (e.g. India's NAQI) only if it is complete: a numeric value, a name
 * and a category. A partial index would otherwise reach the page as "undefined".
 * @param {unknown} li
 * @returns {{code?:string, name:string, aqi:number, category:string}|null}
 */
export function validLocalIndex(li) {
  if (!li || typeof li !== 'object') return null;
  const { code, name, aqi, category } = /** @type {Record<string, unknown>} */ (li);
  if (!isNum(aqi) || !isText(name) || !isText(category)) return null;
  return { ...(isText(code) ? { code } : {}), name: name.trim(), aqi, category: category.trim() };
}

/**
 * Convert one concentration to µg/m³.
 * @param {{code:string, value:number, units:string}} p
 * @returns {number|null}
 */
export function toMicrograms(p) {
  if (!p || !isNum(p.value) || p.value < 0) return null;
  if (p.units === 'MICROGRAMS_PER_CUBIC_METER') return p.value;
  if (p.units === 'PARTS_PER_BILLION' && MOLECULAR_WEIGHT[p.code]) {
    return Math.round(((p.value * MOLECULAR_WEIGHT[p.code]) / MOLAR_VOLUME_L) * 10) / 10;
  }
  return null;
}

/**
 * Format a UTC instant as local "YYYY-MM-DDTHH:MM" (the format the rest of the app uses).
 * Prefers a known UTC offset, then an IANA time zone, then the browser's zone.
 * @param {string} utcIso
 * @param {{offsetSeconds?:number|null, timeZone?:string|null}} tz
 */
export function toLocalIso(utcIso, { offsetSeconds = null, timeZone = null } = {}) {
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return '';
  if (isNum(offsetSeconds)) return new Date(ms + offsetSeconds * 1000).toISOString().slice(0, 16);
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || undefined,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(ms))
        .map((x) => [x.type, x.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 16);
  }
}

/** The five pollutants the app shows, in µg/m³ (null when the provider has no value). */
const SHOWN_POLLUTANTS = ['pm2_5', 'pm10', 'nitrogen_dioxide', 'ozone', 'carbon_monoxide'];

/**
 * Assemble the app's air shape from provider-neutral parts. Category, WHO multiple, cleanest hours
 * and outlook are always derived here, the same way for every provider.
 * @param {{time:string, usAqi:number, aqiEstimated:boolean, aqiMethod:string,
 *   pollutants:Record<string, unknown>, dominant:{key:string, name:string, aqi:number|null}|null,
 *   localIndex:{code?:string, name:string, aqi:number, category:string}|null,
 *   hourly:{time:string[], us_aqi:(number|null)[]}, source:import('./sources.js').SourceInfo}} parts
 * @returns {import('./types.js').AirReading}
 */
function buildReading({ time, usAqi, aqiEstimated, aqiMethod, pollutants, dominant, localIndex, hourly, source }) {
  const hours = cleanestHours(hourly);
  const forecast = hourly.time
    .slice(0, FORECAST_HOURS)
    .map((t, i) => ({ time: t, aqi: hourly.us_aqi[i] }))
    .filter((h) => isNum(h.aqi));
  return {
    time,
    usAqi,
    aqiEstimated,
    aqiMethod,
    category: categorize(usAqi),
    pollutants: /** @type {import('./types.js').AirReading['pollutants']} */ (
      Object.fromEntries(SHOWN_POLLUTANTS.map((key) => [key, numOrNull(pollutants[key])]))
    ),
    pm25WhoMultiple: pm25Multiple(pollutants.pm2_5),
    dominant,
    localIndex,
    forecast,
    cleanestHours: hours,
    outlook: outlook(usAqi, hours),
    source: { ...source, updated: time },
  };
}

/** Google's current pollutant list → our keys, in µg/m³ (buildReading keeps only the ones shown). */
function googlePollutants(list) {
  const pollutants = {};
  for (const p of Array.isArray(list) ? list : []) {
    const key = GOOGLE_CODES[p?.code];
    if (key) pollutants[key] = toMicrograms(p);
  }
  return pollutants;
}

/** The main pollutant from Google's raw dominant code; its sub-index is known only for PM2.5. */
function googleDominant(code, usAqi) {
  const key = Object.hasOwn(GOOGLE_CODES, code ?? '') ? GOOGLE_CODES[code] : null;
  return key ? { key, name: POLLUTANT_NAMES[key], aqi: key === 'pm2_5' ? usAqi : null } : null;
}

/** Google's hourly PM2.5 forecast → parallel local-time and US AQI arrays (unusable hours dropped). */
function googleHourly(hourly, tz) {
  const usable = (Array.isArray(hourly) ? hourly : [])
    .map((h) => ({ time: toLocalIso(h?.dateTime, tz), aqi: pm25ToUsAqi(toMicrograms(h?.pollutants?.[0])) }))
    .filter((h) => h.time && isNum(h.aqi));
  return { time: usable.map((h) => h.time), us_aqi: usable.map((h) => h.aqi) };
}

/**
 * Normalise the air-data function's Google response into the app's air shape.
 * US AQI is computed from PM2.5 with the EPA formula (Google does not document US AQI for every
 * country); the country's own index (e.g. India's NAQI) is kept alongside it.
 * @param {any} g response of the air-data function
 * @param {{offsetSeconds?:number|null, timeZone?:string|null}} [tz]
 * @returns {import('./types.js').AirReading|null} null when there is no usable PM2.5 reading
 */
export function fromGoogle(g, tz = {}) {
  const current = g?.current;
  const pollutants = googlePollutants(current?.pollutants);
  const usAqi = pm25ToUsAqi(pollutants.pm2_5);
  if (usAqi === null) return null;
  return buildReading({
    time: toLocalIso(current?.dateTime, tz),
    usAqi,
    aqiEstimated: true,
    aqiMethod: 'US AQI from PM2.5 (EPA formula)',
    pollutants,
    dominant: googleDominant(current?.localIndex?.dominant, usAqi),
    localIndex: validLocalIndex(current?.localIndex),
    hourly: googleHourly(g.hourly, tz),
    source: SOURCES.google,
  });
}

/** Open-Meteo current fields holding each pollutant's US AQI sub-index. */
export const OPEN_METEO_SUB_INDEX = Object.freeze({
  pm2_5: 'us_aqi_pm2_5',
  pm10: 'us_aqi_pm10',
  nitrogen_dioxide: 'us_aqi_nitrogen_dioxide',
  ozone: 'us_aqi_ozone',
  carbon_monoxide: 'us_aqi_carbon_monoxide',
  sulphur_dioxide: 'us_aqi_sulphur_dioxide',
});

/** Open-Meteo's US AQI, or one computed from PM2.5 when it is missing. */
function openMeteoAqi(current) {
  if (isNum(current.us_aqi)) return { usAqi: current.us_aqi, aqiEstimated: false };
  const usAqi = pm25ToUsAqi(current.pm2_5);
  return { usAqi, aqiEstimated: usAqi !== null };
}

/** Hours from "now" onward; missing hourly AQI is filled from hourly PM2.5. */
function openMeteoHourly(hourly, nowIso) {
  const times = hourly?.time ?? [];
  const start = Math.max(
    0,
    times.findIndex((t) => t >= nowIso),
  );
  const time = times.slice(start);
  const us_aqi = time.map((_, i) => {
    const v = hourly?.us_aqi?.[start + i];
    return typeof v === 'number' ? v : pm25ToUsAqi(hourly?.pm2_5?.[start + i]);
  });
  return { time, us_aqi };
}

/**
 * Normalise an Open-Meteo (CAMS) air-quality response into the app's air shape.
 * @param {any} data Open-Meteo air-quality response
 * @returns {import('./types.js').AirReading|null} null when there is no usable AQI or PM2.5
 */
export function fromOpenMeteo(data) {
  const current = data?.current;
  if (!current) return null;
  const { usAqi, aqiEstimated } = openMeteoAqi(current);
  if (usAqi === null) return null;
  const subIndices = Object.fromEntries(
    Object.entries(OPEN_METEO_SUB_INDEX).map(([key, field]) => [key, current[field]]),
  );
  return buildReading({
    time: current.time,
    usAqi,
    aqiEstimated,
    aqiMethod: aqiEstimated ? 'US AQI from PM2.5 (EPA formula)' : 'US AQI from CAMS',
    pollutants: current,
    dominant: dominantPollutant(subIndices),
    localIndex: null,
    hourly: openMeteoHourly(data.hourly, current.time),
    source: SOURCES['open-meteo'],
  });
}
