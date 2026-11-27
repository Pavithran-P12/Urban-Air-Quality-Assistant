/**
 * Browser-side client for the air-advice Edge Function (Gemini). The Gemini key never reaches the
 * browser; this only sends the report and profile and returns cleaned advice, or null.
 */
import { normaliseAdvice } from './lib/advice.js';
import { describeForLog } from './lib/errors.js';
import { ADVICE_FUNCTION_URL, ADVICE_TIMEOUT_MS } from './config.js';

/**
 * Drop the 48-hour series before sending: the server only needs the summary fields.
 * @param {import('./lib/types.js').AirReport} report
 */
export function trimForServer(report) {
  return { place: report.place, air: { ...report.air, forecast: undefined }, weather: report.weather };
}

/**
 * Ask the Gemini-backed Edge Function for advice; null on any failure so the caller falls back to
 * the rules engine. Failures are logged as a sanitised one-line summary.
 * @param {import('./lib/types.js').AirReport} report
 * @param {import('./lib/types.js').Profile} profile
 * @param {{fetchImpl?:typeof fetch, logger?:Pick<Console,'warn'>}} [options]
 * @returns {Promise<import('./lib/types.js').Advice|null>}
 */
export async function fetchAiAdvice(report, profile, { fetchImpl = fetch, logger = console } = {}) {
  try {
    const res = await fetchImpl(ADVICE_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: trimForServer(report), profile }),
      signal: AbortSignal.timeout(ADVICE_TIMEOUT_MS),
    });
    // Internal and log-only, so a plain Error (AppError messages are meant for users).
    if (!res.ok) throw new Error(`The AI planner answered ${res.status}.`);
    const data = await res.json();
    return data?.advice ? normaliseAdvice(data.advice) : null;
  } catch (err) {
    logger.warn('AI plan unavailable, using built-in rules', describeForLog(err));
    return null;
  }
}
