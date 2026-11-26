import { getAirReport } from './lib/airQuality.js';
import { buildRuleAdvice } from './lib/rules.js';
import { parseLocation, parseProfile } from './lib/validate.js';
import { normaliseAdvice } from './lib/advice.js';
import { ADVICE_FUNCTION_URL, ADVICE_TIMEOUT_MS, AIR_DATA_FUNCTION_URL, REPORT_CACHE_MS } from './config.js';
import { renderForecastChart } from './chart.js';

/** Short, plain-language health message per AQI band. */
const BAND_MESSAGE = {
  good: 'Air is clean. Enjoy time outdoors.',
  moderate: 'Acceptable for most. Very sensitive people should take it easy outdoors.',
  sensitive: 'Children, elderly and people with lung or heart conditions should limit time outside.',
  unhealthy: 'Everyone should cut down long or intense outdoor activity.',
  'very-unhealthy': 'Health alert. Stay indoors as much as possible and keep windows closed.',
  hazardous: 'Emergency conditions. Avoid going outside; seal your home and run purifiers.',
  unknown: 'We could not read the current air quality.',
};

const BAND_VAR = {
  good: '--aqi-good',
  moderate: '--aqi-moderate',
  sensitive: '--aqi-sensitive',
  unhealthy: '--aqi-unhealthy',
  'very-unhealthy': '--aqi-very',
  hazardous: '--aqi-hazard',
};

const COST_LABEL = { free: 'Free', low: 'Low cost', medium: 'Some cost' };
const IMPACT_LABEL = { high: 'High impact', medium: 'Medium impact', low: 'Small win' };

const POLLUTANTS = [
  ['pm2_5', 'PM2.5'],
  ['pm10', 'PM10'],
  ['nitrogen_dioxide', 'NO₂'],
  ['ozone', 'O₃'],
  ['carbon_monoxide', 'CO'],
];

const $ = (id) => document.getElementById(id);

/** Create an element with optional class and text (always textContent, never HTML). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== '') node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function hourLabel(iso) {
  const h = Number(iso?.slice(11, 13));
  if (!Number.isFinite(h)) return '';
  return `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** Position on the gauge: bands are drawn 1:1:1:1:2:4 over 0–500, matching AQI breakpoints. */
function gaugePercent(aqi) {
  const v = Math.max(0, Math.min(500, aqi));
  return (v / 500) * 100;
}

/** Ask the Gemini-backed Edge Function for advice; null on any failure so we can fall back. */
async function fetchAiAdvice(report, profile) {
  try {
    const res = await fetch(ADVICE_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: { place: report.place, air: { ...report.air, forecast: undefined }, weather: report.weather }, profile }),
      signal: AbortSignal.timeout(ADVICE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.advice ? normaliseAdvice(data.advice) : null;
  } catch {
    return null;
  }
}

/* ---------- Rendering ---------- */

function badge(text, className = '') {
  const li = el('li', `badge-chip ${className}`.trim(), text);
  return li;
}

function renderSource(air) {
  const s = air.source;
  $('source-badges').replaceChildren(
    badge(s.kind === 'measured' ? 'Measured' : 'Modelled', s.kind === 'measured' ? 'chip-measured' : 'chip-modelled'),
    badge(`${s.label} · ${s.resolution}`),
    ...(air.aqiEstimated ? [badge(air.aqiMethod)] : []),
  );
  const local = $('aqi-local');
  local.hidden = !air.localIndex;
  if (air.localIndex) local.textContent = `Local index ${air.localIndex.name}: ${air.localIndex.aqi}, ${air.localIndex.category}`;
  $('data-note').textContent =
    s.provider === 'google'
      ? 'Estimated for a 500 m grid cell around this location. Nearby streets can differ, especially next to busy roads.'
      : 'Estimated for a grid cell about 45 km wide, so neighbourhoods within a city all show similar values. Treat it as a city-wide guide.';
}

function renderWeather(w, best) {
  const line = $('weather-line');
  const parts = [];
  if (typeof w?.temperature === 'number') parts.push(`${Math.round(w.temperature)}°C`);
  if (typeof w?.wind === 'number') parts.push(`wind ${Math.round(w.wind)} km/h now`);
  if (typeof w?.windAtBest === 'number' && best) parts.push(`${Math.round(w.windAtBest)} km/h around ${hourLabel(best.time)}`);
  if (typeof w?.rainChanceMax24 === 'number' && w.rainChanceMax24 >= 20) parts.push(`up to ${w.rainChanceMax24}% chance of rain`);
  line.hidden = parts.length === 0;
  line.textContent = parts.length ? `Weather: ${parts.join(' · ')}. Wind and rain help clear smog.` : '';
}

/** Last chart inputs, so the chart can be drawn once its card is visible (and redrawn on resize). */
let lastChart = null;
function drawChart() {
  if (!lastChart) return;
  const ok = renderForecastChart($('forecast-chart'), $('forecast-rows'), lastChart.forecast, lastChart.best, lastChart.weatherHours);
  $('forecast-card').hidden = !ok;
}

