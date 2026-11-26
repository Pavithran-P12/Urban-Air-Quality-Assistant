// Supabase Edge Function entry point (Deno).
// Secrets: set GEMINI_API_KEY (and optionally GEMINI_MODEL, ALLOWED_ORIGINS) in
// Supabase Dashboard → Edge Functions → Secrets.
import { createHandler } from './handler.js';
import { parseOrigins } from '../_shared/http.js';

const handler = createHandler({
  apiKey: Deno.env.get('GEMINI_API_KEY'),
  model: Deno.env.get('GEMINI_MODEL') || undefined,
  allowedOrigins: parseOrigins(Deno.env.get('ALLOWED_ORIGINS')),
});

Deno.serve(handler);
