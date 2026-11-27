/**
 * Small value checks shared by every module that reads untrusted data (provider responses,
 * client requests, model output). One definition, so "is this a usable number?" means the same
 * thing everywhere.
 */

/**
 * A real, finite number (not NaN, not Infinity, not a numeric string).
 * @param {unknown} value
 * @returns {value is number}
 */
export const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * The value if it is a finite number, otherwise null.
 * @param {unknown} value
 * @returns {number|null}
 */
export const numOrNull = (value) => (isNum(value) ? value : null);

/**
 * A string with at least one non-space character.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isText = (value) => typeof value === 'string' && value.trim().length > 0;
