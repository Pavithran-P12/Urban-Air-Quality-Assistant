/**
 * Application error types. Every error the app raises on purpose is an AppError whose message is
 * written for the person using the app. Anything else (a bug, a browser quirk) is "unexpected":
 * users see a generic sentence and the details only go to the console, sanitised.
 */

export const GENERIC_ERROR_MESSAGE = 'Something went wrong while checking the air. Please try again in a moment.';

/** An error whose message is safe and useful to show to users. */
export class AppError extends Error {
  /**
   * @param {string} message user-facing message (no URLs, keys or internals)
   * @param {number} [status] HTTP-style status for servers and tests
   */
  constructor(message, status = 500) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

/** Bad user input (empty city, impossible coordinates, malformed report). */
export class ValidationError extends AppError {
  constructor(message) {
    super(message, 400);
    this.name = 'ValidationError';
  }
}

/** An upstream data service failed or had no data for the place. */
export class UpstreamError extends AppError {
  constructor(message, status = 502) {
    super(message, status);
    this.name = 'UpstreamError';
  }
}

/**
 * The message to show a user for any thrown value.
 * @param {unknown} err
 * @returns {string}
 */
export function toUserMessage(err) {
  return err instanceof AppError && err.message ? err.message : GENERIC_ERROR_MESSAGE;
}

const URL_PATTERN = /https?:\/\/\S+/gi;
const SECRET_PATTERN = /\b(key|token|secret|apikey)=([^&\s]+)/gi;

/**
 * A log-safe summary of an error: name, status and message with URLs and key-like parameters
 * removed. Never includes the stack trace.
 * @param {unknown} err
 * @returns {{name:string, status?:number, message:string}}
 */
export function describeForLog(err) {
  const name = err instanceof Error ? err.name : typeof err;
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.replace(URL_PATTERN, '[url]').replace(SECRET_PATTERN, '$1=[redacted]').slice(0, 200);
  return { name, ...(err instanceof AppError ? { status: err.status } : {}), message };
}
