/**
 * Rendering for the results page. Every value from the network or the model is written with
 * textContent (never innerHTML), so nothing it contains can become markup.
 */
import { clock } from './lib/time.js';
import { renderForecastChart } from './chart.js';

/** Short, plain-language health message per AQI band. */
const BAND_MESSAGE = {
  good: 'The air is clean. A good day to be outside.',
  moderate: 'Fine for most people. Very sensitive people should take it easy outdoors.',
  sensitive: 'Children, older people and anyone with lung or heart problems should limit time outside.',
  unhealthy: 'Everyone should cut down long or hard activity outdoors.',
  'very-unhealthy': 'Stay indoors as much as you can and keep the windows shut.',
  hazardous: 'Avoid going out. Seal your home and run any purifiers you have.',
  unknown: "We couldn't read the current air quality.",
};

const COST_LABEL = { free: 'Free', low: 'Under ₹1,000', medium: 'Costs a bit more' };
const IMPACT_LABEL = { high: 'Big difference.', medium: 'Some difference.', low: 'Small win.' };

const POLLUTANTS = [
  ['pm2_5', 'PM2.5'],
  ['pm10', 'PM10'],
  ['nitrogen_dioxide', 'NO₂'],
  ['ozone', 'Ozone'],
  ['carbon_monoxide', 'CO'],
];

export const $ = (id) => document.getElementById(id);

/** Create an element with optional class and text (always textContent, never HTML). */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== '') node.textContent = text;
  return node;
}

/** Set the sky to the band's colours after a frame, so the transition from neutral plays once. */
function paintSky(level) {
  const sky = $('sky');
  sky.dataset.level = 'unknown';
  requestAnimationFrame(() => requestAnimationFrame(() => (sky.dataset.level = level)));
}

/**
 * One sentence about the local index, or '' when any part is missing (never "undefined").
 * @param {{code?:string, name?:string, aqi?:number, category?:string}|null|undefined} li
 * @returns {string}
 */
export function localIndexText(li) {
  if (!li || typeof li.aqi !== 'number' || !li.name || !li.category) return '';
  const who = li.code === 'ind_cpcb' ? "India's official index (NAQI)" : `The local index (${li.name})`;
  return `${who} reads ${li.aqi}: ${li.category.toLowerCase()}.`;
}

/**
 * The single sentence screen readers hear when results are ready, e.g.
 * "Results for Chennai, Tamil Nadu, India: US AQI 160, Unhealthy."
 * @param {{name?:string}|null|undefined} place
 * @param {{usAqi?:number, category?:{label?:string}}|null|undefined} air
 * @returns {string}
 */
export function announcementText(place, air) {
  const where = place?.name ? `Results for ${place.name}` : 'Results ready';
  if (typeof air?.usAqi !== 'number') return `${where}.`;
  const level = air.category?.label && air.category.label !== 'Unknown' ? `, ${air.category.label}` : '';
  return `${where}: US AQI ${air.usAqi}${level}.`;
}

/** Write to the page's one polite live region. Clearing first makes a repeated message re-announce. */
export function announce(message) {
  const region = $('announcer');
  region.textContent = '';
  requestAnimationFrame(() => (region.textContent = message));
}

function renderReadings(air) {
  const rows = [];
  for (const [key, label] of POLLUTANTS) {
    const value = air.pollutants[key];
    if (value == null) continue;
    const dd = el('dd', '', `${Math.round(value)} `);
    dd.append(el('span', 'unit', 'µg/m³'));
    if (key === 'pm2_5' && air.pm25WhoMultiple)
      dd.append(el('span', 'note', `${air.pm25WhoMultiple} times the WHO daily limit`));
    rows.push(el('dt', '', label), dd);
  }
  $('pollutants').replaceChildren(...rows);

  const dominant = $('aqi-dominant');
  dominant.hidden = !air.dominant;
  dominant.textContent = air.dominant ? `Most of today's pollution is ${air.dominant.name}.` : '';

  const local = $('aqi-local');
  local.textContent = localIndexText(air.localIndex);
  local.hidden = !local.textContent;
}