function renderAir({ place, air, weather, weatherHours }) {
  const level = air.category.level;
  const card = $('aqi-card');
  card.style.setProperty('--aqi', `var(${BAND_VAR[level] ?? '--color-primary'})`);

  $('aqi-place').textContent = place.name;
  $('aqi-time').textContent = air.time ? `Updated ${hourLabel(air.time)} local time` : '';
  $('aqi-number').textContent = air.usAqi;
  const dominant = $('aqi-dominant');
  dominant.hidden = !air.dominant;
  dominant.textContent = air.dominant ? `Main pollutant: ${air.dominant.name}` : '';
  $('aqi-label').textContent = air.category.label;
  $('aqi-msg').textContent = BAND_MESSAGE[level] ?? '';

  $('gauge-marker').style.setProperty('--pos', `${gaugePercent(air.usAqi)}%`);
  $('gauge').setAttribute('aria-label', `AQI ${air.usAqi} on a scale of 0 to 500: ${air.category.label}`);

  const tiles = POLLUTANTS.filter(([key]) => air.pollutants[key] != null).map(([key, label]) => {
    const wrap = el('div', 'tile');
    const dd = el('dd', '', `${Math.round(air.pollutants[key])} `);
    dd.append(el('small', '', 'µg/m³'));
    if (key === 'pm2_5' && air.pm25WhoMultiple) {
      dd.append(el('span', 'note', `${air.pm25WhoMultiple}× WHO daily limit`));
    }
    wrap.append(el('dt', '', label), dd);
    return wrap;
  });
  $('pollutants').replaceChildren(...tiles);

  $('hours-block').hidden = air.cleanestHours.length === 0;
  $('hours').replaceChildren(
    ...air.cleanestHours.map((h) => {
      const li = el('li', '', `${hourLabel(h.time)} `);
      li.append(el('span', '', `AQI ${h.aqi}`));
      return li;
    }),
  );
  renderSource(air);
  const best = air.cleanestHours.find((h) => h.aqi === air.outlook?.bestAqi);
  renderWeather(weather, best);
  lastChart = { forecast: air.forecast ?? [], best: air.cleanestHours, weatherHours };
  const o = air.outlook;
  $('hours-note').textContent = o?.improves
    ? `About ${o.drop} points cleaner than now. Plan errands and airing out for then.`
    : 'No big improvement expected in the next 24 hours.';
}

function renderAdvice(advice, source) {
  $('summary').textContent = advice.summary;
  $('risk').textContent = advice.riskNote;
  $('risk-block').hidden = !advice.riskNote;
  $('answer-block').hidden = !advice.answer;
  $('answer').textContent = advice.answer;

  $('routine').replaceChildren(
    ...advice.routine.map((r) => {
      const li = el('li');
      li.append(el('span', 'when', r.time), el('span', 'what', r.action), el('p', 'why', r.why));
      return li;
    }),
  );

  $('indoor').replaceChildren(
    ...advice.indoor.map((t) => {
      const li = el('li');
      const head = el('div', 'item-head');
      head.append(el('span', 'what', t.tip), el('span', `badge badge-cost-${t.cost}`, COST_LABEL[t.cost] ?? ''));
      li.append(head, el('p', 'why', t.why));
      return li;
    }),
  );

  $('alternatives').replaceChildren(
    ...advice.alternatives.map((a) => {
      const li = el('li');
      const row = el('div', 'swap-row');
      row.append(el('span', 'swap-from', a.instead), icon('arrow'), el('span', 'swap-to', a.try));
      const impact = el('p', 'impact');
      impact.append(el('strong', `level-${a.impactLevel}`, `${IMPACT_LABEL[a.impactLevel] ?? 'Impact'}`), el('span', '', a.impact));
      li.append(row, impact);
      return li;
    }),
  );

  $('source').textContent =
    source === 'gemini'
      ? 'Plan generated by Gemini from live air data.'
      : 'Plan generated by built-in guidance rules from live air data.';
}

/* ---------- App ---------- */

function init() {
  const form = $('advice-form');
  const cityInput = $('city');
  const submit = $('submit');
  const submitText = submit.querySelector('.btn-text');
  const results = $('results');
  const skeleton = $('skeleton');
  const personalise = form.querySelector('.personalise');
  let coords = null;
  let busy = false;
  const reportCache = new Map();

  /** Look up a place, reusing a recent result for the same place in this tab. */
  async function loadReport(location) {
    const key = location.city ? `c:${location.city.toLowerCase()}` : `g:${location.latitude.toFixed(3)},${location.longitude.toFixed(3)}`;
    const hit = reportCache.get(key);
    if (hit && Date.now() - hit.at < REPORT_CACHE_MS) return hit.report;
    const report = await getAirReport(location, fetch, { airDataUrl: AIR_DATA_FUNCTION_URL });
    reportCache.set(key, { at: Date.now(), report });
    return report;
  }

  // Collapse the optional section on small screens so the search is the first thing people see.
  if (window.matchMedia('(max-width: 480px)').matches) personalise.open = false;

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
    const spinner = submit.querySelector('.spinner');
    if (on && !spinner) submit.prepend(el('span', 'spinner'));
    if (!on && spinner) spinner.remove();
    submit.querySelector('.icon').hidden = on;
    submitText.textContent = label ?? 'Get my clean-air plan';
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

    setBusy(true, 'Checking the air…');
    results.hidden = true;
    skeleton.hidden = false;
    skeleton.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const report = await loadReport(location);
      renderAir(report);
      setBusy(true, 'Building your plan…');
      const aiAdvice = await fetchAiAdvice(report, profile);
      renderAdvice(aiAdvice ?? buildRuleAdvice(report, profile), aiAdvice ? 'gemini' : 'rules');

      skeleton.hidden = true;
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
      skeleton.hidden = true;
      showError(err.message || 'Could not reach the air quality service. Please try again.');
    } finally {
      setBusy(false);
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

  form.querySelectorAll('.quick-city').forEach((btn) => {
    btn.addEventListener('click', () => {
      cityInput.value = btn.dataset.city;
      coords = null;
      run();
    });
  });

  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showFieldError('Location is not available in this browser. Please type your city.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        cityInput.value = 'My location';
        showFieldError('');
        run();
      },
      () => showFieldError('Could not get your location. Please type your city instead.'),
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
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => {
      btn.textContent = 'Copy link to this city';
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
