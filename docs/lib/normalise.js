/**
 * Turn provider responses into one air-report shape, so the rest of the app never cares where the
 * data came from. All conversions are deterministic and documented.
 */
import { POLLUTANT_NAMES, categorize, cleanestHours, outlook, pm25Multiple, pm25ToUsAqi } from './aqi.js';
import { SOURCES } from './sources.js';

export { SOURCES };

/** Molar volume of an ideal gas at 25 °C and 1 atm, in litres. µg/m³ = ppb × molecular weight / 24.45. */
export const MOLAR_VOLUME_L = 24.45;

/** Molecular weights (g/mol) for ppb → µg/m³ conversion. */
export const MOLECULAR_WEIGHT = Object.freeze({ no2: 46.01, o3: 48.0, co: 28.01, so2: 64.07 });

/** Google pollutant codes → our keys. */
export const GOOGLE_CODES = Object.freeze({
  pm25: 'pm2_5',
  pm10: 'pm10',
  no2: 'nitrogen_dioxide',
  o3: 'ozone',
  co: 'carbon_monoxide',
  so2: 'sulphur_dioxide',
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

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

/**
 * Normalise the air-data function's Google response into the app's air shape.
 * US AQI is computed from PM2.5 with the EPA formula (Google does not document US AQI for every
 * country); the country's own index (e.g. India's NAQI) is kept alongside it.
 * @param {object} g response of the air-data function
 * @param {{offsetSeconds?:number|null, timeZone?:string|null}} tz
 */
export function fromGoogle(g, tz = {}) {
  const pollutants = {};
  for (const p of g?.current?.pollutants ?? []) {
    const key = GOOGLE_CODES[p.code];
    if (key && key !== 'sulphur_dioxide') pollutants[key] = toMicrograms(p);
  }
  const usAqi = pm25ToUsAqi(pollutants.pm2_5);
  if (usAqi === null) return null;

  const li = g.current.localIndex;
  const domKey = GOOGLE_CODES[li?.dominant];
  const time = toLocalIso(g.current.dateTime, tz);
  const forecast = (g.hourly ?? [])
    .map((h) => ({ time: toLocalIso(h.dateTime, tz), aqi: pm25ToUsAqi(toMicrograms(h.pollutants?.[0])) }))
    .filter((h) => h.time && isNum(h.aqi));
  const hours = cleanestHours({ time: forecast.map((h) => h.time), us_aqi: forecast.map((h) => h.aqi) });

  return {
    time,
    usAqi,
    aqiEstimated: true,
    aqiMethod: 'US AQI from PM2.5 (EPA formula)',
    category: categorize(usAqi),
    pollutants: {
      pm2_5: pollutants.pm2_5 ?? null,
      pm10: pollutants.pm10 ?? null,
      nitrogen_dioxide: pollutants.nitrogen_dioxide ?? null,
      ozone: pollutants.ozone ?? null,
      carbon_monoxide: pollutants.carbon_monoxide ?? null,
    },
    pm25WhoMultiple: pm25Multiple(pollutants.pm2_5),
    dominant: domKey ? { key: domKey, name: POLLUTANT_NAMES[domKey], aqi: domKey === 'pm2_5' ? usAqi : null } : null,
    localIndex: li && isNum(li.aqi) ? { code: li.code, name: li.name, aqi: li.aqi, category: li.category } : null,
    forecast,
    cleanestHours: hours,
    outlook: outlook(usAqi, hours),
    source: { ...SOURCES.google, updated: time },
  };
}
