/**
 * 48-hour AQI forecast chart: one series, so no legend; the section heading names it.
 * Bars are coloured by AQI band (each band's name is in the tooltip and table, never colour alone),
 * rounded only at the data end, with a 2 px gap. The single cleanest hour gets a direct label.
 * Hover, focus or tap a bar for its value; the full table sits below for screen readers.
 */
import { categorize } from './lib/aqi.js';
import { clock } from './lib/prompt.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_W = 720;
const MIN_W = 300;
const H = 220;
const PAD = { left: 34, right: 8, top: 34, bottom: 42 };
const GRID = [50, 100, 150, 200, 300];
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

function dayName(iso) {
  return DAY.at(new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay());
}

/** A bar whose top corners are rounded (radius r) and whose base sits square on the baseline. */
function barPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x} ${y + h}V${y + rr}Q${x} ${y} ${x + rr} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + h}Z`;
}

/**
 * Render the chart into `container` and the value table into `tableBody`.
 * @param {HTMLElement} container
 * @param {HTMLTableSectionElement} tableBody
 * @param {{time:string, aqi:number}[]} forecast
 * @param {{time:string, aqi:number}[]} best cleanest hours (the lowest gets a label)
 * @param {{time:string, wind:number|null}[]} [weatherHours]
 * @returns {boolean} whether anything was drawn
 */
export function renderForecastChart(container, tableBody, forecast, best, weatherHours = []) {
  container.replaceChildren();
  tableBody.replaceChildren();
  if (!forecast.length) return false;

  // Draw at the container's real width so text stays at its real size on phones.
  const W = Math.round(Math.max(MIN_W, Math.min(MAX_W, container.clientWidth || MAX_W)));
  const labelStep = W < 480 ? 12 : 6;
  const max = Math.min(500, Math.max(150, Math.ceil(Math.max(...forecast.map((h) => h.aqi)) / 50) * 50));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const base = PAD.top + plotH;
  const step = plotW / forecast.length;
  const gap = Math.min(2, step * 0.3);
  const y = (v) => base - (Math.min(v, max) / max) * plotH;
  const lowest = best.length ? best.reduce((a, b) => (b.aqi < a.aqi ? b : a)) : null;

  const lo = forecast.reduce((a, b) => (b.aqi < a.aqi ? b : a));
  const hi = forecast.reduce((a, b) => (b.aqi > a.aqi ? b : a));
  const root = svg('svg', {
    viewBox: `0 0 ${W} ${H}`,
    class: 'chart-svg',
    role: 'group',
    'aria-label': `AQI forecast for the next ${forecast.length} hours. Lowest ${lo.aqi} on ${dayName(lo.time)} at ${clock(lo.time)}; highest ${hi.aqi} on ${dayName(hi.time)} at ${clock(hi.time)}. Use the arrow keys to step through hours, or open the table below.`,
  });

  const grid = svg('g', { class: 'chart-grid', 'aria-hidden': 'true' });
  for (const t of [0, ...GRID].filter((v) => v <= max)) {
    grid.append(svg('line', { x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t) }));
    grid.append(svg('text', { x: PAD.left - 6, y: y(t) + 4, 'text-anchor': 'end' }, t));
  }
  root.append(grid);

  const bars = svg('g', { 'aria-hidden': 'true' });
  const hits = svg('g');
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;

  const windAt = new Map(weatherHours.map((w) => [w.time.slice(0, 13), w.wind]));

  forecast.forEach((h, i) => {
    const x = PAD.left + i * step + gap / 2;
    const w = Math.max(1, step - gap);
    const top = y(h.aqi);
    const band = categorize(h.aqi);
    const bar = svg('path', { d: barPath(x, top, w, base - top, 4), class: `bar bar-${band.level}` });
    bars.append(bar);

    const hour = Number(h.time.slice(11, 13));
    if (hour % labelStep === 0) {
      const tx = x + w / 2;
      bars.append(svg('line', { x1: tx, x2: tx, y1: base, y2: base + 4, class: 'tick' }));
      bars.append(svg('text', { x: tx, y: H - 24, 'text-anchor': 'middle', class: 'tick-label' }, clock(h.time)));
      if (hour === 0) bars.append(svg('text', { x: tx, y: H - 6, 'text-anchor': 'middle', class: 'tick-day' }, dayName(h.time)));
    }

    if (lowest && h.time === lowest.time) {
      const cx = x + w / 2;
      // Label sits in the top margin, above every bar, with a leader down to this hour.
      bars.append(svg('line', { x1: cx, x2: cx, y1: 18, y2: top - 4, class: 'best-leader' }));
      bars.append(svg('circle', { cx, cy: top - 4, r: 2.5, class: 'best-mark' }));
      const anchor = cx > W - 80 ? 'end' : cx < PAD.left + 60 ? 'start' : 'middle';
      bars.append(svg('text', { x: cx, y: 13, 'text-anchor': anchor, class: 'best-label' }, `Cleanest: ${clock(h.time)}, AQI ${h.aqi}`));
    }

    // Hit target: the full column, wider than the bar, so hover and tap are easy.
    const wind = windAt.get(h.time.slice(0, 13));
    const text = `${dayName(h.time)} ${clock(h.time)}: AQI ${h.aqi}, ${band.label}${typeof wind === 'number' ? `, wind ${Math.round(wind)} km/h` : ''}`;
    const hit = svg('rect', {
      x: PAD.left + i * step,
      y: PAD.top,
      width: step,
      height: plotH,
      class: 'hit',
      tabindex: i === 0 ? 0 : -1,
      role: 'img',
      'aria-label': text,
    });
    const show = () => {
      bars.querySelectorAll('.is-active').forEach((b) => b.classList.remove('is-active'));
      bar.classList.add('is-active');
      tip.textContent = text;
      tip.hidden = false;
      const scale = container.clientWidth / W;
      tip.style.left = `${Math.min(Math.max((x + w / 2) * scale, 90), container.clientWidth - 90)}px`;
      tip.style.top = `${top * scale}px`;
    };
    const hide = () => {
      bar.classList.remove('is-active');
      tip.hidden = true;
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', (e) => {
      const next = e.key === 'ArrowRight' ? hit.nextSibling : e.key === 'ArrowLeft' ? hit.previousSibling : null;
      if (next) {
        e.preventDefault();
        hit.setAttribute('tabindex', '-1');
        next.setAttribute('tabindex', '0');
        next.focus();
      }
    });
    hits.append(hit);
  });

  root.append(bars, hits);
  container.append(root, tip);

  const bestTimes = new Set(best.map((h) => h.time));
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
