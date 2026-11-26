import { categorize, cleanestHours, pm25Multiple } from './aqi.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const TIMEOUT_MS = 8000;

export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

async function getJson(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new UpstreamError('Air quality service is unreachable right now.');
  }
  if (!res.ok) throw new UpstreamError(`Air quality service returned ${res.status}.`);
  return res.json();
}

/**
 * Resolve a city name to coordinates using Open-Meteo geocoding (no API key needed).
 * @param {string} city
 * @param {typeof fetch} [fetchImpl]
 */
export async function geocode(city, fetchImpl = fetch) {
  const url = `${GEOCODE_URL}?${new URLSearchParams({ name: city, count: '1', format: 'json' })}`;
  const data = await getJson(url, fetchImpl);
  const place = data?.results?.[0];
  if (!place) throw new UpstreamError(`Could not find a place called "${city}".`, 404);
  return {
    name: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
    latitude: place.latitude,
    longitude: place.longitude,
    timezone: place.timezone,
  };
}

/**
 * Fetch current + next-24h air quality for coordinates.
 * @param {number} latitude
 * @param {number} longitude
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchAirQuality(latitude, longitude, fetchImpl = fetch) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,carbon_monoxide',
    hourly: 'us_aqi',
    forecast_days: '2',
    timezone: 'auto',
  });
  const data = await getJson(`${AIR_URL}?${params}`, fetchImpl);
  const c = data?.current;
  if (!c) throw new UpstreamError('Air quality data is unavailable for this location.');

  // Only look at hours from "now" onward.
  const now = c.time;
  const startIdx = Math.max(0, (data.hourly?.time ?? []).findIndex((t) => t >= now));
  const hourly = {
    time: (data.hourly?.time ?? []).slice(startIdx),
    us_aqi: (data.hourly?.us_aqi ?? []).slice(startIdx),
  };

  return {
    time: c.time,
    usAqi: c.us_aqi,
    category: categorize(c.us_aqi),
    pollutants: {
      pm2_5: c.pm2_5,
      pm10: c.pm10,
      nitrogen_dioxide: c.nitrogen_dioxide,
      ozone: c.ozone,
      carbon_monoxide: c.carbon_monoxide,
    },
    pm25WhoMultiple: pm25Multiple(c.pm2_5),
    cleanestHours: cleanestHours(hourly),
  };
}

/**
 * Get air quality by city name or coordinates.
 * @param {{city?:string, latitude?:number, longitude?:number}} loc
 * @param {typeof fetch} [fetchImpl]
 */
export async function getAirReport(loc, fetchImpl = fetch) {
  let place;
  if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
    place = { name: 'Your location', latitude: loc.latitude, longitude: loc.longitude };
  } else {
    place = await geocode(loc.city, fetchImpl);
  }
  const air = await fetchAirQuality(place.latitude, place.longitude, fetchImpl);
  return { place, air };
}
