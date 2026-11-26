/**
 * Weather context from the Open-Meteo forecast API (free, no key): wind and rain help explain
 * when smog clears. Never fatal: callers get null if weather is unavailable.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 6000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

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
    if (!res.ok) return null;
    const d = await res.json();
    const times = d?.hourly?.time ?? [];
    return {
      offsetSeconds: isNum(d.utc_offset_seconds) ? d.utc_offset_seconds : null,
      timeZone: typeof d.timezone === 'string' ? d.timezone : null,
      now: {
        temperature: isNum(d.current?.temperature_2m) ? d.current.temperature_2m : null,
        wind: isNum(d.current?.wind_speed_10m) ? d.current.wind_speed_10m : null,
      },
      hourly: times.map((time, i) => ({
        time,
        wind: isNum(d.hourly.wind_speed_10m?.[i]) ? d.hourly.wind_speed_10m[i] : null,
        rainChance: isNum(d.hourly.precipitation_probability?.[i]) ? d.hourly.precipitation_probability[i] : null,
      })),
    };
  } catch {
    return null;
  }
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
  const next24 = weather.hourly.filter((h) => h.time >= (nowIso ?? '')).slice(0, 24);
  const rain = next24.map((h) => h.rainChance).filter(isNum);
  return {
    temperature: weather.now.temperature,
    wind: weather.now.wind,
    windAtBest: bestHour ? (at(bestHour.time)?.wind ?? null) : null,
    rainChanceMax24: rain.length ? Math.max(...rain) : null,
  };
}
