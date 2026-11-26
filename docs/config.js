// Public configuration. Nothing secret lives here: the Gemini key stays in Supabase secrets.
/** Google Air Quality API proxy (500 m grid). The Google key stays in Supabase secrets. */
export const AIR_DATA_FUNCTION_URL = 'https://wxlpbefrbxxbosjfeudk.supabase.co/functions/v1/air-data';
export const ADVICE_FUNCTION_URL = 'https://wxlpbefrbxxbosjfeudk.supabase.co/functions/v1/air-advice';
export const ADVICE_TIMEOUT_MS = 25_000;
/** How long a looked-up place stays cached in this tab (ms). Upstream data updates hourly at most. */
export const REPORT_CACHE_MS = 10 * 60_000;
