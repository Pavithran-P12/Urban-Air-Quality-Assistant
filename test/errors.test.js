/**
 * Error handling: user-facing messages, sanitised logs, and friendly upstream failures.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocation } from '../docs/lib/validate.js';
import { getAirReport } from '../docs/lib/airQuality.js';
import {
  AppError,
  GENERIC_ERROR_MESSAGE,
  UpstreamError,
  ValidationError,
  describeForLog,
  toUserMessage,
} from '../docs/lib/errors.js';
import { mockFetch } from './fixtures.js';
import { AIR_DATA_URL, ORIGIN, functionRequest } from './helpers.js';

import { createAirDataHandler } from '../supabase/functions/air-data/handler.js';
import { createHandler as createAdviceHandler } from '../supabase/functions/air-advice/handler.js';
import { trimForServer } from '../docs/api.js';
describe('errors: user-facing messages and logs', () => {
  test('known app errors show their own message', () => {
    assert.equal(toUserMessage(new ValidationError('Please enter a city name.')), 'Please enter a city name.');
    assert.equal(toUserMessage(new UpstreamError('We couldn\'t find "Narnia".', 404)), 'We couldn\'t find "Narnia".');
    assert.ok(new ValidationError('x') instanceof AppError);
  });

  test('unexpected errors show a generic message', () => {
    assert.equal(
      toUserMessage(new TypeError("Cannot read properties of undefined (reading 'x')")),
      GENERIC_ERROR_MESSAGE,
    );
    assert.equal(toUserMessage('boom'), GENERIC_ERROR_MESSAGE);
    assert.equal(toUserMessage(undefined), GENERIC_ERROR_MESSAGE);
  });

  test('log summaries strip URLs, key-like values and stacks', () => {
    const err = new Error('fetch https://airquality.googleapis.com/v1/x?key=AIzaSECRET failed; token=abc123');
    const log = describeForLog(err);
    assert.equal(log.name, 'Error');
    assert.doesNotMatch(JSON.stringify(log), /googleapis|AIzaSECRET|abc123|at\s/);
    assert.ok(!('stack' in log));
    assert.equal(describeForLog(new UpstreamError('x', 404)).status, 404);
  });

  test('real failures surface as app errors with friendly text', async () => {
    assert.throws(
      () => parseLocation({ city: 'a' }),
      (e) => e instanceof AppError,
    );
    await assert.rejects(getAirReport({ city: 'Nowhere' }, mockFetch({ geocode: {} })), (e) => {
      assert.ok(e instanceof AppError);
      assert.doesNotMatch(toUserMessage(e), /http|undefined/);
      return true;
    });
    await assert.rejects(getAirReport({ city: 'Delhi' }, mockFetch({ fail: true })), (e) => e instanceof UpstreamError);
    const garbled = async () => ({ ok: true, status: 200, json: async () => JSON.parse('not json') });
    await assert.rejects(
      getAirReport({ city: 'Delhi' }, garbled),
      (e) => e instanceof UpstreamError && /could not read/.test(e.message),
    );
  });
});

describe('errors: Edge Function logs are sanitised', () => {
  const leaky = async () => {
    throw new Error('connect failed https://airquality.googleapis.com/v1/x?key=AIzaSECRET');
  };
  const collect = () => {
    const lines = [];
    return { lines, logger: { error: (...a) => lines.push(a.join(' ')), info: () => {} } };
  };

  test('air-data: a failed Google call logs no URL or key, and the client gets a generic 502', async () => {
    const { lines, logger } = collect();
    const handle = createAirDataHandler({ apiKey: 'k', allowedOrigins: [ORIGIN], logger, fetchImpl: leaky });
    const res = await handle(functionRequest(AIR_DATA_URL, { latitude: 13, longitude: 80 }));
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Air quality data unavailable for this location' });
    assert.ok(lines.length > 0);
    assert.ok(lines.every((l) => !l.includes('AIzaSECRET') && !l.includes('googleapis.com')));
  });

  test('air-advice: a failed Gemini call logs no URL or key, and the client gets a generic 502', async () => {
    const { lines, logger } = collect();
    const report = await getAirReport({ city: 'Delhi' }, mockFetch());
    const handle = createAdviceHandler({
      apiKey: 'k',
      allowedOrigins: [ORIGIN],
      logger,
      fetchImpl: leaky,
      retryDelayMs: 0,
    });
    const res = await handle(
      functionRequest('https://x.supabase.co/functions/v1/air-advice', { report: trimForServer(report), profile: {} }),
    );
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'AI service unavailable' });
    assert.ok(lines.every((l) => !l.includes('AIzaSECRET') && !l.includes('googleapis.com')));
  });
});
