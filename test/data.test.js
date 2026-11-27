import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toMicrograms, toLocalIso, fromGoogle, MOLAR_VOLUME_L } from '../docs/lib/normalise.js';
import { fetchWeather, summariseWeather } from '../docs/lib/weather.js';
import { getAirReport } from '../docs/lib/airQuality.js';
import { buildPrompt } from '../docs/lib/prompt.js';
import { parseProfile, sanitizeReport } from '../docs/lib/validate.js';
import * as aqi from '../docs/lib/aqi.js';
import { cellKey, createAirDataHandler, lookupGoogleAir } from '../supabase/functions/air-data/handler.js';
import { createTtlCache, createRateLimiter, parseOrigins } from '../supabase/functions/_shared/http.js';
import { mockFetch, googleResponse, weatherResponse } from './fixtures.js';

import { ORIGIN, AIR_DATA_URL as AIR_DATA, silent } from './helpers.js';

describe('normalise', () => {
  test('converts ppb to µg/m³ with the 25 °C molar volume', () => {
    assert.equal(toMicrograms({ code: 'no2', value: 24.45, units: 'PARTS_PER_BILLION' }), 46);
    assert.equal(toMicrograms({ code: 'pm25', value: 12.3, units: 'MICROGRAMS_PER_CUBIC_METER' }), 12.3);
    assert.equal(
      toMicrograms({ code: 'pm25', value: 5, units: 'PARTS_PER_BILLION' }),
      null,
      'no molecular weight for particles',
    );
    assert.equal(toMicrograms({ code: 'no2', value: -1, units: 'PARTS_PER_BILLION' }), null);
    assert.equal(MOLAR_VOLUME_L, 24.45);
  });

  test('toLocalIso applies an offset, an IANA zone, or falls back', () => {
    assert.equal(toLocalIso('2026-11-26T04:30:00Z', { offsetSeconds: 19800 }), '2026-11-26T10:00');
    assert.equal(toLocalIso('2026-11-26T04:30:00Z', { timeZone: 'Asia/Kolkata' }), '2026-11-26T10:00');
    assert.equal(toLocalIso('not a date'), '');
  });

  test('fromGoogle computes US AQI from PM2.5, keeps the local index and labels the source', () => {
    const air = fromGoogle(googleResponse, { offsetSeconds: 19800 });
    assert.equal(air.usAqi, aqi.pm25ToUsAqi(150.2));
    assert.equal(air.aqiEstimated, true);
    assert.match(air.aqiMethod, /PM2\.5/);
    assert.deepEqual(air.localIndex, {
      code: 'ind_cpcb',
      name: 'AQI (IN)',
      aqi: 312,
      category: 'Very poor air quality',
    });
    assert.equal(air.dominant.key, 'pm2_5');
    assert.equal(air.source.resolution, '500 m grid');
    assert.equal(air.source.kind, 'modelled');
    assert.equal(air.time, '2026-11-26T10:00');
    assert.equal(air.pollutants.nitrogen_dioxide, Math.round(((30 * 46.01) / 24.45) * 10) / 10);
    assert.equal(air.forecast.length, 48);
    assert.equal(air.outlook.bestAqi, aqi.pm25ToUsAqi(30));
    assert.equal(air.outlook.improves, true);
  });

  test('fromGoogle returns null without PM2.5 so the caller falls back', () => {
    const g = structuredClone(googleResponse);
    g.current.pollutants = g.current.pollutants.filter((p) => p.code !== 'pm25');
    assert.equal(fromGoogle(g), null);
  });
});

describe('weather', () => {
  test('parses Open-Meteo forecast and summarises it', async () => {
    const w = await fetchWeather(28.6, 77.2, mockFetch());
    assert.equal(w.offsetSeconds, 19800);
    assert.equal(w.now.wind, 4.2);
    const s = summariseWeather(w, { time: weatherResponse.hourly.time[14] }, weatherResponse.hourly.time[0]);
    assert.equal(s.windAtBest, 14);
    assert.equal(s.rainChanceMax24, 40);
  });

  test('is never fatal', async () => {
    assert.equal(await fetchWeather(0, 0, mockFetch({ fail: true })), null);
    assert.equal(summariseWeather(null), null);
  });
});

