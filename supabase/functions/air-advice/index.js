// Supabase Edge Function entry point (Deno).
// Secrets: set GEMINI_API_KEY (and optionally GEMINI_MODEL, ALLOWED_ORIGINS) in
// Supabase Dashboard → Edge Functions → Secrets.
import { createHandler } from './handler.js';

const handler = createHandler({
  apiKey: Deno.env.get('GEMINI_API_KEY'),
  model: Deno.env.get('GEMINI_MODEL') || undefined,
  allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://pavithran-p12.github.io,http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
});

Deno.serve(handler);
