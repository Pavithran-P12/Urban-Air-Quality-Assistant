/**
 * Runtime-agnostic request handler for the air-advice Edge Function.
 * Keeps the Gemini API key on the server. Pure (fetch and config are injected) so it can be
 * unit-tested in Node and served by Deno on Supabase.
 */
import { ADVICE_SCHEMA, SYSTEM_INSTRUCTION, buildPrompt } from '../../../docs/lib/prompt.js';
import { categorize } from '../../../docs/lib/aqi.js';
import { parseProfile, sanitizeReport } from '../../../docs/lib/validate.js';

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_BODY_BYTES = 10_000;
const GEMINI_TIMEOUT_MS = 20_000;

/**
 * Parse and shape-check model output. Throws if the output is not usable.
 * @param {string} text
 */
export function parseAdvice(text) {
  const data = JSON.parse(text);
  const isList = (v) => Array.isArray(v) && v.length > 0;
  if (typeof data?.summary !== 'string' || !isList(data.routine) || !isList(data.indoor) || !Array.isArray(data.alternatives)) {
    throw new Error('Model response did not match the advice schema.');
  }
  return {
    summary: data.summary,
    riskNote: data.riskNote ?? '',
    routine: data.routine.slice(0, 6),
    indoor: data.indoor.slice(0, 6),
    alternatives: data.alternatives.slice(0, 5),
    answer: data.answer ?? '',
  };
}

/** Call Gemini's REST API with a strict JSON response schema. */
export async function callGemini({ report, profile, apiKey, model, fetchImpl }) {
  const res = await fetchImpl(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents: [{ role: 'user', parts: [{ text: buildPrompt(report, profile) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: ADVICE_SCHEMA,
        temperature: 0.4,
        maxOutputTokens: 1500,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
  if (!text) throw new Error('Gemini returned no content');
  return parseAdvice(text);
}

/**
 * Build the request handler.
 * @param {{apiKey?:string, model?:string, allowedOrigins:string[], fetchImpl?:typeof fetch, logger?:Pick<Console,'error'>}} cfg
 * @returns {(req: Request) => Promise<Response>}
 */
export function createHandler({ apiKey, model = DEFAULT_MODEL, allowedOrigins, fetchImpl = fetch, logger = console }) {
  return async function handle(req) {
    const origin = req.headers.get('origin') ?? '';
    const allowed = allowedOrigins.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : allowedOrigins[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!allowed) return json(403, { error: 'Origin not allowed' });
    if (!apiKey) return json(503, { error: 'AI is not configured' });

    let body;
    try {
      const raw = await req.text();
      if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'Request too large' });
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }

    let report;
    try {
      report = sanitizeReport(body?.report, categorize);
    } catch (err) {
      return json(400, { error: err.message });
    }
    const profile = parseProfile(body?.profile);

    try {
      const advice = await callGemini({ report, profile, apiKey, model, fetchImpl });
      return json(200, { advice, source: 'gemini' });
    } catch (err) {
      logger.error('Gemini call failed:', err.message);
      return json(502, { error: 'AI service unavailable' });
    }
  };
}
