/**
 * HTTP helpers shared by the Edge Functions: CORS, JSON responses, client IP,
 * a best-effort rate limiter and a small TTL cache. Runtime-agnostic (Deno and Node).
 */

/**
 * Build CORS headers and a JSON responder for one request.
 * @param {Request} req
 * @param {string[]} allowedOrigins
 */
export function corsFor(req, allowedOrigins) {
  const origin = req.headers.get('origin') ?? '';
  const allowed = allowedOrigins.includes(origin);
  const headers = {
    'Access-Control-Allow-Origin': allowed ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  const json = (status, body, extra = {}) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json', ...extra } });
  return { allowed, headers, json };
}

/** First address in X-Forwarded-For, or "unknown". */
export function clientIp(req) {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
}

/**
 * Fixed-window, in-memory rate limiter keyed by client IP. Edge instances are short-lived, so this
 * is a best-effort guard against bursts, not a hard quota (provider quotas are the hard limit).
 */
export function createRateLimiter({ limit = 10, windowMs = 60_000, now = Date.now } = {}) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      if (hits.size > 5000) hits.clear();
      hits.set(key, { start: t, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

/**
 * Bounded TTL cache. Oldest entries are evicted first once `max` is reached.
 * @template T
 */
export function createTtlCache({ ttlMs = 600_000, max = 500, now = Date.now } = {}) {
  const store = new Map();
  return {
    /** @returns {T|undefined} */
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (now() > hit.expires) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    /** @param {T} value */
    set(key, value) {
      if (store.size >= max) store.delete(store.keys().next().value);
      store.set(key, { value, expires: now() + ttlMs });
    },
    get size() {
      return store.size;
    },
  };
}

/** Read and parse a JSON body with a size cap. Returns {body} or {error:{status,message}}. */
export async function readJson(req, maxBytes) {
  try {
    const raw = await req.text();
    if (raw.length > maxBytes) return { error: { status: 413, message: 'Request too large' } };
    return { body: JSON.parse(raw) };
  } catch {
    return { error: { status: 400, message: 'Invalid JSON' } };
  }
}

/** Parse ALLOWED_ORIGINS (comma-separated) with a safe default. */
export function parseOrigins(value) {
  return (value ?? 'https://pavithran-p12.github.io,http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