describe('source selection', () => {
  test('uses Google first when the air-data function answers', async () => {
    const fetchImpl = mockFetch({ google: googleResponse });
    const report = await getAirReport({ city: 'Delhi' }, fetchImpl, { airDataUrl: AIR_DATA });
    assert.equal(report.air.source.provider, 'google');
    assert.ok(!fetchImpl.calls.some((u) => u.includes('air-quality-api')), 'Open-Meteo air not called');
    assert.equal(report.weather.wind, 4.2);
  });

  test('falls back to Open-Meteo when Google is unavailable', async () => {
    const fetchImpl = mockFetch({ google: null });
    const report = await getAirReport({ city: 'Delhi' }, fetchImpl, { airDataUrl: AIR_DATA });
    assert.equal(report.air.source.provider, 'open-meteo');
    assert.equal(report.air.source.resolution, '~45 km grid');
  });

  test('the prompt states the source, local index and weather; the server re-labels the source', async () => {
    const report = await getAirReport({ city: 'Delhi' }, mockFetch({ google: googleResponse }), {
      airDataUrl: AIR_DATA,
    });
    report.air.source = { provider: 'google', label: 'LIVE SENSOR', kind: 'measured' };
    const clean = sanitizeReport(report, aqi);
    assert.equal(clean.air.source.kind, 'modelled');
    const prompt = buildPrompt(clean, parseProfile({}));
    assert.match(prompt, /Source: Google Air Quality API \(modelled, 500 m grid\)/);
    assert.match(prompt, /Local index: AQI \(IN\) 312/);
    assert.match(prompt, /wind 4 km\/h/);
    assert.doesNotMatch(prompt, /LIVE SENSOR/);
    assert.doesNotMatch(prompt, /sub-index null/);
  });

  test('the grounding check accepts the local index value', async () => {
    const { normaliseAdvice } = await import('../docs/lib/advice.js');
    const { goodAdvice } = await import('./fixtures.js');
    const report = await getAirReport({ city: 'Delhi' }, mockFetch({ google: googleResponse }), {
      airDataUrl: AIR_DATA,
    });
    const advice = {
      ...goodAdvice,
      summary: `India's index reads AQI 312 today (US AQI ${report.air.usAqi}).`,
      routine: goodAdvice.routine.map((r) => ({ ...r, action: 'Stay indoors' })),
    };
    assert.doesNotThrow(() => normaliseAdvice(advice, report.air));
  });
});

