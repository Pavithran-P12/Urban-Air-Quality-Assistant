/**
 * 48-hour AQI forecast chart: one series, so no legend; the section heading names it.
 * Bars are coloured by AQI band (each band's name is in the tooltip and table, never colour alone),
 * rounded only at the data end, with a 2 px gap. The single cleanest hour gets a direct label.
 * Hover, focus or tap a bar for its value; the full table sits below for screen readers.
 */
import { categorize } from './lib/aqi.js';
import { clock, dayName } from './lib/time.js';
import { isNum } from './lib/guards.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_W = 720;
const MIN_W = 300;
const H = 220;
const PAD = { left: 34, right: 8, top: 34, bottom: 42 };
const GRID = [50, 100, 150, 200, 300];
/** Below this width, label every 12 hours instead of every 6 so tick labels don't collide. */
const NARROW_W = 480;
const BAR_RADIUS = 4;
/** Keep the tooltip this far (px) from the chart's edges so it never overflows. */
const TIP_EDGE = 90;

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

/** A bar whose top corners are rounded (radius r) and whose base sits square on the baseline. */
function barPath({ x, y, w, h }, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x} ${y + h}V${y + rr}Q${x} ${y} ${x + rr} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + h}Z`;
}

const lowestOf = (hours) => hours.reduce((a, b) => (b.aqi < a.aqi ? b : a));
const highestOf = (hours) => hours.reduce((a, b) => (b.aqi > a.aqi ? b : a));

/**
 * The chart's accessible name: span, lowest and highest hour, and how to explore it.
 * @param {{time:string, aqi:number}[]} forecast non-empty
 * @returns {string}
 */
export function chartLabel(forecast) {
  const lo = lowestOf(forecast);
  const hi = highestOf(forecast);
  return `AQI forecast for the next ${forecast.length} hours. Lowest ${lo.aqi} on ${dayName(lo.time)} at ${clock(lo.time)}; highest ${hi.aqi} on ${dayName(hi.time)} at ${clock(hi.time)}. Use the arrow keys to step through hours, or open the table below.`;
}

/**
 * One hour as a sentence, used by the tooltip and the bar's accessible name.
 * @param {{time:string, aqi:number}} hour
 * @param {number|null|undefined} wind km/h
 * @returns {string}
 */
export function hourText(hour, wind) {
  const windText = isNum(wind) ? `, wind ${Math.round(wind)} km/h` : '';
  return `${dayName(hour.time)} ${clock(hour.time)}: AQI ${hour.aqi}, ${categorize(hour.aqi).label}${windText}`;
}

/**
 * Sizes and scales for one render. Drawn at the container's real width so text stays at its real
 * size on phones.
 */
function layout(containerWidth, forecast) {
  const W = Math.round(Math.max(MIN_W, Math.min(MAX_W, containerWidth || MAX_W)));
  const max = Math.min(500, Math.max(150, Math.ceil(Math.max(...forecast.map((h) => h.aqi)) / 50) * 50));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const base = PAD.top + plotH;
  const step = plotW / forecast.length;
  return {
    W,
    max,
    plotH,
    base,
    step,
    gap: Math.min(2, step * 0.3),
    labelStep: W < NARROW_W ? 12 : 6,
    y: (v) => base - (Math.min(v, max) / max) * plotH,
  };
}

/** Horizontal grid lines with their AQI values. */
function drawGrid(geo) {
  const grid = svg('g', { class: 'chart-grid', 'aria-hidden': 'true' });
  for (const t of [0, ...GRID].filter((v) => v <= geo.max)) {
    grid.append(svg('line', { x1: PAD.left, x2: geo.W - PAD.right, y1: geo.y(t), y2: geo.y(t) }));
    grid.append(svg('text', { x: PAD.left - 6, y: geo.y(t) + 4, 'text-anchor': 'end' }, t));
  }
  return grid;
}

/** Where hour i's bar sits. */
function barBox(geo, h, i) {
  const x = PAD.left + i * geo.step + geo.gap / 2;
  const w = Math.max(1, geo.step - geo.gap);
  const top = geo.y(h.aqi);
  return { x, w, top };
}

/** Time ticks every `labelStep` hours, with the day name at midnight. */
function drawTick(bars, geo, h, { x, w }) {
  const hour = Number(h.time.slice(11, 13));
  if (hour % geo.labelStep !== 0) return;
  const tx = x + w / 2;
  bars.append(svg('line', { x1: tx, x2: tx, y1: geo.base, y2: geo.base + 4, class: 'tick' }));
  bars.append(svg('text', { x: tx, y: H - 24, 'text-anchor': 'middle', class: 'tick-label' }, clock(h.time)));
  if (hour === 0)
    bars.append(svg('text', { x: tx, y: H - 6, 'text-anchor': 'middle', class: 'tick-day' }, dayName(h.time)));
}

/** The cleanest hour's label sits in the top margin, above every bar, with a leader down to it. */
function drawBestMarker(bars, geo, h, { x, w, top }) {
  const cx = x + w / 2;
  bars.append(svg('line', { x1: cx, x2: cx, y1: 18, y2: top - 4, class: 'best-leader' }));
  bars.append(svg('circle', { cx, cy: top - 4, r: 2.5, class: 'best-mark' }));
  const anchor = cx > geo.W - 80 ? 'end' : cx < PAD.left + 60 ? 'start' : 'middle';
  bars.append(
    svg(
      'text',
      { x: cx, y: 13, 'text-anchor': anchor, class: 'best-label' },
      `Cleanest: ${clock(h.time)}, AQI ${h.aqi}`,
    ),
  );
}

/** Arrow keys move focus (and the single tab stop) between hours. */
function onArrowKey(hit) {
  return (e) => {
    const next = e.key === 'ArrowRight' ? hit.nextSibling : e.key === 'ArrowLeft' ? hit.previousSibling : null;
    if (!next) return;
    e.preventDefault();
    hit.setAttribute('tabindex', '-1');
    next.setAttribute('tabindex', '0');
    next.focus();
  };
}

/** Show and hide the shared tooltip for one bar, positioned over it in page pixels. */
function tooltipHandlers({ container, tip, bars, geo }, bar, { x, w, top }, text) {
  const show = () => {
    bars.querySelectorAll('.is-active').forEach((b) => b.classList.remove('is-active'));
    bar.classList.add('is-active');
    tip.textContent = text;
    tip.hidden = false;
    const scale = container.clientWidth / geo.W;
    tip.style.left = `${Math.min(Math.max((x + w / 2) * scale, TIP_EDGE), container.clientWidth - TIP_EDGE)}px`;
    tip.style.top = `${top * scale}px`;
  };
  const hide = () => {
    bar.classList.remove('is-active');
    tip.hidden = true;
  };
  return { show, hide };
}

/** Hit target: the full column, wider than the bar, so hover and tap are easy. */
function drawHit(ctx, { i, bar, box, text }) {
  const hit = svg('rect', {
    x: PAD.left + i * ctx.geo.step,
    y: PAD.top,
    width: ctx.geo.step,
    height: ctx.geo.plotH,
    class: 'hit',
    tabindex: i === 0 ? 0 : -1,
    role: 'img',
    'aria-label': text,
  });
  const { show, hide } = tooltipHandlers(ctx, bar, box, text);
  for (const type of ['pointerenter', 'pointerdown', 'focus']) hit.addEventListener(type, show);
  for (const type of ['pointerleave', 'blur']) hit.addEventListener(type, hide);
  hit.addEventListener('keydown', onArrowKey(hit));
  return hit;
}

/** The same data as a table, for screen readers and anyone who prefers numbers. */
function renderTable(tableBody, forecast, best, windAt) {
  const bestTimes = new Set(best.map((h) => h.time));
  for (const h of forecast) {
    const tr = document.createElement('tr');
    const wind = windAt.get(h.time.slice(0, 13));
    for (const text of [
      `${dayName(h.time)} ${clock(h.time)}`,
      String(h.aqi),
      categorize(h.aqi).label,
      isNum(wind) ? `${Math.round(wind)} km/h` : '—',
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    if (bestTimes.has(h.time)) tr.className = 'row-best';
    tableBody.append(tr);
  }
}

/**
 * Render the chart into `container` and the value table into `tableBody`.
 * @param {HTMLElement} container
 * @param {HTMLElement} tableBody
 * @param {{forecast:{time:string, aqi:number}[], best:{time:string, aqi:number}[],
 *   weatherHours?:{time:string, wind:number|null}[]}} data best = cleanest hours (the lowest gets a label)
 * @returns {boolean} whether anything was drawn
 */
export function renderForecastChart(container, tableBody, { forecast, best, weatherHours = [] }) {
  container.replaceChildren();
  tableBody.replaceChildren();
  if (!forecast.length) return false;

  const geo = layout(container.clientWidth, forecast);
  const lowest = best.length ? lowestOf(best) : null;
  const windAt = new Map(weatherHours.map((w) => [w.time.slice(0, 13), w.wind]));
  const root = svg('svg', {
    viewBox: `0 0 ${geo.W} ${H}`,
    class: 'chart-svg',
    role: 'group',
    'aria-label': chartLabel(forecast),
  });
  root.append(drawGrid(geo));

  const bars = svg('g', { 'aria-hidden': 'true' });
  const hits = svg('g');
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  const ctx = { container, tip, bars, geo };

  forecast.forEach((h, i) => {
    const box = barBox(geo, h, i);
    const bar = svg('path', {
      d: barPath({ x: box.x, y: box.top, w: box.w, h: geo.base - box.top }, BAR_RADIUS),
      class: `bar bar-${categorize(h.aqi).level}`,
    });
    bars.append(bar);
    drawTick(bars, geo, h, box);
    if (lowest && h.time === lowest.time) drawBestMarker(bars, geo, h, box);
    hits.append(drawHit(ctx, { i, bar, box, text: hourText(h, windAt.get(h.time.slice(0, 13))) }));
  });

  root.append(bars, hits);
  container.append(root, tip);
  renderTable(tableBody, forecast, best, windAt);
  return true;
}
