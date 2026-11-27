# Urban Air Quality Assistant

A GenAI-powered assistant that helps families and communities get through severe winter smog and urban air pollution. Enter your city and a few details about your household, and it gives you:

- **Hyperlocal air quality**: US AQI, PM2.5, PM10, NO₂, O₃ and CO from the Google Air Quality API (500 m grid), plus the country's own index (e.g. India's NAQI), with honest "modelled" labels.
- **48-hour forecast chart** with the cleanest hours highlighted and weather context (wind, rain).
- **A low-emission daily routine**: when to go out, exercise, commute and ventilate.
- **Indoor air quality hacks**: low-cost steps such as DIY box-fan filters, damp mopping and kitchen exhaust use.
- **Sustainable swaps**: alternatives to your current commute, cooking fuel and heating, each with a plain-language explanation of its impact.

Every recommendation explains *why* it helps, so people understand the direct effect of their choices.

**Live app:** https://pavithran-p12.github.io/Urban-Air-Quality-Assistant/

## Chosen vertical

**Urban Air Quality Assistant**: a smart, dynamic assistant for families and communities coping with severe winter smog and urban air pollution. The persona is a parent or carer in a dense Indian city (Delhi, Chennai, Mumbai, Kolkata, Bengaluru) who checks every morning whether it is safe to go out, and wants practical, low-cost steps to protect their household and cut the pollution they create.

## Approach and logic

The assistant makes decisions from the user's context in three layers, so every number is computed, not guessed:

1. **Context in.** Location (city, "City, Country" or GPS) plus a household profile: who needs extra care (children, older relatives, pregnancy, asthma/COPD, heart conditions, pets), commute mode, cooking fuel, heating, purifier ownership and an optional question.
2. **Deterministic decisions in code** (`docs/lib/`):
   - US AQI from PM2.5 with the EPA 2024 breakpoints, the AQI band, and the safety guidance for that band (outdoor exercise, windows, masks).
   - The main pollutant, the PM2.5 multiple of the WHO daily guideline, and the country's own index.
   - The cleanest hours in the next 24 h and whether air *meaningfully* improves (15+ AQI points), with wind and rain context.
   - Tailoring rules: sensitive household members get explicit precautions; swaps are only suggested for things the household actually does (no "switch to LPG" if they already cook with LPG).
3. **Gemini explains and personalises.** The computed facts and profile go to Gemini, which returns a structured plan (routine with time slots, indoor hacks with cost, swaps with impact). The output is fact-checked against the data; if it is wrong or unavailable, the rules engine produces the same plan shape.

| User context | How the assistant responds |
|---|---|
| AQI ≤ 50 (good) | Outdoor exercise and opening windows to ventilate |
| AQI 101–150 + children or asthma in the household | Sensitive members stay indoors, inhalers to hand, N95 outdoors |
| AQI > 200 | Stay in, seal gaps, run purifiers or a DIY box-fan filter |
| Air improves later today | Errands and airing out scheduled at the cleanest hour |
| No improvement forecast | Keeps trips short; never says "wait for a better hour" |
| Commutes by car or two-wheeler | Recirculation or N95 plus side streets; metro or car-pool swaps |
| Cooks with wood or kerosene | LPG / piped gas / induction swap, marked high impact |

## How it works

```
Browser (GitHub Pages)
  ├─► Open-Meteo geocoding ─────────────────────────────┐
  ├─► Supabase Edge Function "air-data" ─► Google Air Quality API (500 m, 48 h)
  │        (GOOGLE_AQ_API_KEY secret, 15-min cache per 500 m cell)
  ├─► Open-Meteo weather (wind, rain) and, only if Google fails, CAMS air (~45 km)
  ├─► Supabase Edge Function "air-advice" ─► Gemini (structured JSON output)
  │        (GEMINI_API_KEY secret, fact-checked, 1 retry)
  └─► Built-in rules engine (fallback if AI is unavailable)
```

1. The browser geocodes the city, then asks the **air-data** function for Google Air Quality data (current conditions + 48 hourly forecasts) and Open-Meteo for weather, in parallel. If Google is unavailable, it falls back to the CAMS model via Open-Meteo.
2. Every provider is normalised into one shape (`docs/lib/normalise.js`): concentrations in µg/m³ (ppb converted with the 25 °C molar volume), local times, and a **source label** saying what the data is (always *modelled*), where it comes from and its grid size.
3. US AQI is computed in code from PM2.5 with the EPA 2024 breakpoints, because Google does not document US AQI for every country; the country's own index is shown alongside it.
4. The readings, weather and household profile go to the **air-advice** function, which re-validates everything and asks **Google Gemini** for advice in a strict JSON schema. If Gemini is unavailable, the browser's **rules engine** produces the same shape.

