import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAdminEmails,
  parseGenerationEnabled,
  generationAvailability,
  checkRateLimit,
  _resetRateLimitForTests,
} from '../lib/access.js';

test('parseAdminEmails: empty or unset input yields no admins', () => {
  assert.equal(parseAdminEmails(undefined).size, 0);
  assert.equal(parseAdminEmails('').size, 0);
  assert.equal(parseAdminEmails('  ,  ,').size, 0);
});

test('parseAdminEmails: trims whitespace and lowercases', () => {
  const admins = parseAdminEmails(' Owner@Example.com ,  second@example.com');
  assert.ok(admins.has('owner@example.com'));
  assert.ok(admins.has('second@example.com'));
  assert.equal(admins.size, 2);
});

test('generationAvailability: the kill switch is the whole decision', () => {
  assert.deepEqual(generationAvailability({ enabled: false }), {
    available: false,
    reason: 'disabled',
  });
  assert.deepEqual(generationAvailability({ enabled: true }), {
    available: true,
    reason: null,
  });
});

test('generationAvailability: the deployment environment does not override the switch', () => {
  // Regression. This used to refuse whenever VERCEL was set, which made the
  // switch unreachable in production — GENERATION_ENABLED=true there had no
  // effect at all. Whether generation is on is configuration, not a verdict
  // derived from the hostname.
  const previous = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    assert.deepEqual(generationAvailability({ enabled: true }), {
      available: true,
      reason: null,
    });
    assert.deepEqual(generationAvailability({ enabled: false }), {
      available: false,
      reason: 'disabled',
    });
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});

test('parseGenerationEnabled: fails closed for everything except the literal string "true"', () => {
  assert.equal(parseGenerationEnabled('true'), true);
  assert.equal(parseGenerationEnabled('false'), false);
  assert.equal(parseGenerationEnabled('TRUE'), false);
  assert.equal(parseGenerationEnabled('1'), false);
  assert.equal(parseGenerationEnabled(undefined), false);
  assert.equal(parseGenerationEnabled(''), false);
});

test('checkRateLimit: allows up to max, then blocks within the window', () => {
  _resetRateLimitForTests();
  const key = 'admin@example.com';
  const opts = { windowMs: 60_000, max: 3 };
  assert.equal(checkRateLimit(key, opts), true);
  assert.equal(checkRateLimit(key, opts), true);
  assert.equal(checkRateLimit(key, opts), true);
  assert.equal(checkRateLimit(key, opts), false, 'fourth call within the window should be blocked');
});

test('checkRateLimit: keys are independent of each other', () => {
  _resetRateLimitForTests();
  const opts = { windowMs: 60_000, max: 1 };
  assert.equal(checkRateLimit('a@example.com', opts), true);
  assert.equal(checkRateLimit('a@example.com', opts), false);
  assert.equal(checkRateLimit('b@example.com', opts), true, 'a different key has its own budget');
});

test('checkRateLimit: a request outside the window is allowed again', async () => {
  _resetRateLimitForTests();
  const key = 'admin@example.com';
  assert.equal(checkRateLimit(key, { windowMs: 1, max: 1 }), true);
  assert.equal(checkRateLimit(key, { windowMs: 1, max: 1 }), false);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(checkRateLimit(key, { windowMs: 1, max: 1 }), true, 'window has expired');
});

/**
 * isAdminEmail() reads its allowlist from ADMIN_EMAILS at module load, so the
 * env var has to be set before the module is first imported. A dynamic
 * import after setting it exercises the real end-to-end wiring — the exact
 * three-tier matrix (anonymous, non-admin, admin) server.js relies on.
 */
test('isAdminEmail: anonymous, non-admin, and admin visitors are classified correctly', async () => {
  process.env.ADMIN_EMAILS = 'Owner@Example.com';
  const { isAdminEmail } = await import(`../lib/access.js?test-admin-emails`);

  // Anonymous: no session, so no email at all.
  assert.equal(isAdminEmail(undefined), false);
  assert.equal(isAdminEmail(null), false);

  // Authenticated, but not the admin. Same three free searches as anyone.
  assert.equal(isAdminEmail('random-signup@example.com'), false);

  // The admin — case- and whitespace-insensitive, matching how Better Auth
  // stores/returns the email on session.user.email.
  assert.equal(isAdminEmail('owner@example.com'), true);
  assert.equal(isAdminEmail('  Owner@Example.com  '), true);
});
