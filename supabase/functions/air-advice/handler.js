/**
 * Runtime-agnostic request handler for the air-advice Edge Function.
 * Keeps the Gemini API key on the server. Pure (fetch, clock and config are injected) so it can be
 * unit-tested in Node and served by Deno on Supabase.
 */
import { ADVICE_SCHEMA, SYSTEM_INSTRUCTION, buildPrompt } from '../../../docs/lib/prompt.js';
import * as aqi from '../../../docs/lib/aqi.js';
import { parseProfile, sanitizeReport } from '../../../docs/lib/validate.js';
import { AdviceError, normaliseAdvice } from '../../../docs/lib/advice.js';
import { describeForLog } from '../../../docs/lib/errors.js';
import { corsFor, createRateLimiter, readJson, rejectRequest } from '../_shared/http.js';

export { createRateLimiter };

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_BODY_BYTES = 10_000;
const GEMINI_TIMEOUT_MS = 20_000;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const GATE_MESSAGES = { notConfigured: 'AI is not configured', tooMany: 'Too many requests. Please wait a minute.' };

class GeminiError extends Error {
  constructor(message, retryable) {
    super(message);
    this.name = 'GeminiError';
    this.retryable = retryable;
  }
}

/** The generateContent request body: system rules, the grounded prompt and a strict JSON schema. */
function geminiBody(report, profile) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: buildPrompt(report, profile) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: ADVICE_SCHEMA,
      temperature: 0.3, // low, for factual consistency
      maxOutputTokens: 2000,
    },
  };
}

/** The model's text, joined across parts ('' when there is none). */
function responseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((p) => p?.text ?? '').join('') : '';
}

/** Parse and fact-check the model's JSON. Malformed or ungrounded output is worth one more try. */
function parseAdvice(text, air) {
  try {
    return normaliseAdvice(JSON.parse(text), air);
  } catch (err) {
    throw new GeminiError(err instanceof AdviceError ? err.message : 'Gemini returned invalid JSON', true);
  }
}

/** One Gemini call. Network failures, retryable statuses and empty or bad output are retryable. */
async function requestGemini({ report, profile, apiKey, model, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      body: JSON.stringify(geminiBody(report, profile)),
    });
  } catch (err) {
    throw new GeminiError(`Gemini unreachable: ${err.message}`, true);
  }
  if (!res.ok) throw new GeminiError(`Gemini returned ${res.status}`, RETRYABLE.has(res.status));
  const text = responseText(await res.json());
  if (!text) throw new GeminiError('Gemini returned no content', true);
  return parseAdvice(text, report.air);
}

/**
 * Call Gemini, retrying once on transient errors or ungrounded output.
 * @returns {Promise<object>} normalised advice
 */
export async function callGemini({ report, profile, apiKey, model, fetchImpl, retryDelayMs = 600 }) {
  try {
    return await requestGemini({ report, profile, apiKey, model, fetchImpl });
  } catch (err) {
    if (!err.retryable) throw err;
    await new Promise((r) => setTimeout(r, retryDelayMs));
    return requestGemini({ report, profile, apiKey, model, fetchImpl });
  }
}

/**
 * Build the request handler.
 * @param {{apiKey?:string, model?:string, allowedOrigins:string[], fetchImpl?:typeof fetch,
 *   logger?:Pick<Console,'error'>, rateLimiter?:(key:string)=>boolean, retryDelayMs?:number}} cfg
 * @returns {(req: Request) => Promise<Response>}
 */
export function createHandler({
  apiKey,
  model = DEFAULT_MODEL,
  allowedOrigins,
  fetchImpl = fetch,
  logger = console,
  rateLimiter = createRateLimiter(),
  retryDelayMs,
}) {
  return async function handle(req) {
    const cors = corsFor(req, allowedOrigins);
    const { json } = cors;
    const rejected = rejectRequest(req, { cors, configured: Boolean(apiKey), rateLimiter, messages: GATE_MESSAGES });
    if (rejected) return rejected;

    const { body, error } = await readJson(req, MAX_BODY_BYTES);
    if (error) return json(error.status, { error: error.message });

    let report;
    try {
      report = sanitizeReport(body?.report, aqi);
    } catch (err) {
      return json(400, { error: err.message });
    }
    const profile = parseProfile(body?.profile);

    try {
      const advice = await callGemini({ report, profile, apiKey, model, fetchImpl, retryDelayMs });
      return json(200, { advice, source: 'gemini' });
    } catch (err) {
      logger.error(JSON.stringify({ fn: 'air-advice', error: describeForLog(err) }));
      return json(502, { error: 'AI service unavailable' });
    }
  };
}
