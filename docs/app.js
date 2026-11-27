/**
 * Page wiring: finds the elements, builds the `ui` the search controller talks to, and connects
 * form and button events. The search logic itself lives in searchController.js.
 */
import { getAirReport, isCacheable } from './lib/airQuality.js';
import { buildRuleAdvice } from './lib/rules.js';
import { parseProfile } from './lib/validate.js';
import { AIR_DATA_FUNCTION_URL, REPORT_CACHE_MS } from './config.js';
import { fetchAiAdvice } from './api.js';
import { $, announce, announcementText, drawChart, renderAdvice, renderAir } from './views.js';
import { createLoadingStatus, lockSearchControls } from './busy.js';
import { createReportCache, createSearchController } from './searchController.js';

const RESIZE_DEBOUNCE_MS = 150;
const COPY_FEEDBACK_MS = 2000;
const GEOLOCATION_OPTIONS = { timeout: 10_000, maximumAge: 600_000 };

/**
 * The page side of the controller's SearchUi: every DOM read and write for a search.
 * @param {HTMLFormElement} form
 * @param {{coords:{latitude:number, longitude:number}|null}} state coordinates of the place shown, if any
 */
function createUi(form, state) {
  const cityInput = /** @type {HTMLInputElement} */ ($('city'));
  const submit = /** @type {HTMLButtonElement} */ ($('submit'));
  const results = $('results');
  const controls = { cityInput, buttons: [...form.querySelectorAll('.quick-city')] };
  const status = createLoadingStatus({ render: (text) => ($('loading-text').textContent = text), announce });

  const setText = (id, message) => {
    const node = $(id);
    node.textContent = message;
    node.hidden = !message;
  };
  const showFieldError = (message) => {
    setText('city-error', message);
    cityInput.setAttribute('aria-invalid', message ? 'true' : 'false');
  };

  return {
    clearErrors() {
      setText('form-error', '');
      showFieldError('');
    },
    /** Show a problem with the place. Validation errors move focus to the box; others don't. */
    showFieldError(message, { focus = true } = {}) {
      showFieldError(message);
      if (focus) cityInput.focus();
    },
    clearFieldError: () => showFieldError(''),
    /** Called by the controller only after it accepts a search, so the box matches that search. */
    showPlace(label, location) {
      cityInput.value = label;
      state.coords = 'latitude' in location ? { latitude: location.latitude, longitude: location.longitude } : null;
    },
    showError: (message) => setText('form-error', message),
    setBusy(on) {
      if (on) results.hidden = true;
      submit.disabled = on;
      submit.querySelector('.btn-text').textContent = on ? 'Checking…' : 'Check the air';
      $('skeleton').hidden = !on;
      lockSearchControls(controls, on);
      if (!on) status.stop();
    },
    checking: () => status.checking('Checking the air…'),
    writing: () => status.step('Writing your plan…'),
    showAir: renderAir,
    showAdvice: renderAdvice,
    showResults: (report, location) => revealResults(results, report, location),
  };
}

/** Show the results: draw the chart, focus the heading, announce one short line, scroll. */
function revealResults(results, report, location) {
  results.hidden = false;
  drawChart();
  // Focus the results heading (not the whole section) and announce one short line.
  $('aqi-place').focus({ preventScroll: true });
  announce(announcementText(report.place, report.air));
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (location.city) rememberCity(location.city);
}

/** Put the city in the address bar so the page can be shared or reloaded. */
function rememberCity(city) {
  const url = new URL(window.location.href);
  url.searchParams.set('city', city);
  window.history.replaceState(null, '', url);
}

/** The household answers from the form, validated. */
function readProfile(form) {
  const value = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
  return parseProfile({
    household: [...form.querySelectorAll('input[name="household"]:checked')].map((i) => i.value),
    commute: value('commute'),
    cooking: value('cooking'),
    heating: value('heating'),
    hasPurifier: /** @type {HTMLInputElement} */ ($('hasPurifier')).checked,
    question: /** @type {HTMLTextAreaElement} */ ($('question')).value,
  });
}

/**
 * "Use where I am": ask the browser for coordinates, then search them. If a search started while
 * the browser was asking, the controller ignores this one and the box keeps the running search.
 */
function locate(ui, startSearch) {
  if (!navigator.geolocation) {
    ui.showFieldError("This browser can't share your location. Type your city instead.", { focus: false });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => startSearch({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }, 'Where I am'),
    () => ui.showFieldError("Couldn't get your location. Type your city instead.", { focus: false }),
    GEOLOCATION_OPTIONS,
  );
}

async function copyLink(button) {
  try {
    await navigator.clipboard.writeText(window.location.href);
    button.textContent = 'Link copied';
  } catch {
    button.textContent = "Couldn't copy the link";
  }
  setTimeout(() => (button.textContent = 'Copy a link to this city'), COPY_FEEDBACK_MS);
}

/** Connect every control. Quick cities and "use where I am" are ignored while a search runs. */
function wireEvents(form, state, ui) {
  const { cityInput, controller } = state;
  /** Search the given place (shown as `label` once accepted), or whatever the box holds now. */
  const startSearch = (place, label) =>
    controller.search({
      place: place ?? state.coords ?? { city: cityInput.value },
      profile: readProfile(form),
      label,
    });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    startSearch();
  });
  cityInput.addEventListener('input', () => {
    state.coords = null;
    ui.clearFieldError();
  });
  form.querySelectorAll('.quick-city[data-city]').forEach((btn) => {
    // aria-disabled doesn't block clicks; the controller ignores taps while a search runs.
    btn.addEventListener('click', () => {
      const city = /** @type {HTMLElement} */ (btn).dataset.city;
      startSearch({ city }, city);
    });
  });
  // Not busy-dependent for safety (the controller already ignores a late answer); this only avoids
  // asking for location permission while the button is marked unavailable.
  $('locate').addEventListener('click', () => {
    if (!controller.busy) locate(ui, startSearch);
  });
  $('again').addEventListener('click', () => {
    cityInput.value = '';
    state.coords = null;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    cityInput.focus({ preventScroll: true });
  });
  $('share').addEventListener('click', () => copyLink($('share')));

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawChart, RESIZE_DEBOUNCE_MS);
  });
  return startSearch;
}

function init() {
  const form = /** @type {HTMLFormElement} */ ($('advice-form'));
  const place = { coords: null };
  const ui = createUi(form, place);
  const controller = createSearchController({
    getReport: (location) => getAirReport(location, fetch, { airDataUrl: AIR_DATA_FUNCTION_URL }),
    isCacheable,
    getAdvice: fetchAiAdvice,
    fallbackAdvice: buildRuleAdvice,
    cache: createReportCache({ ttlMs: REPORT_CACHE_MS }),
    ui,
  });
  const state = Object.assign(place, { controller, cityInput: /** @type {HTMLInputElement} */ ($('city')) });
  const startSearch = wireEvents(form, state, ui);

  // Deep link: ?city=Delhi runs straight away.
  const fromUrl = new URLSearchParams(window.location.search).get('city');
  if (fromUrl) {
    state.cityInput.value = fromUrl.slice(0, 80);
    startSearch();
  }
}

init();
