/**
 * Shared test setup: constants, quiet loggers, fake responses and request builders used by
 * several test files.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

export const ORIGIN = 'https://pavithran-p12.github.io';
export const AIR_DATA_URL = 'https://x.supabase.co/functions/v1/air-data';
export const silent = { error: () => {}, info: () => {} };

/** A minimal fetch Response. */
export const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

/** A POST request to an Edge Function, from the allowed origin and a trusted client IP. */
export function functionRequest(url, body, { origin = ORIGIN, method = 'POST', ip = '1.2.3.4', headers = {} } = {}) {
  return new Request(url, {
    method,
    headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

/** A fetch that resolves after `ms` unless its AbortSignal fires first (like real fetch). */
export function slowFetch(ms, response) {
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response(url, init)), ms);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal.reason ?? new Error('aborted'));
      });
    });
}

/** Raw Google Air Quality API bodies (before the air-data function trims them). */
export const googleApi = {
  current: {
    dateTime: '2026-11-26T04:00:00Z',
    regionCode: 'in',
    indexes: [
      { code: 'ind_cpcb', displayName: 'AQI (IN)', aqi: 300, category: 'Very poor', dominantPollutant: 'pm25' },
    ],
    pollutants: [
      { code: 'pm25', concentration: { value: 140, units: 'MICROGRAMS_PER_CUBIC_METER' } },
      { code: 'pm10', concentration: { value: 220, units: 'MICROGRAMS_PER_CUBIC_METER' } },
      { code: 'no2', concentration: { value: 30, units: 'PARTS_PER_BILLION' } },
    ],
  },
  /** One page of hourly forecasts. */
  hours: (n, offset = 0) => ({
    hourlyForecasts: Array.from({ length: n }, (_, i) => ({
      dateTime: new Date(Date.UTC(2026, 10, 26, i + offset)).toISOString(),
      indexes: [{ code: 'ind_cpcb', aqi: 250 }],
      pollutants: [{ code: 'pm25', concentration: { value: i === 6 ? 30 : 90, units: 'MICROGRAMS_PER_CUBIC_METER' } }],
    })),
  }),
};

/**
 * Compare a value with a stored golden file. The file is only (re)written when the caller runs
 * with UPDATE_SNAPSHOTS=1, so behaviour changes always show up as a failing test first.
 * @param {string} file absolute path of the golden JSON file
 * @param {string} key  entry name inside that file
 * @param {unknown} actual
 */
export function matchSnapshot(file, key, actual) {
  const update = process.env.UPDATE_SNAPSHOTS === '1';
  const store = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const value = JSON.parse(JSON.stringify(actual));
  if (update) {
    store[key] = value;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
    return;
  }
  assert.ok(key in store, `No snapshot for "${key}". Review the output, then run with UPDATE_SNAPSHOTS=1.`);
  assert.deepEqual(value, store[key]);
}
