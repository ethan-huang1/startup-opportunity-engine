/**
 * Server-side authorization and kill-switch config for admin-only routes.
 * Nothing here trusts the client — every check re-derives from env vars and
 * the session the server already verified against Better Auth.
 */

export function parseAdminEmails(raw) {
  return new Set(
    (raw || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const ADMIN_EMAILS = parseAdminEmails(process.env.ADMIN_EMAILS);

export function isAdminEmail(email) {
  return typeof email === 'string' && ADMIN_EMAILS.has(email.trim().toLowerCase());
}

/**
 * Only generation is admin-only. Reading saved analyses (/api/runs,
 * /api/runs/:slug) is open to any signed-in account — that is the product.
 * Writing one costs real money and real third-party quota, so it is not.
 */
export function isAdminRoute(pathname) {
  return pathname === '/api/analyses';
}

// Fail-closed: only the literal string "true" turns generation on. Unset,
// misspelled, or any other value keeps it off.
export function parseGenerationEnabled(value) {
  return value === 'true';
}

export const GENERATION_ENABLED = parseGenerationEnabled(process.env.GENERATION_ENABLED);

// Vercel sets this on every invocation. Generation shells out to the local
// `claude` CLI and to python3, neither of which exists there — but that
// absence is an accident of the runtime, not a control. This is the control.
export const IS_SERVERLESS = Boolean(process.env.VERCEL);

/**
 * Whether this deployment may generate at all, and if not, why — the UI
 * renders the reason rather than offering a button that cannot work.
 *
 * Swap point for hosted generation: when a Travila-style executor exists,
 * `local-only` becomes "dispatch to the executor" instead of a refusal, and
 * nothing else in the server has to change.
 */
export function generationAvailability({
  enabled = GENERATION_ENABLED,
  serverless = IS_SERVERLESS,
} = {}) {
  if (serverless) {
    return { available: false, reason: 'local-only' };
  }
  if (!enabled) {
    return { available: false, reason: 'disabled' };
  }
  return { available: true, reason: null };
}

export const GENERATION_UNAVAILABLE_MESSAGE = {
  'local-only':
    'New analyses are generated locally and published here. This deployment serves saved reports only.',
  disabled: 'Report generation is currently disabled.',
};

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const hits = new Map();

/**
 * Basic per-key request cap, in memory.
 * ponytail: resets on cold start and isn't shared across warm instances —
 * fine as a basic brake on a single admin account. A Postgres-backed limiter
 * would be needed for a real cross-instance guarantee.
 */
export function checkRateLimit(key, { windowMs = RATE_LIMIT_WINDOW_MS, max = RATE_LIMIT_MAX } = {}) {
  const now = Date.now();
  const timestamps = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= max) {
    hits.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  hits.set(key, timestamps);
  return true;
}

/** Test-only: clears rate-limit state between test cases. */
export function _resetRateLimitForTests() {
  hits.clear();
}
