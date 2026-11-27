/**
 * Input validation and sanitisation for API requests.
 * Everything the user sends is treated as untrusted and normalised to a known shape
 * before it reaches the prompt or any upstream service.
 */
import { SOURCES } from './sources.js';
import { ValidationError } from './errors.js';
import { numOrNull as num } from './guards.js';

export const OPTIONS = Object.freeze({
  commute: ['walk', 'cycle', 'public-transport', 'two-wheeler', 'car', 'work-from-home'],
  cooking: ['lpg', 'electric', 'induction', 'biomass', 'kerosene', 'piped-gas'],
  heating: ['none', 'electric', 'gas', 'wood', 'coal', 'kerosene'],
  household: ['children', 'elderly', 'pregnant', 'asthma-or-copd', 'heart-condition', 'pets'],
});

const MAX_TEXT = 300;
/** The US AQI scale tops out at 500; anything far beyond that is a corrupt request, not air. */
const MAX_PLAUSIBLE_AQI = 1000;

export { ValidationError };

/** Strip control characters and angle brackets, collapse whitespace, cap length. */
export function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return '';
  return (
    value
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** True when both coordinates were supplied (even if they turn out to be invalid). */
function hasCoordinates(input) {
  return [input.latitude, input.longitude].every((v) => v !== undefined && v !== '');
}

/**
 * Validate a location: either a city name or a lat/lon pair.
 * @returns {{city?:string, latitude?:number, longitude?:number}}
 */
export function parseLocation(input = {}) {
  if (hasCoordinates(input)) {
    const lat = Number(input.latitude);
    const lon = Number(input.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new ValidationError('Latitude/longitude are out of range.');
    }
    return { latitude: lat, longitude: lon };
  }
  const city = cleanText(input.city, 80);
  if (city.length < 2) throw new ValidationError('Please enter a city name (at least 2 characters).');
  return { city };
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const isLocalTime = (value) => typeof value === 'string' && LOCAL_TIME.test(value);

/** Up to three cleanest hours, each with a valid local time and a numeric AQI. */
function sanitizeHours(list) {
  return (Array.isArray(list) ? list.slice(0, 3) : [])
    .map((h) => ({ time: cleanText(h?.time, 20), aqi: num(h?.aqi) }))
    .filter((h) => isLocalTime(h.time) && h.aqi !== null);
}

/** The main pollutant, kept only for a known key; its display name is always ours. */
function sanitizeDominant(d, names) {
  if (!d || typeof d.key !== 'string' || !Object.hasOwn(names, d.key)) return null;
  return { key: d.key, name: names[d.key], aqi: num(d.aqi) };
}

/** A local index (e.g. NAQI), kept only when value, name and category are all present. */
function sanitizeLocalIndex(li) {
  const name = cleanText(li?.name, 60);
  const category = cleanText(li?.category, 60);
  const aqi = num(li?.aqi);
  return aqi !== null && name && category ? { name, aqi, category } : null;
}

function sanitizePollutants(pollutants) {
  const p = pollutants ?? {};
  return {
    pm2_5: num(p.pm2_5),
    pm10: num(p.pm10),
    nitrogen_dioxide: num(p.nitrogen_dioxide),
    ozone: num(p.ozone),
    carbon_monoxide: num(p.carbon_monoxide),
  };
}

function sanitizeWeather(weather) {
  const w = weather ?? {};
  return {
    temperature: num(w.temperature),
    wind: num(w.wind),
    windAtBest: num(w.windAtBest),
    rainChanceMax24: num(w.rainChanceMax24),
  };
}

/** The reading itself: a plausible US AQI, or the whole report is rejected. */
function requireAqi(value) {
  const usAqi = num(value);
  if (usAqi === null || usAqi < 0 || usAqi > MAX_PLAUSIBLE_AQI) {
    throw new ValidationError('Air quality reading is missing or invalid.');
  }
  return usAqi;
}

/** Our own source label for the claimed provider, so a client can never relabel modelled data. */
const sourceFor = (provider) => SOURCES[provider] ?? SOURCES['open-meteo'];

/**
 * Rebuild an air report received from a client into a clean, known shape.
 * Used server-side so only plain numbers and short strings ever reach the prompt.
 * Derived fields (category, outlook, dominant pollutant name) are recomputed, never trusted.
 * @param {{place?:{name?:unknown}, air?:any, weather?:any}} input
 * @param {{categorize:Function, outlook:Function, POLLUTANT_NAMES:Record<string,string>}} aqi helpers from aqi.js
 */
export function sanitizeReport(input = {}, { categorize, outlook, POLLUTANT_NAMES }) {
  const air = input.air ?? {};
  const usAqi = requireAqi(air.usAqi);
  const hours = sanitizeHours(air.cleanestHours);
  return {
    place: { name: cleanText(input.place?.name, 120) || 'Unknown location' },
    weather: sanitizeWeather(input.weather),
    air: {
      time: isLocalTime(air.time) ? air.time : '',
      usAqi,
      aqiEstimated: air.aqiEstimated === true,
      category: categorize(usAqi),
      pollutants: sanitizePollutants(air.pollutants),
      pm25WhoMultiple: num(air.pm25WhoMultiple),
      dominant: sanitizeDominant(air.dominant, POLLUTANT_NAMES),
      localIndex: sanitizeLocalIndex(air.localIndex),
      source: sourceFor(air.source?.provider),
      cleanestHours: hours,
      outlook: outlook(usAqi, hours),
    },
  };
}

/**
 * Validate the household/lifestyle profile. Unknown values fall back to safe defaults.
 * @param {Record<string, unknown>} [input]
 * @returns {import('./types.js').Profile}
 */
export function parseProfile(input = {}) {
  const household = Array.isArray(input.household)
    ? [...new Set(input.household.filter((h) => OPTIONS.household.includes(h)))]
    : [];
  return {
    commute: pick(input.commute, OPTIONS.commute, 'public-transport'),
    cooking: pick(input.cooking, OPTIONS.cooking, 'lpg'),
    heating: pick(input.heating, OPTIONS.heating, 'none'),
    household,
    hasPurifier: input.hasPurifier === true,
    question: cleanText(input.question),
  };
}
