/**
 * Forecast windows shared by the browser and the air-data Edge Function. Both sides must agree on
 * what a "complete" forecast is, because only complete answers are cached (server and browser).
 * The function imports this file directly, the same way air-advice imports docs/lib modules.
 */

/** Hours of hourly forecast the app asks for and shows in the chart. */
export const FORECAST_HOURS = 48;

/** A forecast shorter than this is treated as incomplete: shown, but never cached. */
export const MIN_COMPLETE_HOURS = 24;

/** The window searched for the cleanest hours and the rain outlook ("the next day"). */
export const LOOKAHEAD_HOURS = 24;
