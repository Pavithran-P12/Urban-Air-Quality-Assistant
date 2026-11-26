/**
 * Page controller: reads the form, loads the air report (cached per place for a few minutes),
 * asks Gemini for a plan with the rules engine as fallback, and hands both to the views.
 */
import { getAirReport } from './lib/airQuality.js';
import { buildRuleAdvice } from './lib/rules.js';
import { parseLocation, parseProfile } from './lib/validate.js';
import { AIR_DATA_FUNCTION_URL, REPORT_CACHE_MS } from './config.js';
import { fetchAiAdvice } from './api.js';
import { $, drawChart, renderAdvice, renderAir } from './views.js';

function init() {
  const form = $('advice-form');
  const cityInput = $('city');
  const submit = $('submit');
  const submitText = submit.querySelector('.btn-text');
  const results = $('results');
  const loading = $('skeleton');
  let coords = null;
  let busy = false;
  const reportCache = new Map();

  /** Look up a place, reusing a recent result for the same place in this tab. */
  async function loadReport(location) {
    const key = location.city
      ? `c:${location.city.toLowerCase()}`
      : `g:${location.latitude.toFixed(3)},${location.longitude.toFixed(3)}`;
    const hit = reportCache.get(key);
    if (hit && Date.now() - hit.at < REPORT_CACHE_MS) return hit.report;
    const report = await getAirReport(location, fetch, { airDataUrl: AIR_DATA_FUNCTION_URL });
    reportCache.set(key, { at: Date.now(), report });
    return report;
  }

  const showFieldError = (msg) => {
    $('city-error').textContent = msg;
    $('city-error').hidden = !msg;
    cityInput.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };
  const showError = (msg) => {
    $('form-error').textContent = msg;
    $('form-error').hidden = !msg;
  };

  function setBusy(on, label) {
    busy = on;
    submit.disabled = on;
    results.setAttribute('aria-busy', String(on));
    submitText.textContent = on ? 'Checking…' : 'Check the air';
    loading.hidden = !on;
    if (label) $('loading-text').textContent = label;
  }

  function readProfile() {
    const value = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
    return parseProfile({
      household: [...form.querySelectorAll('input[name="household"]:checked')].map((i) => i.value),
      commute: value('commute'),
      cooking: value('cooking'),
      heating: value('heating'),
      hasPurifier: $('hasPurifier').checked,
      question: $('question').value,
    });
  }

  async function run() {
    if (busy) return;
    showError('');
    showFieldError('');

    let location;
    try {
      location = parseLocation(coords ?? { city: cityInput.value });
    } catch (err) {
      showFieldError(err.message);
      cityInput.focus();
      return;
    }
    const profile = readProfile();

    results.hidden = true;
    setBusy(true, 'Checking the air…');

    try {
      const report = await loadReport(location);
      renderAir(report);
      setBusy(true, 'Writing your plan…');
      const aiAdvice = await fetchAiAdvice(report, profile);
      renderAdvice(aiAdvice ?? buildRuleAdvice(report, profile), aiAdvice ? 'gemini' : 'rules');

      setBusy(false);
      results.hidden = false;
      drawChart();
      results.focus({ preventScroll: true });
      results.scrollIntoView({ behavior: 'smooth', block: 'start' });

      if (location.city) {
        const url = new URL(window.location.href);
        url.searchParams.set('city', location.city);
        window.history.replaceState(null, '', url);
      }
    } catch (err) {
      setBusy(false);
      showError(err.message || "Couldn't reach the air quality service. Check your connection and try again.");
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run();
  });

  cityInput.addEventListener('input', () => {
    coords = null;
    showFieldError('');
  });

  form.querySelectorAll('.quick-city[data-city]').forEach((btn) => {
    btn.addEventListener('click', () => {
      cityInput.value = btn.dataset.city;
      coords = null;
      run();
    });
  });

  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showFieldError("This browser can't share your location. Type your city instead.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        cityInput.value = 'Where I am';
        showFieldError('');
        run();
      },
      () => showFieldError("Couldn't get your location. Type your city instead."),
      { timeout: 10000, maximumAge: 600000 },
    );
  });

  $('again').addEventListener('click', () => {
    cityInput.value = '';
    coords = null;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    cityInput.focus({ preventScroll: true });
  });

  $('share').addEventListener('click', async () => {
    const btn = $('share');
    try {
      await navigator.clipboard.writeText(window.location.href);
      btn.textContent = 'Link copied';
    } catch {
      btn.textContent = "Couldn't copy the link";
    }
    setTimeout(() => {
      btn.textContent = 'Copy a link to this city';
    }, 2000);
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawChart, 150);
  });

  // Deep link: ?city=Delhi runs straight away.
  const fromUrl = new URLSearchParams(window.location.search).get('city');
  if (fromUrl) {
    cityInput.value = fromUrl.slice(0, 80);
    run();
  }
}

init();
