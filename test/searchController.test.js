/**
 * The search controller, driven with a fake page: order of UI updates, one search at a time,
 * fallback to the rules engine, error messages and logging, and the report cache.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createReportCache, createSearchController, reportKey } from '../docs/searchController.js';
import { getAirReport, isCacheable } from '../docs/lib/airQuality.js';
import { buildRuleAdvice } from '../docs/lib/rules.js';
import { parseProfile } from '../docs/lib/validate.js';
import { UpstreamError, GENERIC_ERROR_MESSAGE } from '../docs/lib/errors.js';
import { mockFetch, googleResponse, goodAdvice } from './fixtures.js';
import { AIR_DATA_URL, ORIGIN, jsonResponse, silent } from './helpers.js';
import { fetchAiAdvice } from '../docs/api.js';
import { createHandler as createAdviceHandler } from '../supabase/functions/air-advice/handler.js';

/** A page stand-in that records every call in order. */
function fakeUi() {
  const calls = [];
  const record =
    (name) =>
    (...args) =>
      calls.push([name, ...args]);
  const ui = Object.fromEntries(
    [
      'clearErrors',
      'showPlace',
      'showFieldError',
      'showError',
      'setBusy',
      'checking',
      'writing',
      'showAir',
      'showAdvice',
      'showResults',
    ].map((n) => [n, record(n)]),
  );
  return { ui, calls, names: () => calls.map((c) => (c[0] === 'setBusy' ? `setBusy(${c[1]})` : c[0])) };
}

