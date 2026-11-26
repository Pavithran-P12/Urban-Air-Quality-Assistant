# Project rules

- Node.js 22+, ES modules, no build step. The static site lives in `docs/` (GitHub Pages). The only server code is the Supabase Edge Function in `supabase/functions/air-advice/`, which reuses modules from `docs/lib/`.
- Never put the Gemini key in the frontend; it is a Supabase secret. After changing the function or the `docs/lib` modules it imports, redeploy `air-advice`.
- Before adding or upgrading any dependency, look up its current latest stable version (npm registry); never pin versions from memory. Keep `engines.node` in sync with the strictest dependency.
- If a dependency needs install scripts (e.g. esbuild, sharp), add it to the npm install-script allowlist in package.json so installs don't warn.
- Keep the Gemini model name configurable via `GEMINI_MODEL`; check the Gemini models page before changing the default.
- The rules engine (`docs/lib/rules.js`) and Gemini output must share the shape in `ADVICE_SCHEMA` (`docs/lib/prompt.js`).
- When you change any file in `docs/`, bump the `?v=` number on `styles.css` and `app.js` in `docs/index.html` so browsers don't keep a cached copy.
- Render model output with `textContent` only. Never use `innerHTML` for API data.
- `npm test` must pass before every push.
