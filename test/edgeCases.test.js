/**
 * Edge cases in long-standing behaviour that had no test: forecast paging, empty Gemini answers,
 * a non-PM2.5 main pollutant, implausible AQI values, half a coordinate pair and thin advice.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAirDataHandler } from '../supabase/functions/air-data/handler.js';
import { createHandler as createAdviceHandler } from '../supabase/functions/air-advice/handler.js';
import { fromGoogle } from '../docs/lib/normalise.js';
import { buildPrompt } from '../docs/lib/prompt.js';
import { parseLocation, parseProfile, sanitizeReport, ValidationError } from '../docs/lib/validate.js';
import { normaliseAdvice, AdviceError } from '../docs/lib/advice.js';
import { getAirReport } from '../docs/lib/airQuality.js';
import { trimForServer } from '../docs/api.js';
import * as aqi from '../docs/lib/aqi.js';
import { googleResponse, mockFetch, goodAdvice } from './fixtures.js';
import { AIR_DATA_URL, ORIGIN, functionRequest, googleApi, jsonResponse, silent } from './helpers.js';

describe('air-data: forecast paging', () => {
  test('a short page with no next-page token makes exactly one forecast call', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return jsonResponse(String(url).includes('currentConditions') ? googleApi.current : googleApi.hours(20, 1));
    };
    const handle = createAirDataHandler({ apiKey: 'k', allowedOrigins: [ORIGIN], logger: silent, fetchImpl });
    const res = await handle(functionRequest(AIR_DATA_URL, { latitude: 13, longitude: 80 }));
    const body = await res.json();
    assert.equal(calls.filter((u) => u.includes('forecast')).length, 1, 'no second (billable) page request');
    assert.equal(body.hourly.length, 20, 'no duplicated hours');
    assert.equal(body.forecastComplete, false);
  });
});

describe('air-advice: Gemini answers with no content', () => {
  for (const [name, reply] of [
    ['no candidates', { candidates: [] }],
    ['a safety block without content', { candidates: [{ finishReason: 'SAFETY' }] }],
    ['content without parts', { candidates: [{ content: {} }] }],
  ]) {
    test(`${name}: retried once, then a 502 so the browser falls back to the rules engine`, async () => {
      let calls = 0;
      const handle = createAdviceHandler({
        apiKey: 'k',
        allowedOrigins: [ORIGIN],
        logger: silent,
        retryDelayMs: 0,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(reply);
        },
      });
      const report = await getAirReport({ city: 'Delhi' }, mockFetch());
      const res = await handle(
        functionRequest('https://x.supabase.co/functions/v1/air-advice', {
          report: trimForServer(report),
          profile: {},
        }),
      );
      assert.equal(calls, 2, 'one retry');
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: 'AI service unavailable' });
    });
  }
});

describe('Google: main pollutant other than PM2.5', () => {
  const withDominant = (code) => ({
    ...googleResponse,
    current: { ...googleResponse.current, localIndex: { ...googleResponse.current.localIndex, dominant: code } },
  });

  test('its sub-index is null, never borrowed from the PM2.5-based US AQI', () => {
    const air = fromGoogle(withDominant('no2'), { offsetSeconds: 19800 });
    assert.deepEqual(air.dominant, { key: 'nitrogen_dioxide', name: 'NO₂ (traffic exhaust)', aqi: null });
  });

  test('the prompt names it without inventing a sub-index', () => {
    const air = fromGoogle(withDominant('o3'), { offsetSeconds: 19800 });
    const prompt = buildPrompt({ place: { name: 'Delhi' }, air, weather: null }, parseProfile({}));
    assert.match(prompt, /^Main pollutant: Ozone \(sunlight smog\)$/m);
  });

  test('an unknown code gives no main pollutant rather than a wrong one', () => {
    assert.equal(fromGoogle(withDominant('xyz'), { offsetSeconds: 19800 }).dominant, null);
  });
});

describe('validation edge cases', () => {
  const report = (usAqi) => ({ place: { name: 'Delhi' }, air: { usAqi, cleanestHours: [] } });

  test('an AQI above 1,000 is rejected; 1,000 itself is accepted', () => {
    assert.throws(() => sanitizeReport(report(1001), aqi), ValidationError);
    assert.throws(() => sanitizeReport(report(5000), aqi), /missing or invalid/);
    assert.equal(sanitizeReport(report(1000), aqi).air.usAqi, 1000);
  });

  test('only one coordinate is not treated as a location', () => {
    assert.throws(() => parseLocation({ latitude: 12.97 }), /city name/);
    assert.throws(() => parseLocation({ longitude: 77.59 }), /city name/);
    assert.throws(() => parseLocation({ latitude: 12.97, longitude: '' }), /city name/);
    assert.deepEqual(parseLocation({ latitude: 12.97, city: 'Bengaluru' }), { city: 'Bengaluru' });
  });
});

describe('advice: too thin to show', () => {
  test('exactly one routine step is rejected; two are accepted', () => {
    const oneStep = { ...goodAdvice, routine: goodAdvice.routine.slice(0, 1) };
    assert.throws(() => normaliseAdvice(oneStep), AdviceError);
    assert.equal(normaliseAdvice(goodAdvice).routine.length, 2);
  });

  test('exactly one indoor tip is rejected', () => {
    assert.throws(() => normaliseAdvice({ ...goodAdvice, indoor: goodAdvice.indoor.slice(0, 1) }), /incomplete/);
  });
});

describe('air-data: time budget already spent', () => {
  test('budgetMs: 0 dispatches zero Google requests (current conditions and forecast) and answers 502', async () => {
    const sent = { current: 0, forecast: 0, other: 0 };
    // A fetch that ignores abort signals, so any request that is started gets counted.
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('currentConditions')) sent.current += 1;
      else if (u.includes('forecast')) sent.forecast += 1;
      else sent.other += 1;
      return jsonResponse(u.includes('currentConditions') ? googleApi.current : googleApi.hours(48, 1));
    };
    const errors = [];
    const handle = createAirDataHandler({
      apiKey: 'k',
      allowedOrigins: [ORIGIN],
      logger: { error: (line) => errors.push(line), info: () => {} },
      fetchImpl,
      budgetMs: 0,
    });
    const res = await handle(functionRequest(AIR_DATA_URL, { latitude: 13, longitude: 80 }));
    assert.deepEqual(sent, { current: 0, forecast: 0, other: 0 });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Air quality data unavailable for this location' });
    assert.ok(
      errors.some((line) => line.includes('time budget exhausted')),
      'the reason is logged',
    );
  });
});