### Data honesty

- Every reading is labelled **Modelled**, with its source and grid size ("Google Air Quality API · 500 m grid", or "CAMS via Open-Meteo · ~45 km grid"). Nothing is presented as a sensor measurement.
- A plain-language note explains what the grid size means ("nearby streets can differ" / "treat it as a city-wide guide").
- The server re-derives the source label itself, so the model is never told the data is "measured", and the prompt forbids calling it that.

### Accuracy and edge cases

- **Facts are computed in code, not by the model.** The prompt gets the AQI band's safety guidance (exercise, windows, masks), the main pollutant from per-pollutant sub-indices, the cleanest hours, and whether air *meaningfully* improves (15+ AQI points). The model is told not to promise a better hour when there isn't one.
- **Every answer is fact-checked.** Model output is cleaned (trimmed, length-capped, incomplete items dropped, enums defaulted), and any answer that quotes an AQI number not in the data is rejected and retried once. Transient Gemini errors (429/5xx, malformed JSON) are retried once; a bad key is not.
- **Missing data:** if the upstream AQI is missing, it is computed from PM2.5 with the EPA 2024 breakpoints (and labelled "estimated"); missing hourly AQI is filled the same way. Places with no readings get a clear message.
- **Ambiguous cities:** "Hyderabad, Pakistan" or "Portland, Maine" picks the matching region or country.
- **Tailoring rules:** good-air days suggest ventilation and outdoor exercise; bad-air days never do. Nobody is told to switch to something they already use, and purifier owners get purifier care tips instead of a DIY build.
- **Clear explanations:** every routine step has a concrete time slot and says what it reduces. Indoor hacks carry a cost badge (Free / Low cost / Some cost), and swaps carry an impact level.

### Household profile used for tailoring

| Input | Options |
|---|---|
| Household members | children, elderly, pregnant, asthma/COPD, heart condition, pets |
| Commute | public transport, car, two-wheeler, walk, cycle, work from home |
| Cooking fuel | LPG, piped gas, induction, electric, biomass, kerosene |
| Heating | none, electric, gas, wood, coal, kerosene |
| Air purifier | yes / no |
| Free-text question | optional, max 300 chars |

## Assumptions

- **US AQI is the headline scale** because its bands and health guidance are widely documented. For Indian locations, India's NAQI from Google is shown alongside it, since that is the number in local news.
- **All air data is modelled, not measured.** The Google Air Quality API estimates a 500 m area; CAMS via Open-Meteo estimates a ~45 km area. The app labels this everywhere and never presents a value as a sensor reading.
- **PM2.5 drives the US AQI** shown when the provider doesn't give US AQI directly; this matches how AQI behaves in Indian winter smog, where PM2.5 is usually the dominant pollutant.
- **Guidance is general, not medical.** The assistant flags warning signs and says when to see a doctor, but never diagnoses or suggests medication.
- **Users are on a phone**, often with a slow connection: no framework, no build step, self-hosted fonts and a 10-minute cache per place.
- **Costs** are given in rupees ("under ₹1,000") because the primary persona is in India.

## Run locally

