/**
 * The exact request air-advice sends to Gemini: model path, headers, system instruction, prompt,
 * schema and generation settings. These values match commit 0eb5c8a; any change must be deliberate
 * (review the diff, then UPDATE_SNAPSHOTS=1 npm test).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHandler } from '../supabase/functions/air-advice/handler.js';
import { ADVICE_SCHEMA, SYSTEM_INSTRUCTION, buildPrompt } from '../docs/lib/prompt.js';
import { parseProfile, sanitizeReport } from '../docs/lib/validate.js';
import { getAirReport } from '../docs/lib/airQuality.js';
import { trimForServer } from '../docs/api.js';
import * as aqi from '../docs/lib/aqi.js';
import { mockFetch, goodAdvice } from './fixtures.js';
import { ORIGIN, functionRequest, jsonResponse, matchSnapshot, silent } from './helpers.js';

const FILE = fileURLToPath(new URL('./__snapshots__/gemini-request.json', import.meta.url));
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const PROFILE = { household: ['children'], commute: 'car', question: 'Can kids play outside?' };

/** Send one advice request and return what reached Gemini. */
async function captureGeminiCall(model) {
  const report = trimForServer(await getAirReport({ city: 'Delhi' }, mockFetch()));
  const calls = [];
  const handler = createHandler({
    apiKey: 'test-key',
    model,
    allowedOrigins: [ORIGIN],
    logger: silent,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(goodAdvice) }] } }] });
    },
  });
  const res = await handler(
    functionRequest('https://x.supabase.co/functions/v1/air-advice', { report, profile: PROFILE }),
  );
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  return { ...calls[0], report };
}

describe('Gemini request configuration', () => {
  test('default model path, POST, JSON, key in a header (never the URL), with a timeout', async () => {
    const { url, init } = await captureGeminiCall(undefined);
    assert.equal(url, `${GEMINI}/gemini-3.5-flash-lite:generateContent`);
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'x-goog-api-key': 'test-key' });
    assert.ok(!url.includes('test-key'));
    assert.ok(init.signal instanceof AbortSignal, 'request is abortable');
  });

  test('GEMINI_MODEL overrides the model, URL-encoded into the path', async () => {
    const { url } = await captureGeminiCall('gemini-test/model x');
    assert.equal(url, `${GEMINI}/gemini-test%2Fmodel%20x:generateContent`);
  });

  test('the body has exactly the system instruction, one user prompt and the generation config', async () => {
    const { body, report } = await captureGeminiCall(undefined);
    assert.deepEqual(Object.keys(body), ['systemInstruction', 'contents', 'generationConfig']);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: SYSTEM_INSTRUCTION }] });
    const prompt = buildPrompt(sanitizeReport(report, aqi), parseProfile(PROFILE));
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: prompt }] }]);
  });

  test('generation settings: JSON schema output, temperature 0.3, at most 2000 tokens', async () => {
    const { body } = await captureGeminiCall(undefined);
    assert.deepEqual(body.generationConfig, {
      responseMimeType: 'application/json',
      responseJsonSchema: ADVICE_SCHEMA,
      temperature: 0.3,
      maxOutputTokens: 2000,
    });
  });

  test('complete request body matches the recorded snapshot', async () => {
    const { body } = await captureGeminiCall(undefined);
    matchSnapshot(FILE, 'default model, Delhi, children + car + question', body);
  });
});
