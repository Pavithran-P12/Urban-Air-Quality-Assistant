/**
 * One search at a time, with no DOM access: validate the place, load the air report (reusing a
 * recent complete one), ask for a plan with the rules engine as fallback, then hand each result to
 * the page through the `ui` object it was given. Everything is injected, so it runs in Node tests.
 */
import { parseLocation } from './lib/validate.js';
import { describeForLog, toUserMessage } from './lib/errors.js';

/** Most places one tab keeps cached; the oldest is dropped first. */
const MAX_CACHED_PLACES = 20;

/**
 * Cache key for a validated location: the city name (any case) or coordinates to ~100 m.
 * @param {{city?:string, latitude?:number, longitude?:number}} location
 * @returns {string}
 */
export function reportKey(location) {
  return location.city
    ? `c:${location.city.toLowerCase()}`
    : `g:${location.latitude.toFixed(3)},${location.longitude.toFixed(3)}`;
}

/**
 * Small time-limited cache for air reports, bounded in size.
 * @param {{ttlMs:number, max?:number, now?:()=>number}} options
 */
export function createReportCache({ ttlMs, max = MAX_CACHED_PLACES, now = Date.now }) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.report;
      entries.delete(key);
      return undefined;
    },
    set(key, report) {
      entries.delete(key);
      if (entries.size >= max) entries.delete(entries.keys().next().value);
      entries.set(key, { at: now(), report });
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * Wrap a report loader so a recent complete report for the same place is reused.
 * Fallback and partial reports are never stored, so the next search tries again.
 */
function cachedLoader({ cache, getReport, isCacheable }) {
  return async (location) => {
    const key = reportKey(location);
    const hit = cache.get(key);
    if (hit) return hit;
    const report = await getReport(location);
    if (isCacheable(report)) cache.set(key, report);
    return report;
  };
}

/** The steps of one search, in order. Throws on failure; the caller reports it. */
async function runSearch({ ui, loadReport, getAdvice, fallbackAdvice }, location, profile) {
  ui.checking();
  const report = await loadReport(location);
  ui.showAir(report);
  ui.writing();
  const aiAdvice = await getAdvice(report, profile);
  ui.showAdvice(aiAdvice ?? fallbackAdvice(report, profile), aiAdvice ? 'gemini' : 'rules');
  ui.setBusy(false);
  ui.showResults(report, location);
}

/**
 * @typedef {object} SearchUi What the controller needs from the page.
 * @property {() => void} clearErrors
 * @property {(label:string, location:{city?:string, latitude?:number, longitude?:number}) => void} showPlace
 *   show the accepted place in the search box (only called once a search is accepted)
 * @property {(message:string) => void} showFieldError  the place could not be used
 * @property {(message:string) => void} showError       the search failed
 * @property {(on:boolean) => void} setBusy             lock or unlock search controls
 * @property {() => void} checking                      first loading step (data)
 * @property {() => void} writing                       second loading step (plan)
 * @property {(report:import('./lib/types.js').AirReport) => void} showAir
 * @property {(advice:import('./lib/types.js').Advice, source:'gemini'|'rules') => void} showAdvice
 * @property {(report:import('./lib/types.js').AirReport, location:object) => void} showResults
 */

/**
 * @param {{
 *   getReport:(location:object) => Promise<import('./lib/types.js').AirReport>,
 *   isCacheable:(report:import('./lib/types.js').AirReport) => boolean,
 *   getAdvice:(report:object, profile:object) => Promise<import('./lib/types.js').Advice|null>,
 *   fallbackAdvice:(report:object, profile:object) => import('./lib/types.js').Advice,
 *   cache:ReturnType<typeof createReportCache>,
 *   ui:SearchUi,
 *   logger?:Pick<Console,'error'>,
 * }} deps
 */
export function createSearchController({
  getReport,
  isCacheable,
  getAdvice,
  fallbackAdvice,
  cache,
  ui,
  logger = console,
}) {
  let busy = false;
  const loadReport = cachedLoader({ cache, getReport, isCacheable });

  /**
   * Run one search. Ignored (returns 'busy') while another is running, and in that case nothing on
   * the page changes: the place shown is only updated (via ui.showPlace) once a search is accepted,
   * so it always matches the search that is running.
   * @param {{place:object, profile:object, label?:string}} request place is {city} or
   *   {latitude, longitude}; label is the text to show for it (a quick city, "Where I am")
   * @returns {Promise<'done'|'busy'|'invalid'|'failed'>}
   */
  async function search({ place, profile, label }) {
    if (busy) return 'busy';
    ui.clearErrors();
    let location;
    try {
      location = parseLocation(place);
    } catch (err) {
      ui.showFieldError(toUserMessage(err));
      return 'invalid';
    }
    if (label !== undefined) ui.showPlace(label, location);
    busy = true;
    ui.setBusy(true);
    try {
      await runSearch({ ui, loadReport, getAdvice, fallbackAdvice }, location, profile);
      return 'done';
    } catch (err) {
      ui.setBusy(false);
      // Known app errors carry a user-facing message; anything else gets a generic one.
      // Only a sanitised summary is logged: no stack, URLs or key-like values.
      logger.error('Air check failed', describeForLog(err));
      ui.showError(toUserMessage(err));
      return 'failed';
    } finally {
      busy = false;
    }
  }

  return {
    search,
    /** True while a search is running. */
    get busy() {
      return busy;
    },
  };
}