describe('air-data edge function', () => {
  function googleFetch({ status = 200, pages = 1 } = {}) {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      if (status >= 400) return { ok: false, status, json: async () => ({}) };
      if (url.includes('currentConditions')) {
        return {
          ok: true,
          status,
          json: async () => ({
            dateTime: '2026-11-26T04:00:00Z',
            regionCode: 'in',
            indexes: [
              { code: 'ind_cpcb', displayName: 'AQI (IN)', aqi: 300, category: 'Very poor', dominantPollutant: 'pm25' },
            ],
            pollutants: [{ code: 'pm25', concentration: { value: 140, units: 'MICROGRAMS_PER_CUBIC_METER' } }],
          }),
        };
      }
      const page = calls.filter((c) => c.url.includes('forecast')).length;
      return {
        ok: true,
        status,
        json: async () => ({
          hourlyForecasts: Array.from({ length: 24 }, (_, i) => ({
            dateTime: new Date(Date.UTC(2026, 10, 26, i + (page - 1) * 24)).toISOString(),
            indexes: [{ code: 'ind_cpcb', aqi: 250 }],
            pollutants: [
              { code: 'pm25', concentration: { value: 100, units: 'MICROGRAMS_PER_CUBIC_METER' } },
              { code: 'no2', concentration: { value: 20, units: 'PARTS_PER_BILLION' } },
            ],
          })),
          ...(page < pages ? { nextPageToken: `t${page}` } : {}),
        }),
      };
    };
    impl.calls = calls;
    return impl;
  }

  const request = (body, { origin = ORIGIN, method = 'POST', ip = '1.1.1.1' } = {}) =>
    new Request('https://x.supabase.co/functions/v1/air-data', {
      method,
      headers: { 'content-type': 'application/json', origin, 'cf-connecting-ip': ip },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    });

  const make = (opts = {}) =>
    createAirDataHandler({
      apiKey: 'gkey',
      allowedOrigins: [ORIGIN],
      logger: silent,
      fetchImpl: googleFetch(),
      ...opts,
    });

  test('cellKey groups nearby points into ~500 m cells', () => {
    assert.equal(cellKey(13.086, 80.2707), cellKey(13.0855, 80.2712));
    assert.notEqual(cellKey(13.0827, 80.2707), cellKey(13.09, 80.2707));
  });

  test('fetches current + 48 h forecast, trims it, keeps the key in a header', async () => {
    const fetchImpl = googleFetch({ pages: 2 });
    const data = await lookupGoogleAir({
      latitude: 13.08,
      longitude: 80.27,
      apiKey: 'gkey',
      fetchImpl,
      now: () => Date.UTC(2026, 10, 26, 4, 30),
    });
    assert.equal(data.provider, 'google');
    assert.equal(data.current.localIndex.aqi, 300);
    assert.equal(data.hourly.length, 48);
    assert.deepEqual(
      data.hourly[0].pollutants.map((p) => p.code),
      ['pm25'],
      'forecast keeps only PM2.5',
    );
    assert.ok(fetchImpl.calls.every((c) => c.headers['X-Goog-Api-Key'] === 'gkey' && !c.url.includes('gkey')));
    const fc = fetchImpl.calls.find((c) => c.url.includes('forecast'));
    assert.equal(fc.body.period.startTime, '2026-11-26T05:00:00.000Z');
    assert.equal(fetchImpl.calls.filter((c) => c.url.includes('forecast'))[1].body.pageToken, 't1');
  });

  test('serves repeat lookups for the same cell from cache', async () => {
    const fetchImpl = googleFetch();
    const handle = make({ fetchImpl });
    const first = await handle(request({ latitude: 13.086, longitude: 80.2707 }));
    const second = await handle(request({ latitude: 13.0855, longitude: 80.2712 }));
    assert.equal(first.headers.get('x-cache'), 'MISS');
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.equal(fetchImpl.calls.filter((c) => c.url.includes('currentConditions')).length, 1);
  });

  test('validates origin, method, key, body and coordinates', async () => {
    assert.equal((await make()(request({}, { method: 'OPTIONS' }))).status, 204);
    assert.equal((await make()(request(null, { method: 'GET' }))).status, 405);
    assert.equal(
      (await make()(request({ latitude: 1, longitude: 1 }, { origin: 'https://evil.example' }))).status,
      403,
    );
    assert.equal((await make({ apiKey: '' })(request({ latitude: 1, longitude: 1 }))).status, 503);
    assert.equal((await make()(request({ latitude: 200, longitude: 1 }))).status, 400);
    assert.equal((await make()(request({ latitude: 'x', longitude: 1 }))).status, 400);
  });

  test('maps Google failures to a friendly 502', async () => {
    const res = await make({ fetchImpl: googleFetch({ status: 500 }) })(request({ latitude: 1, longitude: 1 }));
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /unavailable/);
  });

  test('rate limits per IP', async () => {
    const handle = make({ rateLimiter: createRateLimiter({ limit: 1 }) });
    assert.equal((await handle(request({ latitude: 1, longitude: 1 }))).status, 200);
    assert.equal((await handle(request({ latitude: 1, longitude: 1 }))).status, 429);
  });
});

describe('shared http helpers', () => {
  test('TTL cache expires and evicts the oldest entry', () => {
    let t = 0;
    const cache = createTtlCache({ ttlMs: 100, max: 2, now: () => t });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.equal(cache.get('a'), undefined, 'evicted');
    assert.equal(cache.get('b'), 2);
    t = 101;
    assert.equal(cache.get('b'), undefined, 'expired');
  });

  test('source labels are frozen so nothing can relabel modelled data at runtime', async () => {
    const { SOURCES } = await import('../docs/lib/sources.js');
    assert.ok(Object.isFrozen(SOURCES.google));
    assert.ok(Object.values(SOURCES).every((s) => s.kind === 'modelled'));
  });

  test('parseOrigins has a safe default and trims entries', () => {
    assert.deepEqual(parseOrigins(' https://a.example , ,https://b.example'), [
      'https://a.example',
      'https://b.example',
    ]);
    assert.ok(parseOrigins(undefined).includes('https://pavithran-p12.github.io'));
  });
});
