# Urban Air Quality Assistant

A GenAI-powered assistant that helps families and communities get through severe winter smog and urban air pollution. Enter your city and a few details about your household, and it gives you:

- **Live air quality**: US AQI, PM2.5, PM10, NO₂, O₃ and CO, plus the cleanest hours in the next 24 hours.
- **A low-emission daily routine**: when to go out, exercise, commute and ventilate.
- **Indoor air quality hacks**: low-cost steps such as DIY box-fan filters, damp mopping and kitchen exhaust use.
- **Sustainable swaps**: alternatives to your current commute, cooking fuel and heating, each with a plain-language explanation of its impact.

Every recommendation explains *why* it helps, so people understand the direct effect of their choices.

## How it works

```
Browser (GitHub Pages) ──► Open-Meteo (geocoding + air quality, no key needed)
        │
        ├──► Supabase Edge Function "air-advice" ──► Gemini (structured JSON output)
        │         (holds GEMINI_API_KEY as a secret)
        └──► Built-in rules engine (fallback if AI is unavailable)
```

1. The browser geocodes the city and fetches current plus hourly air quality from the [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) (Copernicus CAMS data).
2. It sends the readings and the household profile to a **Supabase Edge Function**. The function re-validates everything, then asks **Google Gemini** for advice in a strict JSON schema (`responseJsonSchema`). The API key never reaches the browser.
3. If the function or Gemini is unavailable, a **deterministic rules engine** in the browser produces the same response shape, so the app always works.

### Household profile used for tailoring

| Input | Options |
|---|---|
| Household members | children, elderly, pregnant, asthma/COPD, heart condition, pets |
| Commute | public transport, car, two-wheeler, walk, cycle, work from home |
| Cooking fuel | LPG, piped gas, induction, electric, biomass, kerosene |
| Heating | none, electric, gas, wood, coal, kerosene |
| Air purifier | yes / no |
| Free-text question | optional, max 300 chars |

## Run locally

Requires **Node.js 22+**.

```bash
npm run dev     # serves docs/ at http://localhost:3000
npm test
```

The tests use Node's built-in test runner with mocked APIs, so no network or API key is needed. They cover AQI banding, input validation, the air-quality client, the rules engine, prompt building, and the Edge Function (CORS, origin checks, payload limits, sanitisation, Gemini errors).

## Deploy

**Frontend (GitHub Pages):** Settings → Pages → Deploy from branch `main`, folder `/docs`. If Pages is set to the root instead, the root `index.html` redirects to `docs/`.

**AI backend (Supabase Edge Function):**

1. In Supabase Dashboard → Edge Functions → Secrets, add `GEMINI_API_KEY` (free key at https://aistudio.google.com/apikey).
2. Optional secrets: `GEMINI_MODEL` (default `gemini-3.5-flash-lite`) and `ALLOWED_ORIGINS` (comma-separated, default `https://pavithran-p12.github.io,http://localhost:3000`).
3. Deploy: `supabase functions deploy air-advice --no-verify-jwt`.
4. Set `ADVICE_FUNCTION_URL` in `docs/config.js` to your function URL.

## Security and quality

- The Gemini key is a Supabase secret and is never sent to the browser.
- All input is validated and whitelisted; free text is stripped of markup and fenced in the prompt as untrusted, to resist prompt injection.
- The Edge Function only accepts requests from allowed origins, caps bodies at 10 KB, and rebuilds the air report from plain numbers before prompting.
- A strict Content Security Policy limits the page to its own scripts and three known APIs. The page renders with `textContent` only (no `innerHTML`), so model output can't inject HTML.
- Network calls time out (8 s for air data, 20–25 s for AI), and errors show friendly messages.

## Accessibility

Semantic HTML landmarks, labelled fields and fieldsets, a skip link, visible focus styles, results announced through `aria-live`, AQI shown as a number and a label (not colour alone), and support for dark mode and reduced motion.

## Project structure

```
docs/                      static site served by GitHub Pages
  index.html, styles.css   UI
  app.js                   UI logic
  config.js                public config (function URL)
  lib/
    airQuality.js          Open-Meteo geocoding + air quality client
    aqi.js                 AQI bands, WHO PM2.5 comparison, cleanest-hours finder
    prompt.js              system instruction, prompt builder, JSON schema
    rules.js               offline advice engine
    validate.js            input validation and sanitisation
supabase/functions/air-advice/
  index.js                 Deno entry point
  handler.js               request handling + Gemini call (reuses docs/lib modules)
test/                      unit and Edge Function tests
```

## Disclaimer

The advice is general guidance, not medical advice. If anyone has trouble breathing, see a doctor.
