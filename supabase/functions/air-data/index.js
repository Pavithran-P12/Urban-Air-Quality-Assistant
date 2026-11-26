// Supabase Edge Function entry point (Deno): cached proxy to the Google Air Quality API.
// Secrets: GOOGLE_AQ_API_KEY (required), ALLOWED_ORIGINS (optional) in
// Supabase Dashboard → Edge Functions → Secrets.
import { createAirDataHandler } from './handler.js';
import { parseOrigins } from '../_shared/http.js';

Deno.serve(
  createAirDataHandler({
    apiKey: Deno.env.get('GOOGLE_AQ_API_KEY'),
    allowedOrigins: parseOrigins(Deno.env.get('ALLOWED_ORIGINS')),
  }),
);
