/**
 * air-data Edge Function: a thin, cached proxy to the Google Air Quality API.
 * Keeps the Google key server-side, trims responses to what the app needs, and caches per
 * ~500 m cell so repeat lookups cost nothing. Pure (fetch, clock and config injected) for testing.
 */
import { clientIp, corsFor, createRateLimiter, createTtlCache, readJson } from '../_shared/http.js';

const AQ_URL = 'https://airquality.googleapis.com/v1';
/**
 * Timeout budget for one lookup, shared by every Google call it makes (current conditions and
 * forecast pages run against the same deadline). The browser waits AIR_DATA_TIMEOUT_MS (11 s) in
 * docs/lib/airQuality.js, i.e. this budget plus ~2 s for network and a cold start, so the browser
 * never gives up while the function is still inside its budget.
 */
export const SERVER_BUDGET_MS = 9000;
const FORECAST_HOURS = 48;
const MAX_FORECAST_PAGES = 2;
/** Minimum hours for a forecast to count as complete (and therefore cacheable). */
export const MIN_COMPLETE_HOURS = 24;
const MAX_BODY_BYTES = 1000;

export class GoogleAqError extends Error {
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
 * @param {number} deadline epoch ms by which the call must finish
 */
async function post(fetchImpl, path, apiKey, body, deadline) {
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

/**
 * Fetch current conditions and a 48 h hourly forecast, trimmed, within one time budget.
 * Current conditions are required; a failed or slow forecast is reported as incomplete instead of
 * failing the whole lookup, so the app still shows today's reading.
 * @returns {Promise<{provider:string, resolutionM:number, current:object, hourly:object[], forecastComplete:boolean}>}
 */
export async function fetchGoogleAir({
  latitude,
  longitude,
  apiKey,
  fetchImpl,
  now = Date.now,
  budgetMs = SERVER_BUDGET_MS,
  logger = console,
}) {
  const deadline = Date.now() + budgetMs;
  const location = { latitude, longitude };
  const extraComputations = ['LOCAL_AQI', 'POLLUTANT_CONCENTRATION', 'DOMINANT_POLLUTANT_CONCENTRATION'];
  const start = new Date(Math.floor(now() / 3_600_000) * 3_600_000 + 3_600_000);
  const end = new Date(start.getTime() + (FORECAST_HOURS - 1) * 3_600_000);

  const collected = [];
  const forecastPages = async () => {
    const hours = collected;
    let pageToken;
    for (let page = 0; page < MAX_FORECAST_PAGES && hours.length < FORECAST_HOURS; page += 1) {
      const data = await post(
        fetchImpl,
        'forecast:lookup',
        apiKey,
        {
          location,
          period: { startTime: start.toISOString(), endTime: end.toISOString() },
          pageSize: FORECAST_HOURS,
          universalAqi: false,
          extraComputations: ['LOCAL_AQI', 'POLLUTANT_CONCENTRATION'],
          ...(pageToken ? { pageToken } : {}),
        },
        deadline,
      );
      hours.push(...(data.hourlyForecasts ?? []));
      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return hours.slice(0, FORECAST_HOURS);
  };

  const forecastOrPartial = async () => {
    try {
      return await forecastPages();
    } catch (err) {
      logger.error(JSON.stringify({ fn: 'air-data', part: 'forecast', error: err.message }));
      return collected.slice(0, FORECAST_HOURS); // keep any pages that did arrive
    }
  };

  const [current, hours] = await Promise.all([
    post(
      fetchImpl,
      'currentConditions:lookup',
      apiKey,
      { location, universalAqi: false, extraComputations, languageCode: 'en' },
      deadline,
    ),
    forecastOrPartial(),
  ]);

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
 * Build the request handler.
 * @param {{apiKey?:string, allowedOrigins:string[], fetchImpl?:typeof fetch, logger?:Pick<Console,'error'|'info'>,
 *   rateLimiter?:(key:string)=>boolean, cache?:ReturnType<typeof createTtlCache>, now?:()=>number}} cfg
 */
export function createAirDataHandler({
  apiKey,
  allowedOrigins,
  fetchImpl = fetch,
  logger = console,
  rateLimiter = createRateLimiter({ limit: 30 }),
  cache = createTtlCache({ ttlMs: 15 * 60_000 }),
  now = Date.now,
  budgetMs = SERVER_BUDGET_MS,
}) {
  return async function handle(req) {
    const { allowed, headers, json } = corsFor(req, allowedOrigins);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!allowed) return json(403, { error: 'Origin not allowed' });
    if (!apiKey) return json(503, { error: 'Google Air Quality is not configured' });
    if (!rateLimiter(clientIp(req))) return json(429, { error: 'Too many requests' }, { 'Retry-After': '60' });

    const { body, error } = await readJson(req, MAX_BODY_BYTES);
    if (error) return json(error.status, { error: error.message });
    const lat = Number(body?.latitude);
    const lon = Number(body?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return json(400, { error: 'Invalid coordinates' });
    }

    const key = cellKey(lat, lon);
    const hit = cache.get(key);
    if (hit) return json(200, hit, { 'X-Cache': 'HIT' });

    const started = now();
    try {
      const data = await fetchGoogleAir({ latitude: lat, longitude: lon, apiKey, fetchImpl, now, budgetMs, logger });
      // Only complete answers are cached, so a transient forecast failure isn't repeated for 15 min.
      if (data.forecastComplete) cache.set(key, data);
      logger.info(
        JSON.stringify({
          fn: 'air-data',
          cell: key,
          ms: now() - started,
          hours: data.hourly.length,
          complete: data.forecastComplete,
        }),
      );
      return json(200, data, { 'X-Cache': 'MISS' });
    } catch (err) {
      logger.error(JSON.stringify({ fn: 'air-data', cell: key, error: err.message }));
      return json(err.status === 400 ? 400 : 502, { error: 'Air quality data unavailable for this location' });
    }
  };
}
