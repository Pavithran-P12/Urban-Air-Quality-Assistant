/**
 * Contract tests between the Edge Functions and the browser: what air-data returns is exactly
 * what the browser's converter reads, and what the browser sends to air-advice is accepted.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAirDataHandler } from '../supabase/functions/air-data/handler.js';
import { createHandler as createAdviceHandler } from '../supabase/functions/air-advice/handler.js';
import { getAirReport, isCacheable } from '../docs/lib/airQuality.js';
import { trimForServer } from '../docs/api.js';
import { fromGoogle, fromOpenMeteo } from '../docs/lib/normalise.js';
import { parseProfile, sanitizeReport } from '../docs/lib/validate.js';
import * as aqi from '../docs/lib/aqi.js';
import { mockFetch, goodAdvice, airResponse, googleResponse } from './fixtures.js';
import { AIR_DATA_URL, functionRequest, googleApi, jsonResponse, silent } from './helpers.js';

/** Raw Google API: current conditions plus a forecast in `pages` pages. */
function googleApiFetch({ pages = [48] } = {}) {
  let page = 0;
  return async (url) => {
    if (String(url).includes('currentConditions')) return jsonResponse(googleApi.current);
    const n = pages[page] ?? 0;
    const body = googleApi.hours(n, 1 + pages.slice(0, page).reduce((a, b) => a + b, 0));
    page += 1;
    return jsonResponse(page < pages.length ? { ...body, nextPageToken: `p${page}` } : body);
  };
}

/** Call the real air-data handler and return its JSON body. */
async function airDataBody(opts = {}) {
  const handler = createAirDataHandler({
    apiKey: 'gkey',
    allowedOrigins: ['https://pavithran-p12.github.io'],
    logger: silent,
    fetchImpl: googleApiFetch(opts),
    now: () => Date.UTC(2026, 10, 26, 4, 10),
  });
  const res = await handler(functionRequest(AIR_DATA_URL, { latitude: 28.6, longitude: 77.2 }));
  assert.equal(res.status, 200);
  return res.json();
}

describe('contract: air-data → browser', () => {
  test('response has every field the browser reads, with the right types', async () => {
    const body = await airDataBody();
    assert.equal(body.provider, 'google');
    assert.equal(typeof body.current.dateTime, 'string');
    assert.ok(Array.isArray(body.current.pollutants));
    for (const p of body.current.pollutants) {
      assert.equal(typeof p.code, 'string');
      assert.equal(typeof p.value, 'number');
      assert.equal(typeof p.units, 'string');
    }
    assert.deepEqual(Object.keys(body.current.localIndex).sort(), ['aqi', 'category', 'code', 'dominant', 'name']);
    assert.equal(body.hourly.length, 48);
    for (const h of body.hourly) {
      assert.equal(typeof h.dateTime, 'string');
      assert.equal(h.pollutants[0].code, 'pm25');
    }
    assert.equal(body.forecastComplete, true);
  });

  test('the browser turns that response into a complete Google reading', async () => {
    const body = await airDataBody();
    const air = fromGoogle(body, { offsetSeconds: 19800 });
    assert.ok(air, 'converter accepted the server output');
    assert.equal(air.source.provider, 'google');
    assert.equal(air.dominant.key, 'pm2_5');
    assert.equal(air.localIndex.code, 'ind_cpcb');
    assert.equal(air.forecast.length, 48);
    assert.equal(air.cleanestHours.length, 3);
  });

  test('end to end through getAirReport: complete answers are cacheable, short forecasts are not', async () => {
    const full = await getAirReport({ latitude: 28.6, longitude: 77.2 }, mockFetch({ google: await airDataBody() }), {
      airDataUrl: AIR_DATA_URL,
    });
    assert.equal(full.air.source.provider, 'google');
    assert.equal(isCacheable(full), true);

    const short = await getAirReport(
      { latitude: 28.6, longitude: 77.2 },
      mockFetch({ google: await airDataBody({ pages: [10] }) }),
      { airDataUrl: AIR_DATA_URL },
    );
    assert.equal(short.air.forecast.length, 10);
    assert.equal(isCacheable(short), false);
  });
});

describe('contract: browser → air-advice', () => {
  test('a report exactly as the browser sends it is accepted and answered', async () => {
    const report = await getAirReport({ city: 'Delhi' }, mockFetch());
    const sent = trimForServer(report);
    const handler = createAdviceHandler({
      apiKey: 'k',
      allowedOrigins: ['https://pavithran-p12.github.io'],
      logger: silent,
      fetchImpl: async () =>
        jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(goodAdvice) }] } }] }),
    });
    const res = await handler(
      functionRequest('https://x.supabase.co/functions/v1/air-advice', {
        report: sent,
        profile: parseProfile({ household: ['children'] }),
      }),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.source, 'gemini');
    assert.ok(data.advice.routine.length >= 2);
  });
});

describe('contract: both providers produce one shape', () => {
  /** Every key, with nested object keys, so a missing or extra field shows up. */
  const shape = (o) =>
    Object.entries(o)
      .map(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? `${k}{${shape(v)}}` : k))
      .sort()
      .join(',');

  test('Google and Open-Meteo readings have identical fields', () => {
    const google = fromGoogle(googleResponse, { offsetSeconds: 19800 });
    const openMeteo = fromOpenMeteo(airResponse);
    // localIndex is null for Open-Meteo and source.fallback is added later, so compare the rest.
    const strip = ({ localIndex: _l, ...rest }) => rest;
    assert.equal(shape(strip(google)), shape(strip(openMeteo)));
  });

  test('Open-Meteo values that are not numbers become null, like Google', () => {
    const odd = { ...airResponse, current: { ...airResponse.current, pm10: 'n/a', ozone: undefined } };
    const air = fromOpenMeteo(odd);
    assert.equal(air.pollutants.pm10, null);
    assert.equal(air.pollutants.ozone, null);
  });

  test('no usable reading gives null, never a half-filled object', () => {
    assert.equal(fromOpenMeteo({}), null);
    assert.equal(fromOpenMeteo({ current: { time: '2026-11-26T10:00' } }), null);
    assert.equal(fromGoogle({ current: { pollutants: [] } }), null);
  });
});

describe('contract: reports with missing optional parts', () => {
  const base = { place: { name: 'Delhi' }, air: { usAqi: 180, cleanestHours: [] } };

  test('weather: null (weather service down) is accepted', () => {
    const r = sanitizeReport({ ...base, weather: null }, aqi);
    assert.deepEqual(r.weather, { temperature: null, wind: null, windAtBest: null, rainChanceMax24: null });
  });

  test('pollutants: null and a missing source are accepted', () => {
    const r = sanitizeReport({ ...base, air: { ...base.air, pollutants: null } }, aqi);
    assert.equal(r.air.pollutants.pm2_5, null);
    assert.equal(r.air.source.provider, 'open-meteo');
  });

  test('air-advice answers when the browser had no weather', async () => {
    const report = await getAirReport({ city: 'Delhi' }, mockFetch({ weather: null }));
    assert.equal(report.weather, null);
    const handler = createAdviceHandler({
      apiKey: 'k',
      allowedOrigins: ['https://pavithran-p12.github.io'],
      logger: silent,
      fetchImpl: async () =>
        jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(goodAdvice) }] } }] }),
    });
    const sent = trimForServer(report);
    const res = await handler(
      functionRequest('https://x.supabase.co/functions/v1/air-advice', { report: sent, profile: {} }),
    );
    assert.equal(res.status, 200);
  });
});
