/**
 * Page text built from data, without a browser: the forecast note, the wind and rain line, the
 * chart's accessible name and per-hour sentence, and the AI-fallback logging in api.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hoursNoteText, weatherLineText } from '../docs/views.js';
import { chartLabel, hourText } from '../docs/chart.js';
import { fetchAiAdvice, trimForServer } from '../docs/api.js';
import { getAirReport } from '../docs/lib/airQuality.js';
import { parseProfile } from '../docs/lib/validate.js';
import { mockFetch, goodAdvice } from './fixtures.js';
import { jsonResponse } from './helpers.js';

const delhi = () => getAirReport({ city: 'Delhi' }, mockFetch());

describe('views: forecast note', () => {
  test('names the cleanest hour when the air really improves', async () => {
    const { air } = await delhi();
    assert.match(
      hoursNoteText(air),
      /^The cleanest hour ahead is around \d+ (AM|PM), when the AQI should drop to about 120\./,
    );
  });

  test('says there is no forecast rather than "no improvement"', async () => {
    const { air } = await delhi();
    assert.match(hoursNoteText({ ...air, cleanestHours: [] }), /no hourly forecast/);
  });

  test('says the air will not get much better when the drop is small', async () => {
    const { air } = await delhi();
    assert.match(
      hoursNoteText({ ...air, outlook: { ...air.outlook, improves: false } }),
      /isn't expected to get much better/,
    );
  });
});

describe('views: wind and rain line', () => {
  const best = { time: '2026-11-26T14:00' };

  test('mentions wind now, wind at the cleanest hour and rain worth noting', () => {
    const text = weatherLineText({ temperature: 18, wind: 4.4, windAtBest: 13.6, rainChanceMax24: 40 }, best);
    assert.equal(
      text,
      "Wind and rain help clear smog: wind is 4 km/h now, 14 km/h around 2 PM, there's up to a 40% chance of rain.",
    );
  });

  test('leaves out small rain chances and missing values', () => {
    assert.equal(
      weatherLineText({ temperature: null, wind: 5, windAtBest: null, rainChanceMax24: 10 }, best),
      'Wind and rain help clear smog: wind is 5 km/h now.',
    );
  });

  test('is empty with no weather at all', () => {
    assert.equal(weatherLineText(null, undefined), '');
  });
});

describe('chart text', () => {
  const forecast = [
    { time: '2026-11-26T10:00', aqi: 180 },
    { time: '2026-11-26T11:00', aqi: 95 },
    { time: '2026-11-26T12:00', aqi: 260 },
  ];

  test('accessible name gives span, lowest and highest hour, and how to explore', () => {
    assert.equal(
      chartLabel(forecast),
      'AQI forecast for the next 3 hours. Lowest 95 on Thu at 11 AM; highest 260 on Thu at 12 PM. Use the arrow keys to step through hours, or open the table below.',
    );
  });

  test('each hour reads as a sentence, with wind only when known', () => {
    assert.equal(hourText(forecast[0], 7.6), 'Thu 10 AM: AQI 180, Unhealthy, wind 8 km/h');
    assert.equal(hourText(forecast[1], null), 'Thu 11 AM: AQI 95, Moderate');
  });
});

describe('api: AI plan request', () => {
  const profile = parseProfile({});

  test('sends the report without the 48-hour series', async () => {
    const report = await delhi();
    assert.equal(trimForServer(report).air.forecast, undefined);
    assert.ok(report.air.forecast.length > 0, 'the original report is not modified');
  });

  test('returns cleaned advice on success', async () => {
    const advice = await fetchAiAdvice(await delhi(), profile, {
      fetchImpl: async () => jsonResponse({ advice: goodAdvice, source: 'gemini' }),
    });
    assert.equal(advice.summary, goodAdvice.summary);
  });

  test('returns null and logs a sanitised line when the planner fails', async () => {
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args) };
    assert.equal(
      await fetchAiAdvice(await delhi(), profile, { fetchImpl: async () => jsonResponse({}, 503), logger }),
      null,
    );
    assert.equal(
      await fetchAiAdvice(await delhi(), profile, {
        fetchImpl: async () => {
          throw new Error('failed https://x.supabase.co/functions/v1/air-advice?token=abc');
        },
        logger,
      }),
      null,
    );
    assert.equal(warnings.length, 2);
    assert.match(warnings[0][1].message, /503/);
    assert.ok(!JSON.stringify(warnings).includes('token=abc') && !JSON.stringify(warnings).includes('supabase.co'));
  });
});
