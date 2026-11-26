/**
 * Input validation and sanitisation for API requests.
 * Everything the user sends is treated as untrusted and normalised to a known shape
 * before it reaches the prompt or any upstream service.
 */
import { SOURCES } from './sources.js';

export const OPTIONS = Object.freeze({
  commute: ['walk', 'cycle', 'public-transport', 'two-wheeler', 'car', 'work-from-home'],
  cooking: ['lpg', 'electric', 'induction', 'biomass', 'kerosene', 'piped-gas'],
  heating: ['none', 'electric', 'gas', 'wood', 'coal', 'kerosene'],
  household: ['children', 'elderly', 'pregnant', 'asthma-or-copd', 'heart-condition', 'pets'],
});

const MAX_TEXT = 300;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

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

/**
 * Validate a location: either a city name or a lat/lon pair.
 * @returns {{city?:string, latitude?:number, longitude?:number}}
 */
export function parseLocation(input = {}) {
  const lat = Number(input.latitude);
  const lon = Number(input.longitude);
  const hasCoords =
    input.latitude !== undefined && input.longitude !== undefined && input.latitude !== '' && input.longitude !== '';
  if (hasCoords) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new ValidationError('Latitude/longitude are out of range.');
    }
    return { latitude: lat, longitude: lon };
  }
  const city = cleanText(input.city, 80);
  if (city.length < 2) throw new ValidationError('Please enter a city name (at least 2 characters).');
  return { city };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Rebuild an air report received from a client into a clean, known shape.
 * Used server-side so only plain numbers and short strings ever reach the prompt.
 * Derived fields (category, outlook, dominant pollutant name) are recomputed, never trusted.
 * @param {{place?:object, air?:object}} input
 * @param {{categorize:Function, outlook:Function, POLLUTANT_NAMES:Record<string,string>}} aqi helpers from aqi.js
 */
export function sanitizeReport(input = {}, { categorize, outlook, POLLUTANT_NAMES }) {
  const air = input.air ?? {};
  const usAqi = num(air.usAqi);
  if (usAqi === null || usAqi < 0 || usAqi > 1000)
    throw new ValidationError('Air quality reading is missing or invalid.');
  const p = air.pollutants ?? {};
  const hours = (Array.isArray(air.cleanestHours) ? air.cleanestHours.slice(0, 3) : [])
    .map((h) => ({ time: cleanText(h?.time, 20), aqi: num(h?.aqi) }))
    .filter((h) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(h.time) && h.aqi !== null);
  const d = air.dominant;
  const li = air.localIndex;
  const src = SOURCES[air.source?.provider];
  const w = input.weather ?? {};
  return {
    place: { name: cleanText(input.place?.name, 120) || 'Unknown location' },
    weather: {
      temperature: num(w.temperature),
      wind: num(w.wind),
      windAtBest: num(w.windAtBest),
      rainChanceMax24: num(w.rainChanceMax24),
    },
    air: {
      time: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(air.time) ? air.time : '',
      usAqi,
      aqiEstimated: air.aqiEstimated === true,
      category: categorize(usAqi),
      pollutants: {
        pm2_5: num(p.pm2_5),
        pm10: num(p.pm10),
        nitrogen_dioxide: num(p.nitrogen_dioxide),
        ozone: num(p.ozone),
        carbon_monoxide: num(p.carbon_monoxide),
      },
      pm25WhoMultiple: num(air.pm25WhoMultiple),
      dominant:
        d && typeof d.key === 'string' && Object.hasOwn(POLLUTANT_NAMES, d.key)
          ? { key: d.key, name: POLLUTANT_NAMES[d.key], aqi: num(d.aqi) }
          : null,
      localIndex:
        li && num(li.aqi) !== null
          ? { name: cleanText(li.name, 60), aqi: num(li.aqi), category: cleanText(li.category, 60) }
          : null,
      source: src ?? SOURCES['open-meteo'],
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
