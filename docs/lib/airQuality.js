import { categorize, cleanestHours, dominantPollutant, outlook, pm25Multiple, pm25ToUsAqi } from './aqi.js';
import { fromGoogle } from './normalise.js';
import { SOURCES } from './sources.js';
import { UpstreamError } from './errors.js';
import { fetchWeather, summariseWeather } from './weather.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const TIMEOUT_MS = 8000;
/**
 * How long the browser waits for the air-data function: its server budget (SERVER_BUDGET_MS, 9 s,
 * in supabase/functions/air-data/handler.js) plus ~2 s for network and a cold start.
 */
export const AIR_DATA_TIMEOUT_MS = 11_000;
/** Shown when Google was asked for but didn't answer, so the coarser fallback is never silent. */
export const GOOGLE_FALLBACK_REASON = "Google's 500 m data wasn't available just now";

const SUB_INDEX_FIELDS = {
  pm2_5: 'us_aqi_pm2_5',
  pm10: 'us_aqi_pm10',
  nitrogen_dioxide: 'us_aqi_nitrogen_dioxide',
  ozone: 'us_aqi_ozone',
  carbon_monoxide: 'us_aqi_carbon_monoxide',
  sulphur_dioxide: 'us_aqi_sulphur_dioxide',
};

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
 * @param {object[]} results
 * @param {string} [qualifier]
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
      ...Object.values(SUB_INDEX_FIELDS),
    ].join(','),
    hourly: 'us_aqi,pm2_5',
    forecast_days: '2',
    timezone: 'auto',
  });
  const data = await getJson(`${AIR_URL}?${params}`, fetchImpl);
  const c = data?.current;
  if (!c) throw new UpstreamError('Air quality data is unavailable for this location.');

  let usAqi = c.us_aqi;
  let aqiEstimated = false;
  if (typeof usAqi !== 'number') {
    usAqi = pm25ToUsAqi(c.pm2_5);
    aqiEstimated = usAqi !== null;
  }
  if (usAqi === null) {
    throw new UpstreamError(
      'No air quality readings are available for this location right now. Try a nearby city.',
      404,
    );
  }

  // Only look at hours from "now" onward; fill missing hourly AQI from hourly PM2.5.
  const times = data.hourly?.time ?? [];
  const startIdx = Math.max(
    0,
    times.findIndex((t) => t >= c.time),
  );
  const hourly = {
    time: times.slice(startIdx),
    us_aqi: times.slice(startIdx).map((_, i) => {
      const v = data.hourly?.us_aqi?.[startIdx + i];
      return typeof v === 'number' ? v : pm25ToUsAqi(data.hourly?.pm2_5?.[startIdx + i]);
    }),
  };

  const hours = cleanestHours(hourly);
  const forecast = hourly.time
    .slice(0, 48)
    .map((time, i) => ({ time, aqi: hourly.us_aqi[i] }))
    .filter((h) => typeof h.aqi === 'number');
  const subIndices = Object.fromEntries(Object.entries(SUB_INDEX_FIELDS).map(([key, field]) => [key, c[field]]));

  return {
    time: c.time,
    usAqi,
    aqiEstimated,
    aqiMethod: aqiEstimated ? 'US AQI from PM2.5 (EPA formula)' : 'US AQI from CAMS',
    category: categorize(usAqi),
    pollutants: {
      pm2_5: c.pm2_5,
      pm10: c.pm10,
      nitrogen_dioxide: c.nitrogen_dioxide,
      ozone: c.ozone,
      carbon_monoxide: c.carbon_monoxide,
    },
    pm25WhoMultiple: pm25Multiple(c.pm2_5),
    dominant: dominantPollutant(subIndices),
    localIndex: null,
    forecast,
    cleanestHours: hours,
    outlook: outlook(usAqi, hours),
    source: { ...SOURCES['open-meteo'], updated: c.time },
  };
}

/**
 * Ask the air-data Edge Function (Google Air Quality API, 500 m) for a location.
 * Returns null on any failure so the caller can fall back to Open-Meteo.
 * @param {string|undefined} url
 */
export async function fetchGoogleAir(url, latitude, longitude, fetchImpl = fetch, timeoutMs = AIR_DATA_TIMEOUT_MS) {
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
  let place;
  if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
    place = { name: 'Your location', latitude: loc.latitude, longitude: loc.longitude, timezone: null };
  } else {
    place = await geocode(loc.city, fetchImpl);
  }

  const [google, weather] = await Promise.all([
    fetchGoogleAir(airDataUrl, place.latitude, place.longitude, fetchImpl, airDataTimeoutMs),
    fetchWeather(place.latitude, place.longitude, fetchImpl),
  ]);
  const tz = { offsetSeconds: weather?.offsetSeconds ?? null, timeZone: weather?.timeZone ?? place.timezone ?? null };

  let air = google ? fromGoogle(google, tz) : null;
  if (!air) {
    air = await fetchAirQuality(place.latitude, place.longitude, fetchImpl);
    // Google was asked for but didn't answer: say so, rather than silently showing coarser data.
    if (airDataUrl) air.source = { ...air.source, fallback: true, fallbackReason: GOOGLE_FALLBACK_REASON };
  }

  const bestHour = air.cleanestHours.find((h) => h.aqi === air.outlook.bestAqi);
  return { place, air, weather: summariseWeather(weather, bestHour, air.time), weatherHours: weather?.hourly ?? [] };
}

/**
 * Whether a report may be reused from the browser cache. Fallback results (Google failed) and
 * reports with an incomplete forecast are transient, so the next search tries again.
 * @param {import('./types.js').AirReport} report
 * @returns {boolean}
 */
export function isCacheable(report) {
  return !report?.air?.source?.fallback && (report?.air?.forecast?.length ?? 0) >= 24;
}
