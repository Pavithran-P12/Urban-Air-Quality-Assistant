/**
 * 48-hour AQI forecast chart, drawn as accessible SVG with plain DOM APIs (no library).
 * Bars are coloured by AQI band; the cleanest hours are outlined. A summary is exposed via
 * aria-label, and the full values are rendered as a table for screen readers and keyboard users.
 */
import { categorize } from './lib/aqi.js';
import { clock } from './lib/prompt.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_W = 720;
const MIN_W = 320;
const H = 210;
const PAD = { left: 40, right: 12, top: 14, bottom: 40 };
const BAND_THRESHOLDS = [50, 100, 150, 200, 300];

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayName(iso) {
  return DAY.at(new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay());
}

/**
 * Render the chart into `container` and the value table into `tableBody`.
 * @param {HTMLElement} container
 * @param {HTMLTableSectionElement} tableBody
 * @param {{time:string, aqi:number}[]} forecast
 * @param {{time:string, aqi:number}[]} best cleanest hours to highlight
 * @param {{time:string, wind:number|null}[]} [weatherHours]
 */
export function renderForecastChart(container, tableBody, forecast, best, weatherHours = []) {
  container.replaceChildren();
  tableBody.replaceChildren();
  if (!forecast.length) return false;

  // Draw at the container's real width so labels stay readable on phones (SVG text scales with the viewBox).
  const W = Math.round(Math.max(MIN_W, Math.min(MAX_W, container.clientWidth || MAX_W)));
  const labelStep = W < 480 ? 12 : 6;

  const max = Math.min(500, Math.max(150, Math.ceil(Math.max(...forecast.map((h) => h.aqi)) / 50) * 50));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const bw = plotW / forecast.length;
  const y = (v) => PAD.top + plotH - (Math.min(v, max) / max) * plotH;
  const bestTimes = new Set(best.map((h) => h.time));

  const lo = forecast.reduce((a, b) => (b.aqi < a.aqi ? b : a));
  const hi = forecast.reduce((a, b) => (b.aqi > a.aqi ? b : a));
  const label =
    `${forecast.length}-hour AQI forecast. Lowest ${lo.aqi} at ${dayName(lo.time)} ${clock(lo.time)}, ` +
    `highest ${hi.aqi} at ${dayName(hi.time)} ${clock(hi.time)}.`;

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label, class: 'chart-svg' });

  const grid = svg('g', { class: 'chart-grid', 'aria-hidden': 'true' });
  for (const t of [0, ...BAND_THRESHOLDS].filter((v) => v <= max)) {
    grid.append(svg('line', { x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t) }));
    grid.append(svg('text', { x: PAD.left - 6, y: y(t) + 4, 'text-anchor': 'end' }, t));
  }
  root.append(grid);

  const bars = svg('g', { 'aria-hidden': 'true' });
  forecast.forEach((h, i) => {
    const x = PAD.left + i * bw;
    const isBest = bestTimes.has(h.time);
    bars.append(
      svg('rect', {
        x: x + 1,
        y: y(h.aqi),
        width: Math.max(1, bw - 2),
        height: PAD.top + plotH - y(h.aqi),
        rx: 2,
        class: `bar bar-${categorize(h.aqi).level}${isBest ? ' bar-best' : ''}`,
      }),
    );
    const hour = Number(h.time.slice(11, 13));
    if (hour % labelStep === 0) {
      const tx = x + bw / 2;
      bars.append(svg('line', { x1: tx, x2: tx, y1: PAD.top + plotH, y2: PAD.top + plotH + 4, class: 'tick' }));
      bars.append(svg('text', { x: tx, y: H - 22, 'text-anchor': 'middle', class: 'tick-label' }, clock(h.time)));
      if (hour === 0) bars.append(svg('text', { x: tx, y: H - 6, 'text-anchor': 'middle', class: 'tick-day' }, dayName(h.time)));
    }
  });
  root.append(bars);
  container.append(root);

  const windAt = new Map(weatherHours.map((w) => [w.time.slice(0, 13), w.wind]));
  for (const h of forecast) {
    const tr = document.createElement('tr');
    const wind = windAt.get(h.time.slice(0, 13));
    for (const text of [
      `${dayName(h.time)} ${clock(h.time)}`,
      String(h.aqi),
      categorize(h.aqi).label,
      typeof wind === 'number' ? `${Math.round(wind)} km/h` : '—',
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    if (bestTimes.has(h.time)) tr.className = 'row-best';
    tableBody.append(tr);
  }
  return true;
}
