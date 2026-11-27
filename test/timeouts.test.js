/**
 * Timeout budget and caching: partial answers are shown but never cached, slow calls fall back.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile, sanitizeReport } from '../docs/lib/validate.js';
import { getAirReport, isCacheable } from '../docs/lib/airQuality.js';
import { buildPrompt } from '../docs/lib/prompt.js';
import { buildRuleAdvice } from '../docs/lib/rules.js';
import { createAirDataHandler } from '../supabase/functions/air-data/handler.js';
import { googleResponse, mockFetch } from './fixtures.js';
import { AIR_DATA_URL, ORIGIN, jsonResponse, silent, slowFetch } from './helpers.js';
import { fetchGoogleAir as fetchGoogleAirBrowser } from '../docs/lib/airQuality.js';
import { lookupGoogleAir as fetchGoogleAirServer } from '../supabase/functions/air-data/handler.js';
import * as aqi from '../docs/lib/aqi.js';

const googleCurrent = {
  dateTime: '2026-11-26T04:00:00Z',
  indexes: [{ code: 'ind_cpcb', displayName: 'AQI (IN)', aqi: 300, category: 'Very poor', dominantPollutant: 'pm25' }],
  pollutants: [{ code: 'pm25', concentration: { value: 140, units: 'MICROGRAMS_PER_CUBIC_METER' } }],
};
const googleHours = (n, offset = 0) => ({
  hourlyForecasts: Array.from({ length: n }, (_, i) => ({
    dateTime: new Date(Date.UTC(2026, 10, 26, i + offset)).toISOString(),
    pollutants: [{ code: 'pm25', concentration: { value: 90, units: 'MICROGRAMS_PER_CUBIC_METER' } }],
  })),
});

describe('timeouts and caching', () => {
  test('a slow forecast returns current conditions within budget, marked incomplete', async () => {
    const started = Date.now();
    const data = await fetchGoogleAirServer({
      latitude: 13,
      longitude: 80,
      apiKey: 'k',
      budgetMs: 80,
      logger: silent,
      fetchImpl: (url, init) =>
        url.includes('current')
          ? Promise.resolve(jsonResponse(googleCurrent))
          : slowFetch(1000, () => jsonResponse(googleHours(48)))(url, init),
    });
    assert.ok(Date.now() - started < 500, 'aborted at the budget, not after the slow call');
    assert.equal(data.current.localIndex.aqi, 300);
    assert.equal(data.hourly.length, 0);
    assert.equal(data.forecastComplete, false);
  });

  test('slow current conditions fail fast with a 502', async () => {
    const handle = createAirDataHandler({
      apiKey: 'k',
      allowedOrigins: [ORIGIN],
      logger: silent,
      budgetMs: 60,
      fetchImpl: slowFetch(1000, () => jsonResponse(googleCurrent)),
    });
    const started = Date.now();
    const res = await handle(
      new Request(AIR_DATA_URL, {
        method: 'POST',
        headers: { origin: ORIGIN },
        body: JSON.stringify({ latitude: 1, longitude: 1 }),
      }),
    );
    assert.equal(res.status, 502);
    assert.ok(Date.now() - started < 500);
  });

  test('a failed second forecast page keeps the first page', async () => {
    let page = 0;
    const data = await fetchGoogleAirServer({
      latitude: 13,
      longitude: 80,
      apiKey: 'k',
      logger: silent,
      fetchImpl: async (url) => {
        if (url.includes('current')) return jsonResponse(googleCurrent);
        page += 1;
        return page === 1 ? jsonResponse({ ...googleHours(24), nextPageToken: 't' }) : jsonResponse({}, 503);
      },
    });
    assert.equal(data.hourly.length, 24);
    assert.equal(data.forecastComplete, true);
  });

  test('incomplete answers are not cached; complete ones are', async () => {
    let forecastOk = false;
    const fetchImpl = async (url) =>
      url.includes('current')
        ? jsonResponse(googleCurrent)
        : forecastOk
          ? jsonResponse(googleHours(48))
          : jsonResponse({}, 503);
    const handle = createAirDataHandler({ apiKey: 'k', allowedOrigins: [ORIGIN], logger: silent, fetchImpl });
    const send = () =>
      handle(
        new Request(AIR_DATA_URL, {
          method: 'POST',
          headers: { origin: ORIGIN },
          body: JSON.stringify({ latitude: 13, longitude: 80 }),
        }),
      );
    assert.equal((await send()).headers.get('x-cache'), 'MISS');
    forecastOk = true;
    assert.equal((await send()).headers.get('x-cache'), 'MISS', 'the partial answer was not cached');
    assert.equal((await send()).headers.get('x-cache'), 'HIT');
  });

  test('the browser gives up on a slow air-data call and falls back, labelled', async () => {
    const base = mockFetch({ google: googleResponse });
    const fetchImpl = (url, init) =>
      String(url).includes('air-data')
        ? slowFetch(1000, () => jsonResponse(googleResponse))(url, init)
        : base(url, init);
    const started = Date.now();
    assert.equal(
      await fetchGoogleAirBrowser(AIR_DATA_URL, { latitude: 1, longitude: 2 }, { fetchImpl, timeoutMs: 50 }),
      null,
    );
    assert.ok(Date.now() - started < 500);

    const report = await getAirReport({ city: 'Delhi' }, fetchImpl, { airDataUrl: AIR_DATA_URL, airDataTimeoutMs: 50 });
    assert.equal(report.air.source.provider, 'open-meteo');
    assert.equal(report.air.source.fallback, true);
    assert.match(report.air.source.fallbackReason, /wasn't available/);
    assert.equal(sanitizeReport(report, aqi).air.source.fallback, undefined, 'the server re-derives labels');
  });

  test('only complete, non-fallback reports are cacheable in the browser', async () => {
    const good = await getAirReport({ city: 'Delhi' }, mockFetch({ google: googleResponse }), {
      airDataUrl: AIR_DATA_URL,
    });
    assert.equal(isCacheable(good), true);
    const fallback = await getAirReport({ city: 'Delhi' }, mockFetch({ google: null }), { airDataUrl: AIR_DATA_URL });
    assert.equal(isCacheable(fallback), false);
    const partial = structuredClone(good);
    partial.air.forecast = partial.air.forecast.slice(0, 5);
    assert.equal(isCacheable(partial), false);
  });

  test('no forecast is never described as "no improvement"', async () => {
    const report = await getAirReport({ city: 'Delhi' }, mockFetch({ google: { ...googleResponse, hourly: [] } }), {
      airDataUrl: AIR_DATA_URL,
    });
    assert.deepEqual(report.air.cleanestHours, []);
    const prompt = buildPrompt(sanitizeReport(report, aqi), parseProfile({}));
    assert.match(prompt, /No hourly forecast is available/);
    const advice = buildRuleAdvice(report, parseProfile({}));
    assert.ok(advice.routine.some((s) => /no hourly forecast/i.test(s.why)));
  });
});
