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

/** Research/generation and run-history routes — everything admin-only. */
export function isAdminRoute(pathname) {
  return pathname === '/api/analyses' || pathname === '/api/runs' || pathname.startsWith('/api/runs/');
}

// Fail-closed: only the literal string "true" turns generation on. Unset,
// misspelled, or any other value keeps it off.
export function parseGenerationEnabled(value) {
  return value === 'true';
}

export const GENERATION_ENABLED = parseGenerationEnabled(process.env.GENERATION_ENABLED);

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
