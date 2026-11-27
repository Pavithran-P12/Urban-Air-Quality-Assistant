/**
 * air-data Edge Function: a thin, cached proxy to the Google Air Quality API.
 * Keeps the Google key server-side, trims responses to what the app needs, and caches per
 * ~500 m cell so repeat lookups cost nothing. Pure (fetch, clock and config injected) for testing.
 */
import { corsFor, createRateLimiter, createTtlCache, readJson, rejectRequest } from '../_shared/http.js';
import { FORECAST_HOURS, MIN_COMPLETE_HOURS } from '../../../docs/lib/forecast.js';
import { describeForLog } from '../../../docs/lib/errors.js';

const AQ_URL = 'https://airquality.googleapis.com/v1';
/**
 * Timeout budget for one lookup, shared by every Google call it makes (current conditions and
 * forecast pages run against the same deadline). The browser waits AIR_DATA_TIMEOUT_MS (11 s) in
 * docs/lib/airQuality.js, i.e. this budget plus ~2 s for network and a cold start, so the browser
 * never gives up while the function is still inside its budget.
 */
export const SERVER_BUDGET_MS = 9000;
const MAX_FORECAST_PAGES = 2;
const MAX_BODY_BYTES = 1000;
const HOUR_MS = 3_600_000;
const CACHE_TTL_MS = 15 * 60_000;
const GATE_MESSAGES = { notConfigured: 'Google Air Quality is not configured', tooMany: 'Too many requests' };
const CURRENT_EXTRAS = ['LOCAL_AQI', 'POLLUTANT_CONCENTRATION', 'DOMINANT_POLLUTANT_CONCENTRATION'];
const FORECAST_EXTRAS = ['LOCAL_AQI', 'POLLUTANT_CONCENTRATION'];

/** An internal failure talking to Google. Logged (sanitised) only; clients get a generic message. */
class GoogleAqError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'GoogleAqError';
    this.status = status;
  }
}

/** Round to a ~0.5 km cell so nearby lookups share a cache entry, matching the API's 500 m grid. */
export function cellKey(lat, lon) {
  const r = (v) => (Math.round(v * 200) / 200).toFixed(3);
  return `${r(lat)},${r(lon)}`;
}

/** Keep only code, value and units for each pollutant. */
function trimPollutants(list) {
  return (Array.isArray(list) ? list : []).map((p) => ({
    code: p?.code,
    value: p?.concentration?.value,
    units: p?.concentration?.units,
  }));
}

/** The first non-universal index (the country's local AQI, e.g. India's NAQI "ind_cpcb"). */
function localIndex(indexes) {
  const idx = (Array.isArray(indexes) ? indexes : []).find((i) => i?.code && i.code !== 'uaqi');
  return idx
    ? { code: idx.code, name: idx.displayName, aqi: idx.aqi, category: idx.category, dominant: idx.dominantPollutant }
    : null;
}

/**
 * POST to the Air Quality API, aborting when the shared deadline passes.
 * @param {{fetchImpl:typeof fetch, apiKey:string, deadline:number}} client deadline is epoch ms
 * @param {string} path e.g. "currentConditions:lookup"
 * @param {object} body
 */
