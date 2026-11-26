import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { mockFetch } from './fixtures.js';

const silent = { error: () => {} };

async function start(deps) {
  const server = createApp({ logger: silent, ...deps }).listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, body) =>
  fetch(`${base}/api/advice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('API (rules fallback)', () => {
  let ctx;
  let upstream;
  before(async () => {
    upstream = mockFetch();
    ctx = await start({ fetchImpl: upstream });
  });
  after(() => ctx.server.close());

  test('health reports AI disabled', async () => {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.deepEqual(await res.json(), { status: 'ok', ai: false });
  });

  test('serves the frontend with security headers', async () => {
    const res = await fetch(`${ctx.base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Urban Air Quality Assistant/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('GET /api/air returns air data', async () => {
    const res = await fetch(`${ctx.base}/api/air?city=Delhi`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.air.usAqi, 245);
  });

  test('POST /api/advice returns rules-based advice and uses the cache', async () => {
    const before = upstream.calls.length;
    const res = await post(ctx.base, { location: { city: 'delhi' }, profile: { household: ['elderly'] } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.source, 'rules');
    assert.ok(body.advice.routine.length > 0);
    assert.equal(upstream.calls.length, before, 'second lookup for Delhi is served from cache');
  });

  test('invalid input returns 400', async () => {
    const res = await post(ctx.base, { location: {} });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /city/i);
  });

  test('oversized body is rejected', async () => {
    const res = await post(ctx.base, { location: { city: 'Delhi' }, profile: { question: 'x'.repeat(20000) } });
    assert.equal(res.status, 413);
  });

  test('unknown API route returns JSON 404', async () => {
    const res = await fetch(`${ctx.base}/api/nope`);
    assert.equal(res.status, 404);
  });
});

describe('API (with AI advisor)', () => {
  test('uses Gemini output when available', async () => {
    const advisor = async () => ({ summary: 'AI', riskNote: '', routine: [{}], indoor: [{}], alternatives: [], answer: '' });
    const ctx = await start({ fetchImpl: mockFetch(), advisor });
    try {
      const body = await (await post(ctx.base, { location: { city: 'Delhi' } })).json();
      assert.equal(body.source, 'gemini');
      assert.equal(body.advice.summary, 'AI');
    } finally {
      ctx.server.close();
    }
  });

  test('falls back to rules when Gemini fails', async () => {
    const advisor = async () => {
      throw new Error('quota');
    };
    const ctx = await start({ fetchImpl: mockFetch(), advisor });
    try {
      const res = await post(ctx.base, { location: { city: 'Delhi' } });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.source, 'rules');
    } finally {
      ctx.server.close();
    }
  });

  test('upstream outage returns 502 with a friendly message', async () => {
    const ctx = await start({ fetchImpl: mockFetch({ fail: true }) });
    try {
      const res = await post(ctx.base, { location: { city: 'Delhi' } });
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /unreachable/);
    } finally {
      ctx.server.close();
    }
  });
});
