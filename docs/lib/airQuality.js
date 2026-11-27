import { fromGoogle, fromOpenMeteo, OPEN_METEO_SUB_INDEX } from './normalise.js';
import { UpstreamError } from './errors.js';
import { fetchWeather, summariseWeather } from './weather.js';
import { MIN_COMPLETE_HOURS } from './forecast.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const TIMEOUT_MS = 8000;
/**
 * How long the browser waits for the air-data function: its server budget (SERVER_BUDGET_MS, 9 s,
 * in supabase/functions/air-data/handler.js) plus ~2 s for network and a cold start.
 */
export const AIR_DATA_TIMEOUT_MS = 11_000;
/** Shown when Google was asked for but didn't answer, so the coarser fallback is never silent. */
const GOOGLE_FALLBACK_REASON = "Google's 500 m data wasn't available just now";

export { UpstreamError };

async function getJson(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new UpstreamError('Air quality service is unreachable right now. Check your connection and try again.');
  }
  if (!res.ok)
    throw new UpstreamError(`Air quality service returned an error (${res.status}). Please try again shortly.`);
  try {
    return await res.json();
  } catch {
    throw new UpstreamError('The air quality service sent a response we could not read. Please try again shortly.');
  }
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

/**
 * Pick the best geocoding match. "Hyderabad, Pakistan" or "Portland, Maine" prefers results whose
 * region/country match the text after the comma; otherwise the API's top (most populous) result wins.
 * @param {import('./types.js').GeocodeResult[]|undefined} results
 * @param {string} [qualifier]
 * @returns {import('./types.js').GeocodeResult|null}
 */
export function pickPlace(results, qualifier) {
  if (!results?.length) return null;
  const q = norm(qualifier);
  if (q) {
    const match = results.find((r) =>
      [r.country, r.country_code, r.admin1, r.admin2].some((v) => norm(v) === q || norm(v).startsWith(q)),
    );
    if (match) return match;
  }
  return results[0];
}

/**
 * Resolve a city name to coordinates using Open-Meteo geocoding (no API key needed).
 * Accepts "City" or "City, Region/Country".
 * @param {string} query
 * @param {typeof fetch} [fetchImpl]
 */
export async function geocode(query, fetchImpl = fetch) {
  const [name, ...rest] = query.split(',');
  const city = name.trim();
  const url = `${GEOCODE_URL}?${new URLSearchParams({ name: city, count: '10', format: 'json' })}`;
  const data = await getJson(url, fetchImpl);
  const place = pickPlace(data?.results, rest.join(','));
  if (!place) {
    throw new UpstreamError(`We couldn't find "${city}". Check the spelling or try a nearby larger city.`, 404);
  }
  return {
    name: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
    latitude: place.latitude,
    longitude: place.longitude,
    timezone: place.timezone,
  };
}

/**
 * Fetch current + next-24h air quality for coordinates.
 * Falls back to computing AQI from PM2.5 if the upstream AQI is missing.
 * @param {number} latitude
 * @param {number} longitude
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchAirQuality(latitude, longitude, fetchImpl = fetch) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: [
      'us_aqi',
      'pm2_5',
      'pm10',
      'nitrogen_dioxide',
      'ozone',
      'carbon_monoxide',
      ...Object.values(OPEN_METEO_SUB_INDEX),
    ].join(','),
    hourly: 'us_aqi,pm2_5',
    forecast_days: '2',
    timezone: 'auto',
  });
  const data = await getJson(`${AIR_URL}?${params}`, fetchImpl);
  if (!data?.current) throw new UpstreamError('Air quality data is unavailable for this location.');
  const air = fromOpenMeteo(data);
  if (!air) {
    throw new UpstreamError(
      'No air quality readings are available for this location right now. Try a nearby city.',
      404,
    );
  }
  return air;
}

/**
 * Ask the air-data Edge Function (Google Air Quality API, 500 m) for a location.
 * Returns null on any failure so the caller can fall back to Open-Meteo.
 * @param {string|undefined} url
 * @param {{latitude:number, longitude:number}} point
 * @param {{fetchImpl?:typeof fetch, timeoutMs?:number}} [options]
 */
export async function fetchGoogleAir(
  url,
  { latitude, longitude },
  { fetchImpl = fetch, timeoutMs = AIR_DATA_TIMEOUT_MS } = {},
) {
  if (!url) return null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude, longitude }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Get air quality by city name or coordinates.
 * Source order: Google Air Quality (500 m, via our Edge Function) → CAMS via Open-Meteo (~45 km).
 * Weather is fetched in parallel and is optional.
 * @param {{city?:string, latitude?:number, longitude?:number}} loc
 * @param {typeof fetch} [fetchImpl]
 * @param {{airDataUrl?:string, airDataTimeoutMs?:number}} [options]
 * @returns {Promise<import('./types.js').AirReport>}
 */
export async function getAirReport(loc, fetchImpl = fetch, { airDataUrl, airDataTimeoutMs } = {}) {
  const place = await resolvePlace(loc, fetchImpl);
  const [google, weather] = await Promise.all([
    fetchGoogleAir(airDataUrl, place, { fetchImpl, timeoutMs: airDataTimeoutMs }),
    fetchWeather(place.latitude, place.longitude, fetchImpl),
  ]);
  const air =
    (google && fromGoogle(google, timeZoneHints(weather, place))) || (await fallbackAir(place, fetchImpl, airDataUrl));
  const bestHour = air.cleanestHours.find((h) => h.aqi === air.outlook.bestAqi);
  return { place, air, weather: summariseWeather(weather, bestHour, air.time), weatherHours: weather?.hourly ?? [] };
}

/** Coordinates are used as given; a city name is geocoded. */
async function resolvePlace(loc, fetchImpl) {
  if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
    return { name: 'Your location', latitude: loc.latitude, longitude: loc.longitude, timezone: null };
  }
  return geocode(loc.city, fetchImpl);
}

/** Best available clues for converting Google's UTC times to local time. */
function timeZoneHints(weather, place) {
  return { offsetSeconds: weather?.offsetSeconds ?? null, timeZone: weather?.timeZone ?? place.timezone ?? null };
}

/** Open-Meteo data. If Google was asked for but didn't answer, say so rather than silently showing coarser data. */
async function fallbackAir(place, fetchImpl, airDataUrl) {
  const air = await fetchAirQuality(place.latitude, place.longitude, fetchImpl);
  if (airDataUrl) air.source = { ...air.source, fallback: true, fallbackReason: GOOGLE_FALLBACK_REASON };
  return air;
}

/**
 * Whether a report may be reused from the browser cache. Fallback results (Google failed) and
 * reports with an incomplete forecast are transient, so the next search tries again.
 * @param {import('./types.js').AirReport} report
 * @returns {boolean}
 */
export function isCacheable(report) {
  return !report?.air?.source?.fallback && (report?.air?.forecast?.length ?? 0) >= MIN_COMPLETE_HOURS;
}