async function post({ fetchImpl, apiKey, deadline }, path, body) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new GoogleAqError('Google Air Quality time budget exhausted');
  let res;
  try {
    res = await fetchImpl(`${AQ_URL}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(remaining),
    });
  } catch (err) {
    throw new GoogleAqError(`Google Air Quality unreachable: ${err.message}`);
  }
  if (!res.ok) throw new GoogleAqError(`Google Air Quality returned ${res.status}`, res.status === 400 ? 400 : 502);
  return res.json();
}

/** The forecast window: the next FORECAST_HOURS whole hours, starting at the coming hour. */
function forecastPeriod(nowMs) {
  const start = new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_MS);
  const end = new Date(start.getTime() + (FORECAST_HOURS - 1) * HOUR_MS);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

/**
 * Collect forecast pages into `hours` (up to MAX_FORECAST_PAGES). Pages that arrived are kept
 * even if a later page fails, so the caller can still show a partial forecast.
 */
async function collectForecast(client, location, period, hours) {
  let pageToken;
  for (let page = 0; page < MAX_FORECAST_PAGES && hours.length < FORECAST_HOURS; page += 1) {
    const data = await post(client, 'forecast:lookup', {
      location,
      period,
      pageSize: FORECAST_HOURS,
      universalAqi: false,
      extraComputations: FORECAST_EXTRAS,
      ...(pageToken ? { pageToken } : {}),
    });
    hours.push(...(data.hourlyForecasts ?? []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
}

/** The forecast, or whatever part of it arrived: a failed or slow forecast never fails the lookup. */
async function forecastOrPartial(client, location, period, logger) {
  const hours = [];
  try {
    await collectForecast(client, location, period, hours);
  } catch (err) {
    logger.error(JSON.stringify({ fn: 'air-data', part: 'forecast', error: describeForLog(err) }));
  }
  return hours.slice(0, FORECAST_HOURS);
}

/** Trim Google's responses to what the browser reads (see test/contract.test.js). */
function trimResponse(current, hours) {
  return {
    provider: 'google',
    resolutionM: 500,
    regionCode: current.regionCode ?? null,
    current: {
      dateTime: current.dateTime,
      localIndex: localIndex(current.indexes),
      pollutants: trimPollutants(current.pollutants),
    },
    hourly: hours.map((h) => ({
      dateTime: h.dateTime,
      localAqi: localIndex(h.indexes)?.aqi ?? null,
      pollutants: trimPollutants(h.pollutants).filter((p) => p.code === 'pm25'),
    })),
    forecastComplete: hours.length >= MIN_COMPLETE_HOURS,
  };
}

/**
 * Fetch current conditions and a 48 h hourly forecast, trimmed, within one time budget.
 * Current conditions are required; a failed or slow forecast is reported as incomplete instead of
 * failing the whole lookup, so the app still shows today's reading.
 * @param {{latitude:number, longitude:number, apiKey:string, fetchImpl:typeof fetch, now?:() => number,
 *   budgetMs?:number, logger?:Pick<Console,'error'>}} options
 * @returns {Promise<{provider:string, resolutionM:number, current:object, hourly:object[], forecastComplete:boolean}>}
 */
export async function lookupGoogleAir({
  latitude,
  longitude,
  apiKey,
  fetchImpl,
  now = Date.now,
  budgetMs = SERVER_BUDGET_MS,
  logger = console,
}) {
  const client = { fetchImpl, apiKey, deadline: Date.now() + budgetMs };
  const location = { latitude, longitude };
  const [current, hours] = await Promise.all([
    post(client, 'currentConditions:lookup', {
      location,
      universalAqi: false,
      extraComputations: CURRENT_EXTRAS,
      languageCode: 'en',
    }),
    forecastOrPartial(client, location, forecastPeriod(now()), logger),
  ]);
  return trimResponse(current, hours);
}

/** Valid coordinates from a request body, or null. */
function readCoordinates(body) {
  const lat = Number(body?.latitude);
  const lon = Number(body?.longitude);
  const valid = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return valid ? { lat, lon } : null;
}

/**
 * Build the request handler.
 * @param {{apiKey?:string, allowedOrigins:string[], fetchImpl?:typeof fetch, logger?:Pick<Console,'error'|'info'>,
 *   rateLimiter?:(key:string)=>boolean, cache?:ReturnType<typeof createTtlCache>, now?:()=>number,
 *   budgetMs?:number}} cfg
 */
export function createAirDataHandler({
  apiKey,
  allowedOrigins,
  fetchImpl = fetch,
  logger = console,
  rateLimiter = createRateLimiter({ limit: 30 }),
  cache = createTtlCache({ ttlMs: CACHE_TTL_MS }),
  now = Date.now,
  budgetMs = SERVER_BUDGET_MS,
}) {
  /** Serve one ~500 m cell: from cache, or from Google (caching only complete answers). */
  async function lookupCell({ lat, lon }, json) {
    const key = cellKey(lat, lon);
    const hit = cache.get(key);
    if (hit) return json(200, hit, { 'X-Cache': 'HIT' });
    const started = now();
    try {
      const data = await lookupGoogleAir({ latitude: lat, longitude: lon, apiKey, fetchImpl, now, budgetMs, logger });
      // Only complete answers are cached, so a transient forecast failure isn't repeated for 15 min.
      if (data.forecastComplete) cache.set(key, data);
      const log = { fn: 'air-data', cell: key, ms: now() - started, hours: data.hourly.length };
      logger.info(JSON.stringify({ ...log, complete: data.forecastComplete }));
      return json(200, data, { 'X-Cache': 'MISS' });
    } catch (err) {
      logger.error(JSON.stringify({ fn: 'air-data', cell: key, error: describeForLog(err) }));
      return json(err.status === 400 ? 400 : 502, { error: 'Air quality data unavailable for this location' });
    }
  }

  return async function handle(req) {
    const cors = corsFor(req, allowedOrigins);
    const rejected = rejectRequest(req, { cors, configured: Boolean(apiKey), rateLimiter, messages: GATE_MESSAGES });
    if (rejected) return rejected;
    const { body, error } = await readJson(req, MAX_BODY_BYTES);
    if (error) return cors.json(error.status, { error: error.message });
    const point = readCoordinates(body);
    if (!point) return cors.json(400, { error: 'Invalid coordinates' });
    return lookupCell(point, cors.json);
  };
}
