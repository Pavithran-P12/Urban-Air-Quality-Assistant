# Urban Air Quality Assistant

A GenAI-powered assistant that helps families and communities get through severe winter smog and urban air pollution. Enter your city and a few details about your household, and it gives you:

- **Live air quality**: US AQI, PM2.5, PM10, NO₂, O₃ and CO, plus the cleanest hours in the next 24 hours.
- **A low-emission daily routine**: when to go out, exercise, commute and ventilate.
- **Indoor air quality hacks**: low-cost steps such as DIY box-fan filters, damp mopping and kitchen exhaust use.
- **Sustainable swaps**: alternatives to your current commute, cooking fuel and heating, each with a plain-language explanation of its impact.

Every recommendation explains *why* it helps, so people understand the direct effect of their choices.

## How it works

```
Browser ──► Express API ──► Open-Meteo (geocoding + air quality, no key needed)
                 │
                 ├──► Gemini (structured JSON output, grounded on the live air data)
                 └──► Rules engine (offline fallback when no key / AI error)
```

1. The city is geocoded, and current plus hourly air quality is fetched from the [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) (Copernicus CAMS data).
2. The live readings and the household profile go into a prompt for **Google Gemini**. The model must reply in a strict JSON schema (`responseJsonSchema`), so the output is always renderable.
3. If Gemini is not configured or fails, a **deterministic rules engine** produces the same response shape, so the app always works.

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
npm install
cp .env.example .env        # add your GEMINI_API_KEY (free at https://aistudio.google.com/apikey)
npm run dev                 # http://localhost:8080
```

The app runs without a key too; it uses the rules engine.

## Tests

```bash
npm test
```

The tests use Node's built-in test runner with mocked upstream APIs, so no network or API key is needed. They cover AQI banding, input validation, the air-quality client, the rules engine, prompt building, Gemini response parsing, and the HTTP API (errors, caching, fallback, security headers).

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Status, and whether AI is enabled |
| `GET` | `/api/air?city=Delhi` or `?latitude=..&longitude=..` | Live air-quality report |
| `POST` | `/api/advice` | `{ location: { city } \| { latitude, longitude }, profile: {...} }` → air report + advice |
| `GET` | `/api/options` | Allowed profile values |

## Security and quality

- The API key stays on the server and is never sent to the browser.
- All input is validated and whitelisted; free text is stripped of markup and fenced in the prompt as untrusted, to resist prompt injection.
- Helmet sets a strict Content Security Policy. The frontend renders with `textContent` only (no `innerHTML`), so model output can't inject HTML.
- Requests are rate limited (30/min per IP), JSON bodies are capped at 10 KB, and upstream calls time out after 8 s.
- A 10-minute in-memory cache avoids repeat upstream calls for the same place.
- Errors return friendly JSON messages with no stack traces.

## Accessibility

Semantic HTML landmarks, labelled fields and fieldsets, a skip link, visible focus styles, results announced through `aria-live`, AQI shown as a number and a label (not colour alone), and support for dark mode and reduced motion.

## Deploy (Google Cloud Run)

```bash
gcloud run deploy urban-air-quality-assistant \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=YOUR_KEY
```

The included `Dockerfile` runs as a non-root user on `node:22-alpine` and listens on `$PORT` (default 8080).

## Project structure

```
src/
  server.js      entry point
  app.js         Express app, routes, security, cache, error handling
  airQuality.js  Open-Meteo geocoding + air quality client
  aqi.js         AQI bands, WHO PM2.5 comparison, cleanest-hours finder
  gemini.js      Gemini client + response validation
  prompt.js      system instruction, prompt builder, JSON schema
  rules.js       offline advice engine
  validate.js    input validation and sanitisation
public/          static frontend (HTML, CSS, vanilla JS)
test/            unit and API tests
```

## Disclaimer

The advice is general guidance, not medical advice. If anyone has trouble breathing, see a doctor.