Requires **Node.js 22.13+ or 24+** (ESLint 10's minimum).

```bash
npm run dev     # serves docs/ at http://localhost:3000
npm run check   # lint, type check, format check and tests
```

The tests use Node's built-in test runner with mocked APIs, so no network or API key is needed. `npm run check` runs ESLint (including size and complexity limits), a TypeScript type check of the JSDoc types (`checkJs`, no build step), a Prettier format check and the tests; GitHub Actions runs all four on every push. The 315 tests cover:

- **Behaviour snapshots** (`test/__snapshots__/behaviour.json`): the normalised report, the exact Gemini prompt and the rules-engine plan for every data source, AQI band and household option. A refactor that changes any of them fails until the change is reviewed and accepted with `UPDATE_SNAPSHOTS=1 npm test`.
- **Contracts** between the Edge Functions and the browser (what air-data returns is what the browser reads; what the browser sends, air-advice accepts).
- The search controller (one search at a time, fallbacks, errors, cache), AQI maths, validation, the rules engine, fact-checking of model output, both Edge Functions (CORS, origins, payload limits, rate limiting, timeouts, caching, retries, sanitised logs), units, time zones and accessibility markup.

## Deploy

**Frontend (GitHub Pages):** Settings → Pages → Deploy from branch `main`, folder `/docs`. If Pages is set to the root instead, the root `index.html` redirects to `docs/`.

**Backend (two Supabase Edge Functions):**

1. In Supabase Dashboard → Edge Functions → Secrets, add `GEMINI_API_KEY` (free key at https://aistudio.google.com/apikey) and `GOOGLE_AQ_API_KEY` (a Google Cloud key restricted to the Air Quality API; billing must be enabled, 10,000 calls/month are free).
2. Optional secrets: `GEMINI_MODEL` (default `gemini-3.5-flash-lite`) and `ALLOWED_ORIGINS` (comma-separated, default `https://pavithran-p12.github.io,http://localhost:3000`).
3. Deploy: `supabase functions deploy air-advice --no-verify-jwt` and `supabase functions deploy air-data --no-verify-jwt`. Each function is bundled with its own copy of the `docs/lib` modules it imports, so they deploy independently.
4. Set `ADVICE_FUNCTION_URL` and `AIR_DATA_FUNCTION_URL` in `docs/config.js` to your function URLs.

## Security and quality

- The Gemini key is a Supabase secret and is never sent to the browser.
- All input is validated and whitelisted; free text is stripped of markup and fenced in the prompt as untrusted, to resist prompt injection.
- The Edge Function only accepts requests from allowed origins, rate-limits bursts per client (10/min) using only the platform-set `CF-Connecting-IP` / `X-Real-IP` headers (never the spoofable `X-Forwarded-For`), caps bodies at 10 KB, and rebuilds the air report from plain numbers (re-deriving band, outlook and main pollutant) before prompting.
- A strict Content Security Policy limits the page to its own scripts and three known APIs. The page renders with `textContent` only (no `innerHTML`), so model output can't inject HTML.
- One timeout budget per lookup: the air-data function gives Google 9 s in total (current conditions and forecast share the deadline) and the browser waits 11 s. A slow forecast still returns today's reading; incomplete or fallback results are never cached, and a fallback is always labelled.
- Known failures show a specific, friendly message; anything unexpected shows a generic one, with only a sanitised summary (no stack, URLs or keys) logged.
- Caching: the air-data function caches each ~500 m cell for 15 minutes, and the browser reuses a place's result for 10 minutes, so repeat lookups cost no API calls.
- Keys travel in headers (`X-Goog-Api-Key`, `x-goog-api-key`), never in URLs, so they don't end up in logs.
- Edge functions log one JSON line per request (cell, duration, error) for debugging; errors are logged through the same sanitiser as the browser.

## Accessibility

Semantic HTML landmarks, labelled fields and fieldsets, a skip link, visible focus styles, one polite status line for progress and results (focus moves to the results heading), quick-city buttons that stay focusable but are announced as unavailable during a search (`aria-disabled`), a keyboard-navigable chart with a table view, AQI shown as a number and a label (not colour alone), and support for dark mode and reduced motion.

## Project structure

```
docs/                        static site served by GitHub Pages
  index.html, styles.css     markup and styles (self-hosted Anek fonts in fonts/)
  app.js                     page wiring: elements, events, the ui object
  searchController.js        one search at a time: validate, load (cached), advise, report errors; no DOM
  busy.js                    busy state: locked controls, loading line and slow-search notice
  views.js                   rendering (textContent only)
  api.js                     client for the Gemini Edge Function
  chart.js                   accessible 48 h forecast chart (SVG + table)
  config.js                  public config (function URLs, cache time)
  lib/                       framework-free logic, shared with the Edge Functions and tests
    types.js                 JSDoc types for every data shape (checked by `npm run typecheck`)
    guards.js                shared value checks (finite number, non-empty text)
    forecast.js              forecast windows shared by the browser and the air-data function
    errors.js                user-facing error types and the log sanitiser
    airQuality.js            geocoding, source selection, Open-Meteo fallback
    normalise.js             provider data → one shape (units, time zones)
    sources.js               source labels (provider, modelled/measured, grid size)
    weather.js               Open-Meteo weather (wind, rain)
    aqi.js                   AQI bands, PM2.5→AQI, main pollutant, cleanest hours, safety guidance
    time.js                  local time formatting
    prompt.js                system instruction, prompt builder, JSON schema
    advice.js                cleans and fact-checks advice before display
    rules.js                 offline advice engine
    validate.js              input validation and sanitisation
supabase/functions/
  _shared/http.js            CORS, request checks, rate limiter, TTL cache, JSON body reader
  air-data/                  Google Air Quality API proxy (cached; imports docs/lib/forecast.js, errors.js)
  air-advice/                Gemini advice (reuses docs/lib modules)
test/                        unit, snapshot, contract and Edge Function tests (node --test)
jsconfig.json                type checking for the JSDoc-typed JavaScript (no build step)
.github/workflows/ci.yml     lint, type check, format check and tests on every push
```

The Edge Functions import modules from `docs/lib/` rather than a separate shared folder because the site has no build step: GitHub Pages can only serve files under `docs/`, so that is where the browser and the functions share code.

## Disclaimer

The advice is general guidance, not medical advice. If anyone has trouble breathing, see a doctor.
