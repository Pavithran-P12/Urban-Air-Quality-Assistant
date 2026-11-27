/**
 * Busy state for one search: which controls are locked, and what the loading line says.
 * Kept free of DOM lookups so the timing and announcement rules can be unit-tested.
 */

/**
 * The air-data function gives Google 9 s before giving up, so by this point the app is
 * genuinely moving on to the backup source (Open-Meteo / CAMS).
 */
export const SLOW_NOTICE_MS = 9_000;
export const SLOW_NOTICE_TEXT = 'Still checking… trying a backup source.';

/**
 * Lock (or unlock) every control that would start a search or change the city shown, so the
 * city on screen always matches the search that is running.
 *
 * Buttons get aria-disabled rather than the native disabled attribute: they stay in the Tab order
 * and screen readers announce them as unavailable, instead of silently vanishing mid-search.
 * Because aria-disabled does not block clicks, every click handler also checks the busy flag.
 * @param {{cityInput:{readOnly:boolean}, buttons:Iterable<Pick<Element,'setAttribute'|'removeAttribute'>>}} controls
 * @param {boolean} locked
 */
export function lockSearchControls({ cityInput, buttons }, locked) {
  cityInput.readOnly = locked;
  for (const button of buttons) {
    if (locked) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  }
}

/**
 * The loading line for one search. The visible text and the live region are written only when
 * the text actually changes, and the slow notice replaces the first step at most once.
 * @param {{render:(text:string)=>void, announce:(text:string)=>void, delayMs?:number}} options
 */
export function createLoadingStatus({ render, announce, delayMs = SLOW_NOTICE_MS }) {
  let current = '';
  let timer = null;

  const set = (text) => {
    if (text === current) return;
    current = text;
    render(text);
    announce(text);
  };
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    /** Start the data step; if it is still running after `delayMs`, say a backup is being tried. */
    checking(text) {
      cancel();
      set(text);
      timer = setTimeout(() => {
        timer = null;
        set(SLOW_NOTICE_TEXT);
      }, delayMs);
    },
    /** Move to a later step; a pending slow notice no longer applies. */
    step(text) {
      cancel();
      set(text);
    },
    /** End of the search (results or error). */
    stop() {
      cancel();
      current = '';
    },
    get text() {
      return current;
    },
  };
}
