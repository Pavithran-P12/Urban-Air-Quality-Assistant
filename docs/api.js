/**
 * Browser-side client for the air-advice Edge Function (Gemini). The Gemini key never reaches the
 * browser; this only sends the report and profile and returns cleaned advice, or null.
 */
import { normaliseAdvice } from './lib/advice.js';
import { ADVICE_FUNCTION_URL, ADVICE_TIMEOUT_MS } from './config.js';

/** Drop the 48-hour series before sending: the server only needs the summary fields. */
export function trimForServer(report) {
  return { place: report.place, air: { ...report.air, forecast: undefined }, weather: report.weather };
}

/** Ask the Gemini-backed Edge Function for advice; null on any failure so we can fall back. */
export async function fetchAiAdvice(report, profile) {
  try {
    const res = await fetch(ADVICE_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: trimForServer(report), profile }),
      signal: AbortSignal.timeout(ADVICE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.advice ? normaliseAdvice(data.advice) : null;
  } catch {
    return null;
  }
}
