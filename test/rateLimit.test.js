/**
 * Rate limiting keys on platform-set client IP headers and cannot be escaped by spoofing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UNKNOWN_CLIENT, clientIp, createRateLimiter, isIpAddress } from '../supabase/functions/_shared/http.js';
import { createAirDataHandler } from '../supabase/functions/air-data/handler.js';
import { AIR_DATA_URL, ORIGIN, jsonResponse, silent } from './helpers.js';

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

describe('rate limit: client key cannot be spoofed', () => {
  const req = (headers) => new Request('https://x.example/', { headers });

  test('uses the platform headers, never X-Forwarded-For', () => {
    assert.equal(
      clientIp(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1, 203.0.113.7' })),
      '203.0.113.7',
    );
    assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.8', 'x-forwarded-for': '9.9.9.9' })), '203.0.113.8');
    assert.equal(clientIp(req({ 'x-forwarded-for': '9.9.9.9' })), UNKNOWN_CLIENT, 'XFF alone is not trusted');
    assert.equal(clientIp(req({})), UNKNOWN_CLIENT);
  });

  test('ignores malformed values in trusted headers', () => {
    assert.equal(clientIp(req({ 'cf-connecting-ip': '1.2.3.4, 5.6.7.8', 'x-real-ip': '203.0.113.9' })), '203.0.113.9');
    assert.equal(clientIp(req({ 'cf-connecting-ip': 'evil' })), UNKNOWN_CLIENT);
    assert.equal(isIpAddress('2001:db8::1'), true);
    assert.equal(isIpAddress('999.1.1.1'), false);
  });

  test('rotating X-Forwarded-For does not escape the limit', async () => {
    const handle = createAirDataHandler({
      apiKey: 'k',
      allowedOrigins: [ORIGIN],
      logger: silent,
      rateLimiter: createRateLimiter({ limit: 2 }),
      fetchImpl: async (url) => jsonResponse(url.includes('current') ? googleCurrent : googleHours(48)),
    });
    const send = (xff) =>
      handle(
        new Request(AIR_DATA_URL, {
          method: 'POST',
          headers: { origin: ORIGIN, 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': xff },
          body: JSON.stringify({ latitude: 13, longitude: 80 }),
        }),
      );
    assert.equal((await send('10.0.0.1')).status, 200);
    assert.equal((await send('10.0.0.2')).status, 200);
    assert.equal((await send('10.0.0.3')).status, 429, 'a new spoofed XFF is still the same client');
  });
});
