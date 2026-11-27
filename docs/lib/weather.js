/**
 * Weather context from the Open-Meteo forecast API (free, no key): wind and rain help explain
 * when smog clears. Never fatal: callers get null if weather is unavailable.
 */

import { isNum, numOrNull } from './guards.js';
import { LOOKAHEAD_HOURS } from './forecast.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 6000;

/**
 * @param {number} latitude
 * @param {number} longitude
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{offsetSeconds:number, timeZone:string, now:{temperature:number|null, wind:number|null}, hourly:{time:string, wind:number|null, rainChance:number|null}[]}|null>}
 */
export async function fetchWeather(latitude, longitude, fetchImpl = fetch) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,wind_speed_10m',
    hourly: 'wind_speed_10m,precipitation_probability',
    forecast_days: '3',
    timezone: 'auto',
  });
  try {
    const res = await fetchImpl(`${FORECAST_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? parseWeather(await res.json()) : null;
  } catch {
    return null;
  }
}

/** Keep only finite numbers from an Open-Meteo forecast response. Throws on a non-object (caught above). */
function parseWeather(d) {
  const hourly = d.hourly ?? {};
  return {
    offsetSeconds: numOrNull(d.utc_offset_seconds),
    timeZone: typeof d.timezone === 'string' ? d.timezone : null,
    now: {
      temperature: numOrNull(d.current?.temperature_2m),
      wind: numOrNull(d.current?.wind_speed_10m),
    },
    hourly: (hourly.time ?? []).map((time, i) => ({
      time,
      wind: numOrNull(hourly.wind_speed_10m?.[i]),
      rainChance: numOrNull(hourly.precipitation_probability?.[i]),
    })),
  };
}

/**
 * Summarise weather for the prompt and UI: wind now, wind at the cleanest hour, max rain chance
 * over the next 24 hours.
 * @param {ReturnType<typeof fetchWeather> extends Promise<infer T> ? T : never} weather
 * @param {{time:string}|undefined} bestHour
 * @param {string} nowIso local "YYYY-MM-DDTHH:MM"
 */
export function summariseWeather(weather, bestHour, nowIso) {
  if (!weather) return null;
  const hourOf = (iso) => iso?.slice(0, 13);
  const at = (iso) => weather.hourly.find((h) => hourOf(h.time) === hourOf(iso));
  const next24 = weather.hourly.filter((h) => h.time >= (nowIso ?? '')).slice(0, LOOKAHEAD_HOURS);
  const rain = next24.map((h) => h.rainChance).filter(isNum);
  return {
    temperature: weather.now.temperature,
    wind: weather.now.wind,
    windAtBest: bestHour ? (at(bestHour.time)?.wind ?? null) : null,
    rainChanceMax24: rain.length ? Math.max(...rain) : null,
  };
}
