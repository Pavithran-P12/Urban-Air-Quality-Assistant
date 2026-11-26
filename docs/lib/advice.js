/**
 * Normalise and fact-check advice before it is shown.
 * Model output is untrusted: we trim and cap every string, drop incomplete items, default enums,
 * and reject answers that quote an AQI number that is not in the data (a hallucination signal).
 */

const MAX_LEN = 400;
const COSTS = ['free', 'low', 'medium'];
const LEVELS = ['high', 'medium', 'low'];

const text = (v, max = MAX_LEN) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

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
 * @param {object} advice
 * @param {{usAqi:number, cleanestHours:{aqi:number}[]}} air
 */
export function isGrounded(advice, air, tolerance = 5) {
  const known = [air.usAqi, ...air.cleanestHours.map((h) => h.aqi), air.dominant?.aqi].filter((n) => typeof n === 'number');
  const all = [advice.summary, advice.riskNote, advice.answer, ...advice.routine.flatMap((r) => [r.time, r.action, r.why])].join(' ');
  return quotedAqis(all).every((n) => known.some((k) => Math.abs(k - n) <= tolerance));
}

/**
 * Clean advice into the canonical shape. Throws AdviceError if it is unusable.
 * @param {unknown} data parsed JSON
 * @param {object} [air] when given, also run the grounding check
 */
export function normaliseAdvice(data, air) {
  const advice = {
    summary: text(data?.summary, 600),
    riskNote: text(data?.riskNote, 600),
    routine: cleanList(data?.routine, ['time', 'action', 'why'], 6),
    indoor: cleanList(data?.indoor, ['tip', 'why'], 6, { cost: { allowed: COSTS, fallback: 'low' } }),
    alternatives: cleanList(data?.alternatives, ['instead', 'try', 'impact'], 5, {
      impactLevel: { allowed: LEVELS, fallback: 'medium' },
    }),
    answer: text(data?.answer, 600),
  };
  if (!advice.summary || advice.routine.length < 2 || advice.indoor.length < 2) {
    throw new AdviceError('Advice is incomplete.');
  }
  if (air && !isGrounded(advice, air)) {
    throw new AdviceError('Advice quotes AQI values that are not in the data.');
  }
  return advice;
}
