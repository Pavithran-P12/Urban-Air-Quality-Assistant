/**
 * Normalise and fact-check advice before it is shown.
 * Model output is untrusted: we trim and cap every string, drop incomplete items, default enums,
 * and reject answers that quote an AQI number that is not in the data (a hallucination signal).
 */

const MAX_LEN = 400;
const COSTS = ['free', 'low', 'medium'];
const LEVELS = ['high', 'medium', 'low'];
/** How far (in AQI points) a quoted number may be from a real one before it counts as made up. */
const GROUNDING_TOLERANCE = 5;

const text = (v, max = MAX_LEN) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * Keep list items that have every required field, as trimmed strings; enum fields fall back to a
 * default when the value is not allowed.
 * @param {unknown} list
 * @param {string[]} fields required text fields
 * @param {number} max
 * @param {Record<string, {allowed:string[], fallback:string}>} [defaults]
 * @returns {Record<string, string>[]}
 */
function cleanList(list, fields, max, defaults = {}) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      const out = {};
      for (const f of fields) out[f] = text(item?.[f]);
      for (const [f, { allowed, fallback }] of Object.entries(defaults)) {
        out[f] = allowed.includes(item?.[f]) ? item[f] : fallback;
      }
      return out;
    })
    .filter((item) => fields.every((f) => item[f]))
    .slice(0, max);
}

export class AdviceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdviceError';
  }
}

/**
 * Collect every "AQI <n>" the text claims.
 * @param {string} s
 * @returns {number[]}
 */
export function quotedAqis(s) {
  return [...String(s).matchAll(/\bAQI\b[^\d]{0,12}(\d{1,3})\b/gi)].map((m) => Number(m[1]));
}

/**
 * Every AQI the advice quotes must match a value we actually gave it (within a small tolerance).
 * @param {import('./types.js').Advice} advice
 * @param {{usAqi:number, cleanestHours:{aqi:number}[], dominant?:{aqi:number|null}|null,
 *   localIndex?:{aqi:number}|null}} air
 */
export function isGrounded(advice, air, tolerance = GROUNDING_TOLERANCE) {
  const known = [air.usAqi, ...air.cleanestHours.map((h) => h.aqi), air.dominant?.aqi, air.localIndex?.aqi].filter(
    (n) => typeof n === 'number',
  );
  const all = [
    advice.summary,
    advice.riskNote,
    advice.answer,
    ...advice.routine.flatMap((r) => [r.time, r.action, r.why]),
  ].join(' ');
  return quotedAqis(all).every((n) => known.some((k) => Math.abs(k - n) <= tolerance));
}

/**
 * Clean advice into the canonical shape. Throws AdviceError if it is unusable.
 * @param {unknown} data parsed JSON
 * @param {import('./types.js').AirReading} [air] when given, also run the grounding check
 * @returns {import('./types.js').Advice}
 */
export function normaliseAdvice(data, air) {
  const advice = cleanAdvice(data ?? {});
  if (!isComplete(advice)) throw new AdviceError('Advice is incomplete.');
  if (air && !isGrounded(advice, air)) throw new AdviceError('Advice quotes AQI values that are not in the data.');
  return advice;
}

/**
 * Trim, cap and default every field; drop list items missing a required field.
 * The casts are safe: cleanList guarantees each listed field is a non-empty string and each enum
 * field is one of its allowed values.
 * @param {any} data parsed model output (untrusted)
 * @returns {import('./types.js').Advice}
 */
function cleanAdvice(data) {
  return {
    summary: text(data.summary, 600),
    riskNote: text(data.riskNote, 600),
    routine: /** @type {import('./types.js').RoutineStep[]} */ (cleanList(data.routine, ['time', 'action', 'why'], 6)),
    indoor: /** @type {import('./types.js').IndoorTip[]} */ (
      cleanList(data.indoor, ['tip', 'why'], 6, { cost: { allowed: COSTS, fallback: 'low' } })
    ),
    alternatives: /** @type {import('./types.js').Swap[]} */ (
      cleanList(data.alternatives, ['instead', 'try', 'impact'], 5, {
        impactLevel: { allowed: LEVELS, fallback: 'medium' },
      })
    ),
    answer: text(data.answer, 600),
  };
}

/** Enough to show: a summary, at least two routine steps and two indoor tips. */
const isComplete = (advice) => Boolean(advice.summary) && advice.routine.length >= 2 && advice.indoor.length >= 2;
