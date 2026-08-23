/**
 * Small fetch wrapper shared by the collectors.
 *
 * The important job here is classifying *why* a request failed. A rate limit is
 * not the same as "this market has no discussion", and the pipeline must never
 * blur the two.
 */

const USER_AGENT =
  'startup-opportunity-engine/1.0 (evidence-backed market research; local use)';

/** Source outcome states. Only `no-results` means "completed cleanly, found nothing". */
export const STATE = {
  OK: 'ok',
  NO_RESULTS: 'no-results',
  RATE_LIMITED: 'rate-limited',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  ERROR: 'error',
};

export class HttpError extends Error {
  constructor(message, state) {
    super(message);
    this.name = 'HttpError';
    this.state = state;
  }
}

/**
 * GET JSON with a timeout. Throws HttpError carrying a classified `state`.
 */
export async function getJson(url, { timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      signal: controller.signal,
    });

    if (response.status === 403 || response.status === 429) {
      // GitHub signals search rate limiting with 403 as often as 429.
      throw new HttpError(
        `Rate limited (HTTP ${response.status})`,
        STATE.RATE_LIMITED,
      );
    }
    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status}`, STATE.ERROR);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.name === 'AbortError') {
      throw new HttpError(`Timed out after ${timeoutMs}ms`, STATE.TIMEOUT);
    }
    throw new HttpError(error.message, STATE.UNREACHABLE);
  } finally {
    clearTimeout(timer);
  }
}

/** Wraps a collector so a failure becomes a classified result instead of a crash. */
export async function runCollector(source, fn) {
  try {
    const items = await fn();
    return {
      source,
      state: items.length > 0 ? STATE.OK : STATE.NO_RESULTS,
      items,
      error: null,
    };
  } catch (error) {
    return {
      source,
      state: error instanceof HttpError ? error.state : STATE.ERROR,
      items: [],
      error: error.message,
    };
  }
}
