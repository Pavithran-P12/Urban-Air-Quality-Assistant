/**
 * Input validation and sanitisation for API requests.
 * Everything the user sends is treated as untrusted and normalised to a known shape
 * before it reaches the prompt or any upstream service.
 */

export const OPTIONS = Object.freeze({
  commute: ['walk', 'cycle', 'public-transport', 'two-wheeler', 'car', 'work-from-home'],
  cooking: ['lpg', 'electric', 'induction', 'biomass', 'kerosene', 'piped-gas'],
  heating: ['none', 'electric', 'gas', 'wood', 'coal', 'kerosene'],
  household: ['children', 'elderly', 'pregnant', 'asthma-or-copd', 'heart-condition', 'pets'],
});

const MAX_TEXT = 300;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

/** Strip control characters and angle brackets, collapse whitespace, cap length. */
export function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * Validate a location: either a city name or a lat/lon pair.
 * @returns {{city?:string, latitude?:number, longitude?:number}}
 */
export function parseLocation(input = {}) {
  const lat = Number(input.latitude);
  const lon = Number(input.longitude);
  const hasCoords =
    input.latitude !== undefined && input.longitude !== undefined && input.latitude !== '' && input.longitude !== '';
  if (hasCoords) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new ValidationError('Latitude/longitude are out of range.');
    }
    return { latitude: lat, longitude: lon };
  }
  const city = cleanText(input.city, 80);
  if (city.length < 2) throw new ValidationError('Please enter a city name (at least 2 characters).');
  return { city };
}

/**
 * Validate the household/lifestyle profile.
 */
export function parseProfile(input = {}) {
  const household = Array.isArray(input.household)
    ? [...new Set(input.household.filter((h) => OPTIONS.household.includes(h)))]
    : [];
  return {
    commute: pick(input.commute, OPTIONS.commute, 'public-transport'),
    cooking: pick(input.cooking, OPTIONS.cooking, 'lpg'),
    heating: pick(input.heating, OPTIONS.heating, 'none'),
    household,
    hasPurifier: input.hasPurifier === true,
    question: cleanText(input.question),
  };
}