function renderSourceNote(air) {
  const s = air.source;
  const when = air.time ? ` Updated ${clock(air.time)} local time.` : '';
  const method = air.aqiEstimated ? ' The US AQI is worked out from PM2.5 with the US EPA formula.' : '';
  const fallback = s.fallback && s.fallbackReason ? `${s.fallbackReason}, so this uses a coarser estimate. ` : '';
  $('data-note').textContent =
    fallback +
    (s.provider === 'google'
      ? `A model estimate from the Google Air Quality API for a 500 m area around this place, not a sensor reading. Streets next to heavy traffic can be worse.${method}${when}`
      : `A model estimate from the CAMS global forecast (via Open-Meteo) for an area about 45 km wide, so every neighbourhood in a city shows similar numbers. Treat it as a city-wide guide.${method}${when}`);
}

function renderForecastText(air, weather) {
  const o = air.outlook;
  const best = air.cleanestHours.find((h) => h.aqi === o?.bestAqi);
  $('hours-note').textContent = !air.cleanestHours.length
    ? "There's no hourly forecast for this place right now, so plan around today's reading."
    : o?.improves && best
      ? `The cleanest hour ahead is around ${clock(best.time)}, when the AQI should drop to about ${best.aqi}. Plan errands and airing out for then.`
      : "The air isn't expected to get much better in the next day, so keep time outside short.";

  const parts = [];
  if (typeof weather?.wind === 'number') parts.push(`wind is ${Math.round(weather.wind)} km/h now`);
  if (typeof weather?.windAtBest === 'number' && best)
    parts.push(`${Math.round(weather.windAtBest)} km/h around ${clock(best.time)}`);
  if (typeof weather?.rainChanceMax24 === 'number' && weather.rainChanceMax24 >= 20)
    parts.push(`there's up to a ${weather.rainChanceMax24}% chance of rain`);
  const line = $('weather-line');
  line.hidden = parts.length === 0;
  line.textContent = parts.length ? `Wind and rain help clear smog: ${parts.join(', ')}.` : '';
}

/** Last chart inputs, so the chart can be drawn once visible and redrawn on resize. */
let lastChart = null;
export function drawChart() {
  if (!lastChart) return;
  const ok = renderForecastChart(
    $('forecast-chart'),
    $('forecast-rows'),
    lastChart.forecast,
    lastChart.best,
    lastChart.weatherHours,
  );
  $('forecast-card').hidden = !ok;
}

export function renderAir({ place, air, weather, weatherHours }) {
  const level = air.category.level;
  $('aqi-place').textContent = place.name;
  $('aqi-number').textContent = air.usAqi;
  $('aqi-label').textContent = air.category.label;
  $('aqi-msg').textContent = BAND_MESSAGE[level] ?? '';
  paintSky(level);
  renderReadings(air);
  renderSourceNote(air);
  renderForecastText(air, weather);
  lastChart = { forecast: air.forecast ?? [], best: air.cleanestHours, weatherHours };
}

export function renderAdvice(advice, source) {
  $('summary').textContent = advice.summary;
  $('risk').textContent = advice.riskNote;
  $('risk-block').hidden = !advice.riskNote;
  $('answer-block').hidden = !advice.answer;
  $('answer').textContent = advice.answer;

  $('routine').replaceChildren(
    ...advice.routine.map((r) => {
      const li = el('li');
      const body = el('div');
      body.append(el('span', 'what', r.action), el('p', 'why', r.why));
      li.append(el('span', 'when', r.time), body);
      return li;
    }),
  );

  $('indoor').replaceChildren(
    ...advice.indoor.map((t) => {
      const li = el('li');
      const head = el('p', 'tip-head');
      head.append(el('span', 'what', t.tip), el('span', 'cost', COST_LABEL[t.cost] ?? ''));
      li.append(head, el('p', 'why', t.why));
      return li;
    }),
  );

  $('alternatives').replaceChildren(
    ...advice.alternatives.map((a) => {
      const li = el('li');
      const impact = el('p', 'impact');
      impact.append(el('span', 'level', `${IMPACT_LABEL[a.impactLevel] ?? ''} `), document.createTextNode(a.impact));
      li.append(el('span', 'from', `Instead of: ${a.instead}`), el('span', 'to', a.try), impact);
      return li;
    }),
  );

  $('source').textContent =
    source === 'gemini'
      ? 'This plan was written by Google Gemini from the numbers above, and checked so it only quotes them.'
      : "This plan comes from built-in safety rules because the AI planner wasn't available.";
}
