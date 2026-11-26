# Project rules

- Node.js 22+, ES modules, no build step. Frontend is plain HTML/CSS/JS in `public/`.
- Before adding or upgrading any dependency, look up its current latest stable version (npm registry); never pin versions from memory. Keep `engines.node` in sync with the strictest dependency.
- If a dependency needs install scripts (e.g. esbuild, sharp), add it to the npm install-script allowlist in package.json so installs don't warn.
- Keep the Gemini model name configurable via `GEMINI_MODEL`; check the Gemini models page before changing the default.
- The rules engine (`src/rules.js`) and Gemini output must share the shape in `ADVICE_SCHEMA` (`src/prompt.js`).
- Render model output with `textContent` only. Never use `innerHTML` for API data.
- `npm test` must pass before every push.
