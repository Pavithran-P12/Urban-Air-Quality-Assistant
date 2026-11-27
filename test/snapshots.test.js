/**
 * Behaviour snapshots: the normalised report, the exact Gemini prompt and the rules-engine plan
 * for a fixed set of places, households and AQI bands. Refactors must leave these unchanged.
 * To accept an intended change, review the diff and run: UPDATE_SNAPSHOTS=1 npm test
 */
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAirReport } from '../docs/lib/airQuality.js';
import { trimForServer } from '../docs/api.js';
import { buildPrompt, SYSTEM_INSTRUCTION, ADVICE_SCHEMA } from '../docs/lib/prompt.js';
import { buildRuleAdvice } from '../docs/lib/rules.js';
import { parseProfile, sanitizeReport } from '../docs/lib/validate.js';
import * as aqi from '../docs/lib/aqi.js';
import { mockFetch, airResponse, googleResponse } from './fixtures.js';
import { AIR_DATA_URL, matchSnapshot } from './helpers.js';

const FILE = fileURLToPath(new URL('./__snapshots__/behaviour.json', import.meta.url));
const snap = (key, value) => matchSnapshot(FILE, key, value);

/** What the browser sends to air-advice, as the server rebuilds it. */
const serverView = (report) => sanitizeReport(trimForServer(report), aqi);

const PROFILES = {
  default: parseProfile({}),
  sensitive: parseProfile({
    household: ['children', 'asthma-or-copd', 'elderly'],
    commute: 'two-wheeler',
    cooking: 'biomass',
    heating: 'wood',
    question: 'Can my kids play outside after school?',
  }),
  purifier: parseProfile({
    household: ['pregnant'],
    commute: 'car',
    cooking: 'lpg',
    heating: 'electric',
    hasPurifier: true,
  }),
};

const noForecast = { ...airResponse, hourly: { time: [], us_aqi: [] } };
const noUsAqi = { ...airResponse, current: { ...airResponse.current, us_aqi: undefined } };

const SCENARIOS = {
  'open-meteo city': () => getAirReport({ city: 'Delhi' }, mockFetch()),
  'google city': () =>
    getAirReport({ city: 'Delhi' }, mockFetch({ google: googleResponse }), { airDataUrl: AIR_DATA_URL }),
  'google coordinates': () =>
    getAirReport({ latitude: 28.6, longitude: 77.2 }, mockFetch({ google: googleResponse }), {
      airDataUrl: AIR_DATA_URL,
    }),
  'google failed, fallback': () => getAirReport({ city: 'Delhi' }, mockFetch(), { airDataUrl: AIR_DATA_URL }),
  'no hourly forecast': () => getAirReport({ city: 'Delhi' }, mockFetch({ air: noForecast })),
  'AQI estimated from PM2.5': () => getAirReport({ city: 'Delhi' }, mockFetch({ air: noUsAqi })),
};

describe('snapshot: shared AI contract', () => {
  test('system instruction and advice schema', () => {
    snap('system instruction', SYSTEM_INSTRUCTION);
    snap('advice schema', ADVICE_SCHEMA);
  });
});

for (const [name, load] of Object.entries(SCENARIOS)) {
  describe(`snapshot: ${name}`, () => {
    test('normalised report', async () => snap(`${name} / report`, await load()));
    for (const [who, profile] of Object.entries(PROFILES)) {
      test(`prompt and rules plan for ${who} household`, async () => {
        const report = await load();
        snap(`${name} / ${who} / prompt`, buildPrompt(serverView(report), profile));
        snap(`${name} / ${who} / rules`, buildRuleAdvice(report, profile));
      });
    }
  });
}

describe('snapshot: rules plan in every AQI band', () => {
  for (const usAqi of [30, 80, 130, 180, 250, 400]) {
    for (const [who, profile] of Object.entries(PROFILES)) {
      test(`AQI ${usAqi}, ${who} household`, async () => {
        const report = await SCENARIOS['open-meteo city']();
        report.air.usAqi = usAqi;
        report.air.category = aqi.categorize(usAqi);
        report.air.outlook = aqi.outlook(usAqi, report.air.cleanestHours);
        snap(`band ${usAqi} / ${who} / rules`, buildRuleAdvice(report, profile));
        snap(`band ${usAqi} / ${who} / prompt`, buildPrompt(serverView(report), profile));
      });
    }
  }
});

describe('snapshot: rules plan for every household option', () => {
  const OPTIONS = {
    commute: ['walk', 'cycle', 'public-transport', 'two-wheeler', 'car', 'work-from-home'],
    cooking: ['lpg', 'electric', 'induction', 'biomass', 'kerosene', 'piped-gas'],
    heating: ['none', 'electric', 'gas', 'wood', 'coal', 'kerosene'],
  };
  for (const usAqi of [40, 160, 320]) {
    for (const [field, values] of Object.entries(OPTIONS)) {
      for (const value of values) {
        for (const hasPurifier of [false, true]) {
          test(`AQI ${usAqi}, ${field}=${value}, purifier=${hasPurifier}`, async () => {
            const report = await SCENARIOS['open-meteo city']();
            report.air.usAqi = usAqi;
            report.air.category = aqi.categorize(usAqi);
            report.air.outlook = aqi.outlook(usAqi, report.air.cleanestHours);
            const profile = parseProfile({ [field]: value, hasPurifier, household: ['pregnant', 'heart-condition'] });
            snap(`matrix ${usAqi} / ${field}=${value} / purifier=${hasPurifier}`, buildRuleAdvice(report, profile));
          });
        }
      }
    }
  }
});