/** A deferred promise, to hold a search mid-flight. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const profile = parseProfile({ household: ['children'] });
const googleReport = () =>
  getAirReport({ city: 'Delhi' }, mockFetch({ google: googleResponse }), { airDataUrl: AIR_DATA_URL });

function makeController(overrides = {}) {
  const page = fakeUi();
  const logs = [];
  const deps = {
    getReport: async () => googleReport(),
    isCacheable,
    getAdvice: async () => goodAdvice,
    fallbackAdvice: buildRuleAdvice,
    cache: createReportCache({ ttlMs: 60_000 }),
    ui: page.ui,
    logger: { error: (...args) => logs.push(args) },
    ...overrides,
  };
  return { controller: createSearchController(deps), page, logs, deps };
}

describe('search controller: happy path', () => {
  test('updates the page in order and reports Gemini as the source', async () => {
    const { controller, page } = makeController();
    assert.equal(await controller.search({ place: { city: 'Delhi' }, profile }), 'done');
    assert.deepEqual(page.names(), [
      'clearErrors',
      'setBusy(true)',
      'checking',
      'showAir',
      'writing',
      'showAdvice',
      'setBusy(false)',
      'showResults',
    ]);
    const advice = page.calls.find((c) => c[0] === 'showAdvice');
    assert.equal(advice[2], 'gemini');
    assert.equal(controller.busy, false);
  });

  test('falls back to the rules engine when the AI returns nothing', async () => {
    const { controller, page } = makeController({ getAdvice: async () => null });
    await controller.search({ place: { city: 'Delhi' }, profile });
    const [, advice, source] = page.calls.find((c) => c[0] === 'showAdvice');
    assert.equal(source, 'rules');
    assert.ok(advice.summary.startsWith('Air in Delhi'));
  });

  test('passes the validated location to showResults (for the address bar)', async () => {
    const { controller, page } = makeController();
    await controller.search({ place: { city: '  Delhi  ' }, profile });
    const [, , location] = page.calls.find((c) => c[0] === 'showResults');
    assert.deepEqual(location, { city: 'Delhi' });
  });
});

describe('search controller: one search at a time', () => {
  test('a second search while one is running is ignored and makes no request', async () => {
    const gate = deferred();
    let requests = 0;
    const { controller, page } = makeController({
      getReport: async () => {
        requests += 1;
        await gate.promise;
        return googleReport();
      },
    });
    const first = controller.search({ place: { city: 'Chennai' }, profile });
    assert.equal(controller.busy, true);
    assert.equal(await controller.search({ place: { city: 'Delhi' }, profile }), 'busy');
    gate.resolve();
    assert.equal(await first, 'done');
    assert.equal(requests, 1);
    assert.equal(page.names().filter((n) => n === 'setBusy(true)').length, 1);
  });

  test('busy is cleared after a failure, so the next search runs', async () => {
    let fail = true;
    const { controller } = makeController({
      getReport: async () => {
        if (fail) throw new UpstreamError('Air quality service is unreachable right now.');
        return googleReport();
      },
    });
    assert.equal(await controller.search({ place: { city: 'Delhi' }, profile }), 'failed');
    assert.equal(controller.busy, false);
    fail = false;
    assert.equal(await controller.search({ place: { city: 'Delhi' }, profile }), 'done');
  });
});

describe('search controller: errors', () => {
  test('an invalid place shows a field error and never starts loading', async () => {
    let requested = false;
    const { controller, page } = makeController({ getReport: async () => (requested = true) });
    assert.equal(await controller.search({ place: { city: 'x' }, profile }), 'invalid');
    assert.deepEqual(page.names(), ['clearErrors', 'showFieldError']);
    assert.match(page.calls[1][1], /at least 2 characters/);
    assert.equal(requested, false);
  });

  test('a known failure shows its own message and unlocks the page', async () => {
    const { controller, page } = makeController({
      getReport: async () => {
        throw new UpstreamError('We couldn\'t find "Atlantis".', 404);
      },
    });
    await controller.search({ place: { city: 'Atlantis' }, profile });
    assert.deepEqual(page.names().slice(-2), ['setBusy(false)', 'showError']);
    assert.equal(page.calls.at(-1)[1], 'We couldn\'t find "Atlantis".');
  });

  test('an unexpected failure shows the generic message and logs only a sanitised summary', async () => {
    const { controller, page, logs } = makeController({
      getReport: async () => {
        throw new TypeError('boom at https://example.com/x?key=SECRET123');
      },
    });
    await controller.search({ place: { city: 'Delhi' }, profile });
    assert.equal(page.calls.at(-1)[1], GENERIC_ERROR_MESSAGE);
    const logged = JSON.stringify(logs);
    assert.ok(!logged.includes('SECRET123') && !logged.includes('example.com'));
    assert.ok(!logged.includes('stack'));
  });
});

describe('search controller: report cache', () => {
  test('a complete Google report is reused for the same city in any case', async () => {
    let requests = 0;
    const { controller } = makeController({
      getReport: async () => {
        requests += 1;
        return googleReport();
      },
    });
    await controller.search({ place: { city: 'Delhi' }, profile });
    await controller.search({ place: { city: 'DELHI' }, profile });
    assert.equal(requests, 1);
  });

  test('a fallback report is never reused', async () => {
    let requests = 0;
    const { controller } = makeController({
      getReport: async () => {
        requests += 1;
        return getAirReport({ city: 'Delhi' }, mockFetch(), { airDataUrl: AIR_DATA_URL });
      },
    });
    await controller.search({ place: { city: 'Delhi' }, profile });
    await controller.search({ place: { city: 'Delhi' }, profile });
    assert.equal(requests, 2);
  });

  test('entries expire, and the cache keeps at most `max` places', () => {
    let t = 0;
    const cache = createReportCache({ ttlMs: 1000, max: 2, now: () => t });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.equal(cache.size, 2);
    assert.equal(cache.get('a'), undefined, 'oldest dropped');
    t = 1000;
    assert.equal(cache.get('b'), undefined, 'expired');
  });

  test('cache keys: city in any case, coordinates to ~100 m', () => {
    assert.equal(reportKey({ city: 'Delhi' }), reportKey({ city: 'delhi' }));
    assert.equal(reportKey({ latitude: 28.61234, longitude: 77.2 }), 'g:28.612,77.200');
  });
});

describe('search controller: the place shown always matches the running search', () => {
  /** A controller whose first search is held open until `release()`. */
  function heldController() {
    const gate = deferred();
    let requests = 0;
    const made = makeController({
      getReport: async () => {
        requests += 1;
        await gate.promise;
        return googleReport();
      },
    });
    return { ...made, release: gate.resolve, requests: () => requests };
  }
  const shown = (page) => page.calls.filter((c) => c[0] === 'showPlace').map((c) => c[1]);

  test('a quick-city tap is shown only once its search is accepted, before loading starts', async () => {
    const { controller, page } = makeController();
    await controller.search({ place: { city: 'Mumbai' }, profile, label: 'Mumbai' });
    assert.deepEqual(page.names().slice(0, 3), ['clearErrors', 'showPlace', 'setBusy(true)']);
    assert.deepEqual(page.calls[1], ['showPlace', 'Mumbai', { city: 'Mumbai' }]);
  });

  test('a quick-city tap during a search changes nothing and starts nothing', async () => {
    const { controller, page, release, requests } = heldController();
    const running = controller.search({ place: { city: 'Chennai' }, profile, label: 'Chennai' });
    const before = page.calls.length;
    assert.equal(await controller.search({ place: { city: 'Delhi' }, profile, label: 'Delhi' }), 'busy');
    assert.equal(page.calls.length, before, 'no UI call at all for the ignored tap');
    release();
    await running;
    assert.deepEqual(shown(page), ['Chennai']);
    assert.equal(requests(), 1);
  });

  test('a location answer arriving during a search changes nothing', async () => {
    const { controller, page, release } = heldController();
    const running = controller.search({ place: { city: 'Chennai' }, profile, label: 'Chennai' });
    const late = await controller.search({ place: { latitude: 28.6, longitude: 77.2 }, profile, label: 'Where I am' });
    assert.equal(late, 'busy');
    release();
    await running;
    assert.deepEqual(shown(page), ['Chennai'], '"Where I am" never replaced the running city');
  });

  test('an accepted location search passes its coordinates, so the page can remember them', async () => {
    const { controller, page } = makeController();
    await controller.search({ place: { latitude: 28.6, longitude: 77.2 }, profile, label: 'Where I am' });
    assert.deepEqual(page.calls[1], ['showPlace', 'Where I am', { latitude: 28.6, longitude: 77.2 }]);
  });

  test('the place handed to the page is the validated one (trimmed city, numeric coordinates)', async () => {
    const { controller, page } = makeController();
    await controller.search({ place: { city: '  Mumbai  ' }, profile, label: 'Mumbai' });
    await controller.search({ place: { latitude: '28.6', longitude: '77.2' }, profile, label: 'Where I am' });
    const places = page.calls.filter((c) => c[0] === 'showPlace').map((c) => c[2]);
    assert.deepEqual(places, [{ city: 'Mumbai' }, { latitude: 28.6, longitude: 77.2 }]);
  });

  test('a typed search (no label) and an invalid place never rewrite the box', async () => {
    const { controller, page } = makeController();
    await controller.search({ place: { city: 'Delhi' }, profile });
    await controller.search({ place: { city: 'x' }, profile, label: 'x' });
    assert.deepEqual(shown(page), []);
  });
});

