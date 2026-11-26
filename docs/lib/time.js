/**
 * Formatting for the app's local time strings ("YYYY-MM-DDTHH:MM", no zone).
 * Kept separate from prompt and UI code so every module formats time the same way.
 */

const DAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const LOCAL_ISO = /T\d{2}:/;

/**
 * "2026-11-26T14:00" → "2 PM". Returns "?" for anything that is not a local time string.
 * @param {string} iso
 * @returns {string}
 */
export function clock(iso) {
  if (typeof iso !== 'string' || !LOCAL_ISO.test(iso)) return '?';
  const h = Number(iso.slice(11, 13));
  return `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`;
}

/**
 * "2026-11-26T14:00" → "Thu". The date part is read as a calendar date, so no time zone shifts it.
 * @param {string} iso
 * @returns {string}
 */
export function dayName(iso) {
  return DAYS.at(new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay());
}
