import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAirReport } from './airQuality.js';
import { buildRuleAdvice } from './rules.js';
import { parseLocation, parseProfile, OPTIONS } from './validate.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Tiny TTL cache so repeated lookups for the same place don't hit the upstream API. */
function createCache(ttl = CACHE_TTL_MS, maxEntries = 200) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.expires) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      if (store.size >= maxEntries) store.delete(store.keys().next().value);
      store.set(key, { value, expires: Date.now() + ttl });
    },
  };
}

/**
 * Build the Express app. Dependencies are injectable for testing.
 * @param {{fetchImpl?:typeof fetch, advisor?:Function|null, logger?:Pick<Console,'error'>}} [deps]
 */
export function createApp({ fetchImpl = fetch, advisor = null, logger = console } = {}) {
  const app = express();
  const cache = createCache();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }));

  const apiLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  app.use('/api/', apiLimiter);

  async function report(loc) {
    const key = loc.city ? `c:${loc.city.toLowerCase()}` : `g:${loc.latitude.toFixed(2)},${loc.longitude.toFixed(2)}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const fresh = await getAirReport(loc, fetchImpl);
    cache.set(key, fresh);
    return fresh;
  }

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', ai: Boolean(advisor) });
  });

  app.get('/api/options', (_req, res) => {
    res.json(OPTIONS);
  });

  app.get('/api/air', async (req, res, next) => {
    try {
      res.json(await report(parseLocation(req.query)));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/advice', async (req, res, next) => {
    try {
      const loc = parseLocation(req.body?.location);
      const profile = parseProfile(req.body?.profile);
      const data = await report(loc);

      let advice;
      let source = 'rules';
      if (advisor) {
        try {
          advice = await advisor(data, profile);
          source = 'gemini';
        } catch (err) {
          logger.error('Gemini failed, using rules fallback:', err.message);
        }
      }
      advice ??= buildRuleAdvice(data, profile);

      res.json({ ...data, advice, source });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api/', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Central error handler: never leak stack traces to clients.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status && err.status < 600 ? err.status : 500;
    if (status >= 500) logger.error(err);
    res.status(status).json({ error: status >= 500 && !err.status ? 'Something went wrong.' : err.message });
  });

  return app;
}
