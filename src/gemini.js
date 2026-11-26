import { GoogleGenAI } from '@google/genai';
import { ADVICE_SCHEMA, SYSTEM_INSTRUCTION, buildPrompt } from './prompt.js';

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

/**
 * Create an advice generator backed by Gemini.
 * Returns null when no API key is configured so callers can fall back to the rules engine.
 * @param {{apiKey?:string, model?:string, client?:{models:{generateContent:Function}}}} [opts]
 */
export function createGeminiAdvisor({ apiKey, model = DEFAULT_MODEL, client } = {}) {
  if (!client && !apiKey) return null;
  const ai = client ?? new GoogleGenAI({ apiKey });

  return async function generateAdvice(report, profile) {
    const response = await ai.models.generateContent({
      model,
      contents: buildPrompt(report, profile),
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseJsonSchema: ADVICE_SCHEMA,
        temperature: 0.4,
        maxOutputTokens: 1500,
      },
    });
    return parseAdvice(response.text);
  };
}

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