describe('search controller: AI planner returns nothing usable', () => {
  test('empty Gemini content: one retry, a 502, then the page shows the rules-engine plan', async () => {
    let geminiCalls = 0;
    const adviceFunction = createAdviceHandler({
      apiKey: 'k',
      allowedOrigins: [ORIGIN],
      logger: silent,
      retryDelayMs: 0,
      fetchImpl: async () => {
        geminiCalls += 1;
        return jsonResponse({ candidates: [{ finishReason: 'SAFETY' }] });
      },
    });
    // The browser's real client, talking to the real Edge Function handler.
    const toFunction = (url, init) =>
      adviceFunction(
        new Request(url, { ...init, headers: { ...init.headers, origin: ORIGIN, 'cf-connecting-ip': '1.2.3.4' } }),
      );
    const warnings = [];
    const { controller, page } = makeController({
      getAdvice: (report, prof) =>
        fetchAiAdvice(report, prof, { fetchImpl: toFunction, logger: { warn: (...a) => warnings.push(a) } }),
    });
    assert.equal(await controller.search({ place: { city: 'Delhi' }, profile }), 'done');
    assert.equal(geminiCalls, 2);
    const [, advice, source] = page.calls.find((c) => c[0] === 'showAdvice');
    assert.equal(source, 'rules');
    assert.ok(advice.summary.startsWith('Air in Delhi'));
    assert.equal(warnings.length, 1, 'the fallback is logged once');
  });
});
