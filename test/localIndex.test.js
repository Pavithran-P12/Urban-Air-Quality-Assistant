/**
 * Local index (e.g. India's NAQI): only complete values are kept, converted and shown.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fromGoogle, validLocalIndex } from '../docs/lib/normalise.js';
import { sanitizeReport } from '../docs/lib/validate.js';
import { localIndexText } from '../docs/views.js';
import { googleResponse } from './fixtures.js';
import * as aqi from '../docs/lib/aqi.js';

describe('local index: incomplete values', () => {
  test('validLocalIndex keeps only complete indexes', () => {
    assert.deepEqual(validLocalIndex({ code: 'ind_cpcb', name: 'AQI (IN)', aqi: 124, category: 'Moderate' }), {
      code: 'ind_cpcb',
      name: 'AQI (IN)',
      aqi: 124,
      category: 'Moderate',
    });
    assert.equal(validLocalIndex({ name: 'AQI (IN)', aqi: 124 }), null, 'missing category');
    assert.equal(validLocalIndex({ aqi: 124, category: 'Moderate' }), null, 'missing name');
    assert.equal(validLocalIndex({ name: ' ', aqi: 124, category: 'Moderate' }), null, 'blank name');
    assert.equal(validLocalIndex({ name: 'AQI (IN)', aqi: '124', category: 'Moderate' }), null, 'non-numeric value');
    assert.equal(validLocalIndex(null), null);
  });

  test('fromGoogle drops a partial local index but keeps the main pollutant', () => {
    const g = structuredClone(googleResponse);
    delete g.current.localIndex.category;
    const air = fromGoogle(g, { offsetSeconds: 19800 });
    assert.equal(air.localIndex, null);
    assert.equal(air.dominant.key, 'pm2_5');
  });

  test('fromGoogle survives incomplete responses', () => {
    assert.equal(fromGoogle({}), null);
    assert.equal(fromGoogle({ current: {} }), null);
    assert.equal(fromGoogle({ current: { pollutants: 'oops' } }), null);
    const noHourly = structuredClone(googleResponse);
    delete noHourly.hourly;
    const air = fromGoogle(noHourly, { offsetSeconds: 19800 });
    assert.deepEqual(air.forecast, []);
    assert.deepEqual(air.cleanestHours, []);
  });

  test('the server sanitiser drops an incomplete local index', () => {
    const report = { place: { name: 'X' }, air: { usAqi: 100, localIndex: { name: 'AQI (IN)', aqi: 90 } } };
    assert.equal(sanitizeReport(report, aqi).air.localIndex, null);
  });

  test('localIndexText never shows "undefined"', () => {
    assert.equal(localIndexText({ name: 'AQI (IN)', aqi: 124 }), '');
    assert.equal(localIndexText({ aqi: 124, category: 'Moderate' }), '');
    assert.equal(localIndexText(null), '');
    assert.equal(
      localIndexText({ code: 'ind_cpcb', name: 'AQI (IN)', aqi: 124, category: 'Moderate air quality' }),
      "India's official index (NAQI) reads 124: moderate air quality.",
    );
    assert.equal(
      localIndexText({ code: 'usa_epa', name: 'AQI (US)', aqi: 40, category: 'Good' }),
      'The local index (AQI (US)) reads 40: good.',
    );
  });
});
