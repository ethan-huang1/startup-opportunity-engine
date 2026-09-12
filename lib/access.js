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

/**
 * Read per call, not captured at module load. A kill switch whose value is
 * a boot-time snapshot is not really a switch — and the load-order trap is
 * real: this module is imported transitively by server.js, so anything
 * setting the variable after that import silently had no effect.
 */
export function generationEnabled() {
  return parseGenerationEnabled(process.env.GENERATION_ENABLED);
}

/**
 * Whether this deployment may generate at all, and if not, why — the UI
 * renders the reason rather than offering a button that cannot work.
 *
 * GENERATION_ENABLED is the whole decision, in every environment. This
 * used to refuse outright whenever `VERCEL` was set, which made the kill
 * switch unreachable in production: setting GENERATION_ENABLED=true there
 * changed nothing, because the environment check ran first. Deployment
 * environment is now a matter of configuration, not a hard-coded verdict.
 *
 * What still stands between this and a runaway bill, in order:
 *   1. the admin check in server.js — a non-admin never reaches here;
 *   2. this switch, which fails closed on anything but the literal "true";
 *   3. isClaudeAvailable(), which refuses when there is no CLI to run
 *      (the usual case in a serverless runtime);
 *   4. the per-account rate limit and the system-wide in-flight guard.
 *
 * Swap point for hosted generation: when a Travila-style executor exists,
 * the pipeline's model calls change behind lib/claude.js and this function
 * does not have to change at all.
 */
export function generationAvailability({ enabled = generationEnabled() } = {}) {
  if (!enabled) {
    return { available: false, reason: 'disabled' };
  }
  return { available: true, reason: null };
}

export const GENERATION_UNAVAILABLE_MESSAGE = {
  disabled: 'New analyses are not being generated right now — this deployment serves saved reports.',
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
