# Project rules

- Node.js 22+, ES modules, no build step. The static site lives in `docs/` (GitHub Pages). The only server code is two Supabase Edge Functions: `air-data` (Google Air Quality proxy) and `air-advice` (Gemini, reuses `docs/lib/` modules); shared helpers live in `supabase/functions/_shared/`.
- Never put the Gemini or Google keys in the frontend; they are Supabase secrets (`GEMINI_API_KEY`, `GOOGLE_AQ_API_KEY`).
- Never present modelled data as measured. Every reading carries a `source` label (provider, kind, grid size). After changing the function or the `docs/lib` modules it imports, redeploy `air-advice`.
- Before adding or upgrading any dependency, look up its current latest stable version (npm registry); never pin versions from memory. Keep `engines.node` in sync with the strictest dependency.
- If a dependency needs install scripts (e.g. esbuild, sharp), add it to the npm install-script allowlist in package.json so installs don't warn.
- Keep the Gemini model name configurable via `GEMINI_MODEL`; check the Gemini models page before changing the default.
- The rules engine (`docs/lib/rules.js`) and Gemini output must share the shape in `ADVICE_SCHEMA` (`docs/lib/prompt.js`).
- When you change any file in `docs/`, bump the `?v=` number on `styles.css` and `app.js` in `docs/index.html` so browsers don't keep a cached copy.
- Render model output with `textContent` only. Never use `innerHTML` for API data.
- `npm run check` (ESLint + tests) must pass before every push.
- Design direction: the sky band is the one bold element (its colour and skyline visibility follow the AQI level); everything else is a quiet single reading column. No card grids, icon tiles, all-caps labels, middle-dot strings or gradient decoration. Type is self-hosted Anek (Ek Type, OFL) in `docs/fonts/`.
- Chart colours (`--aqi-*` in `styles.css`) were checked with the dataviz palette validator; re-run it if you change them.
