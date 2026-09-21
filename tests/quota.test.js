/**
 * The three-free-searches model, end to end.
 *
 * SAFETY — read before editing. Every HTTP request in this file sends the
 * market "ab", which is below server.js's 3-character minimum. The route
 * validates the market *after* the kill switch, the `claude` preflight and
 * the read-only meter check, but *before* `anyRunInProgress()`,
 * `consumeSearch()`, `beginRun()` and `streamRun()`. So:
 *
 *   - reaching 400 proves the request got past every gate this file cares
 *     about, while guaranteeing no pipeline starts and nothing is billed;
 *   - a 429 `quota` proves the meter refused it before that.
 *
 * Spending searches is therefore done against lib/usage.js directly, which
 * is the enforcement point itself. Do not swap "ab" for a real market: with
 * generation enabled and the CLI present, that launches a real multi-minute
 * billed run from the test suite.
 */

import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';

/**
 * Belt and braces on top of the "ab" rule above: if any assertion here ever
 * does reach the pipeline, it fails loudly instead of quietly billing.
 *
 * Re-armed by actAs() because mock.restoreAll() would otherwise disarm it —
 * the guard has to outlive every identity switch, or it stops guarding
 * exactly the tests that flip GENERATION_ENABLED on.
 */
function guardSpawn() {
  mock.method(childProcess, 'spawn', () => {
    throw new Error('no test in this file may spawn a subprocess');
  });
}
guardSpawn();

/** Deliberately below the 3-character minimum. See SAFETY above. */
const UNRUNNABLE_MARKET = 'ab';
const ADMIN_EMAIL = 'quota-test-admin@example.com';

let base;
let handler = () => {};
let auth;
let sql;
let usage;
let resetRateLimit = () => {};
const server = createServer((request, response) => handler(request, response));
const dbTest = { skip: !process.env.DATABASE_URL && 'DATABASE_URL not set' };

/** Every counter this file touches, so `after` can clean up exactly them. */
const touched = new Set();

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // Both read at module load, so they have to be set before the imports.
  process.env.BETTER_AUTH_URL = base;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  delete process.env.VERCEL;

  ({ auth } = await import('../lib/auth.js'));
  ({ handleRequest: handler } = await import('../server.js'));
  ({ sql } = await import('../lib/db.js'));
  ({ _resetRateLimitForTests: resetRateLimit } = await import('../lib/access.js'));
  usage = await import('../lib/usage.js');
});

after(async () => {
  for (const id of touched) await sql`DELETE FROM usage_counters WHERE id = ${id}`;
  await new Promise((resolve) => server.close(resolve));
});

/**
 * Signing in for real would need a password and a database round trip per
 * case; identity is not what is under test here, the meter after it is. So
 * the session is mocked and everything downstream is the real route,
 * reading the real ADMIN_EMAILS.
 */
function actAs(email) {
  mock.restoreAll();
  guardSpawn();
  mock.method(auth.api, 'getSession', async () => (email ? { user: { email } } : null));
}

beforeEach(() => {
  // Default identity: nobody at all. Individual tests override.
  actAs(null);
  // The in-memory rate limit is shared across this file and is not what any
  // test here is asserting; leaving it to accumulate would make the last
  // few cases fail for the wrong reason.
  resetRateLimit();
});

/** A visitor nobody else in the suite shares, so counts cannot collide. */
function newVisitor() {
  const id = randomUUID();
  touched.add(`v:${id}`);
  return id;
}

/**
 * The per-network backstop is shared by every request from one address, so
 * a test that spends ten searches would exhaust it for the tests after it.
 * Each test therefore spends against its own fake address.
 */
function fakeRequest(networkAddress) {
  const request = { headers: { 'x-vercel-forwarded-for': networkAddress } };
  touched.add(usage.networkKey(request));
  return request;
}

/** An HTTP attempt to generate, carrying a visitor cookie. */
async function attemptGeneration(visitorId) {
  const response = await fetch(`${base}/api/analyses`, {
    method: 'POST',
    headers: {
      origin: base,
      'content-type': 'application/json',
      ...(visitorId ? { cookie: `soe_visitor=${visitorId}` } : {}),
    },
    body: JSON.stringify({ market: UNRUNNABLE_MARKET }),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text, headers: response.headers };
}

async function sessionFor(visitorId) {
  const response = await fetch(`${base}/api/session`, {
    headers: { origin: base, ...(visitorId ? { cookie: `soe_visitor=${visitorId}` } : {}) },
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

/* --------------------------------------------- the app is open to anyone */

test('a visitor with no account can load the page and read saved analyses', dbTest, async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200, 'the landing page must not require an account');

  const list = await fetch(`${base}/api/runs`);
  assert.equal(list.status, 200, 'browsing the catalogue must not require an account');
  assert.ok(Array.isArray(await list.json()));

  const missing = await fetch(`${base}/api/runs/definitely-not-a-real-market-xyz`);
  assert.equal(missing.status, 404, 'a market with no report is a 404, not a 401');

  const session = await sessionFor(null);
  assert.equal(session.status, 200, '/api/session must answer an anonymous visitor');
  assert.equal(session.body.email, null);
  assert.equal(session.body.isAdmin, false);
  assert.deepEqual(session.body.quota, { unlimited: false, limit: 3, used: 0, remaining: 3 });
});

test('the first response mints a visitor cookie that later requests carry', dbTest, async () => {
  const fresh = await fetch(base);
  const setCookie = (fresh.headers.getSetCookie?.() ?? []).join('; ');
  assert.match(setCookie, /soe_visitor=[0-9a-f-]{36}/, 'the page itself should mint the id');
  assert.match(setCookie, /HttpOnly/, 'no script needs to read it');
  assert.match(setCookie, /SameSite=Lax/);

  // And a request that already has one is not re-issued a different id.
  const visitorId = newVisitor();
  const again = await sessionFor(visitorId);
  assert.equal((again.headers.getSetCookie?.() ?? []).length, 0, 'an existing id is left alone');
});

/* -------------------------------------------------- the meter, 1 / 2 / 3 */

test('searches one, two and three are allowed and the fourth is not', dbTest, async () => {
  const visitorId = newVisitor();
  const request = fakeRequest('203.0.113.10');

  for (let n = 1; n <= 3; n += 1) {
    const spent = await usage.consumeSearch(visitorId, request);
    assert.deepEqual(spent, { ok: true }, `search ${n} should be allowed`);
    assert.equal((await usage.getUsage(visitorId)).remaining, 3 - n);
  }

  const fourth = await usage.consumeSearch(visitorId, request);
  assert.deepEqual(fourth, { ok: false, reason: 'quota' }, 'the fourth must be refused');
  assert.equal((await usage.getUsage(visitorId)).remaining, 0, 'a refusal spends nothing');
});

test('the count is a fact in Postgres, so re-reading it never resets it', dbTest, async () => {
  const visitorId = newVisitor();
  await usage.consumeSearch(visitorId, fakeRequest('203.0.113.11'));

  // What a page refresh does: a fresh process/connection asking again.
  // Nothing in this path can move the number.
  for (let i = 0; i < 3; i += 1) {
    const seen = await usage.getUsage(visitorId);
    assert.deepEqual(seen, { limit: 3, used: 1, remaining: 2 }, 'reading must not consume');
  }

  const [row] = await sql`SELECT used FROM usage_counters WHERE id = ${`v:${visitorId}`}`;
  assert.equal(row.used, 1, 'the row itself is the source of truth');
});

test('the per-network backstop caps a visitor who keeps clearing the cookie', dbTest, async () => {
  const request = fakeRequest('203.0.113.12');
  let allowed = 0;
  // A fresh cookie every time — the cookie counter can never refuse this.
  for (let i = 0; i < usage.IP_DAILY_LIMIT + 2; i += 1) {
    const spent = await usage.consumeSearch(newVisitor(), request);
    if (spent.ok) allowed += 1;
    else assert.equal(spent.reason, 'ip-quota');
  }
  assert.equal(allowed, usage.IP_DAILY_LIMIT, 'the network cap is what stops the loop');
});

test('a network refusal does not charge the visitor whose cookie was fresh', dbTest, async () => {
  const request = fakeRequest('203.0.113.13');
  for (let i = 0; i < usage.IP_DAILY_LIMIT; i += 1) await usage.consumeSearch(newVisitor(), request);

  const unlucky = newVisitor();
  const spent = await usage.consumeSearch(unlucky, request);
  assert.deepEqual(spent, { ok: false, reason: 'ip-quota' });
  assert.equal(
    (await usage.getUsage(unlucky)).remaining,
    3,
    'their own allowance is untouched — the shared network ran out, not them',
  );
});

test('a refund puts back exactly one search', dbTest, async () => {
  const visitorId = newVisitor();
  const request = fakeRequest('203.0.113.14');
  await usage.consumeSearch(visitorId, request);
  await usage.consumeSearch(visitorId, request);
  await usage.refundSearch(visitorId, request);
  assert.equal((await usage.getUsage(visitorId)).remaining, 2);
});

/* -------------------------------------------- the route enforces it too */

test('a direct API call cannot bypass the limit', dbTest, async () => {
  process.env.GENERATION_ENABLED = 'true';
  const visitorId = newVisitor();
  const request = fakeRequest('203.0.113.20');
  for (let i = 0; i < 3; i += 1) await usage.consumeSearch(visitorId, request);

  // No browser involved: a bare POST with the cookie, exactly what curl
  // would send. The server, not the page, is what says no.
  const refused = await attemptGeneration(visitorId);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.reason, 'quota');
  assert.equal(refused.body.error, "You've used your 3 free searches.");
});

test('sending no cookie at all does not hand out a bypass', dbTest, async () => {
  process.env.GENERATION_ENABLED = 'true';
  // A cookie-less caller is simply a new visitor with three searches, and
  // the network backstop is what bounds how many of those one machine can
  // mint. Reaching market validation proves the meter let this one past —
  // and that it was a *new* identity, freshly issued by this response.
  const attempt = await attemptGeneration(null);
  assert.notEqual(attempt.status, 429, 'a brand-new visitor has searches to spend');
  const issued = (attempt.headers.getSetCookie?.() ?? []).join('; ');
  const minted = issued.match(/soe_visitor=([0-9a-f-]{36})/);
  if (minted) touched.add(`v:${minted[1]}`);
  assert.ok(minted, 'the response should pin the caller to a new id');
});

test('a garbage cookie is treated as a new visitor, never as a database key', dbTest, async () => {
  process.env.GENERATION_ENABLED = 'true';
  const attempt = await fetch(`${base}/api/session`, {
    headers: { origin: base, cookie: "soe_visitor=v:'; DROP TABLE usage_counters; --" },
  });
  const body = await attempt.json();
  assert.equal(body.quota.remaining, 3, 'an unusable id is just a new visitor');
  const issued = (attempt.headers.getSetCookie?.() ?? []).join('; ');
  const minted = issued.match(/soe_visitor=([0-9a-f-]{36})/);
  if (minted) touched.add(`v:${minted[1]}`);
  assert.ok(minted, 'and it is replaced with a well-formed one');

  const [{ n }] = await sql`SELECT count(*)::int AS n FROM usage_counters`;
  assert.ok(Number.isInteger(n), 'the table is still there');
});

test('/api/session reports the remaining count the route will actually enforce', dbTest, async () => {
  process.env.GENERATION_ENABLED = 'true';
  const visitorId = newVisitor();
  const request = fakeRequest('203.0.113.21');

  assert.equal((await sessionFor(visitorId)).body.quota.remaining, 3);
  await usage.consumeSearch(visitorId, request);
  assert.equal((await sessionFor(visitorId)).body.quota.remaining, 2, 'the UI can say "2 of 3"');

  await usage.consumeSearch(visitorId, request);
  await usage.consumeSearch(visitorId, request);
  const spent = await sessionFor(visitorId);
  assert.deepEqual(spent.body.quota, { unlimited: false, limit: 3, used: 3, remaining: 0 });

  // The claim /api/session makes and the answer the route gives must agree,
  // or the UI offers a button that fails.
  assert.equal((await attemptGeneration(visitorId)).status, 429);
});

/* ------------------------------------------------- reads are never metered */

test('opening saved reports, however many times, never spends a search', dbTest, async () => {
  const visitorId = newVisitor();
  const cookie = { cookie: `soe_visitor=${visitorId}` };

  for (let i = 0; i < 5; i += 1) {
    await fetch(base, { headers: cookie });
    await fetch(`${base}/api/runs`, { headers: cookie });
    await fetch(`${base}/api/runs/definitely-not-a-real-market-xyz`, { headers: cookie });
    await fetch(`${base}/api/session`, { headers: cookie });
  }

  assert.equal(
    (await usage.getUsage(visitorId)).remaining,
    3,
    'browsing, refreshing and opening reports are free — only generating is metered',
  );
  const rows = await sql`SELECT 1 FROM usage_counters WHERE id = ${`v:${visitorId}`}`;
  assert.equal(rows.length, 0, 'a visitor who only reads never gets a counter row at all');
});

/* ------------------------------------------------------------- admins */

test('an admin is not metered and keeps working when a visitor is spent', dbTest, async () => {
  process.env.GENERATION_ENABLED = 'true';
  const visitorId = newVisitor();
  const request = fakeRequest('203.0.113.30');
  for (let i = 0; i < 3; i += 1) await usage.consumeSearch(visitorId, request);

  // Same exhausted cookie, now with an admin session behind it.
  actAs(ADMIN_EMAIL);

  const session = await sessionFor(visitorId);
  assert.equal(session.body.isAdmin, true);
  assert.deepEqual(session.body.quota, { unlimited: true }, 'admins have no counter');

  const attempt = await attemptGeneration(visitorId);
  assert.notEqual(attempt.status, 429, 'the meter must not refuse an admin');
  assert.notEqual(attempt.body?.reason, 'quota');
  // 400 (market validation) or 503 no-claude, depending on whether this
  // machine has the CLI. Either way it is past the meter and no run began.
  assert.ok(
    attempt.status === 400 || (attempt.status === 503 && attempt.body?.reason === 'no-claude'),
    `expected to reach market validation, got ${attempt.status} ${attempt.text}`,
  );
});

/* ---------------------------------------------- not worth anything to a
                                                    third-party page */

test('a cross-origin POST cannot spend anyone\'s searches', dbTest, async () => {
  process.env.GENERATION_ENABLED = 'true';
  const visitorId = newVisitor();

  const response = await fetch(`${base}/api/analyses`, {
    method: 'POST',
    headers: {
      origin: 'https://someone-elses-site.example',
      'content-type': 'application/json',
      cookie: `soe_visitor=${visitorId}`,
    },
    body: JSON.stringify({ market: UNRUNNABLE_MARKET }),
  });
  assert.equal(response.status, 403, 'a page on another domain may not drive generation');
  assert.equal((await usage.getUsage(visitorId)).remaining, 3, 'and it costs the visitor nothing');
});

test('an unparseable Origin fails closed rather than throwing', dbTest, async () => {
  process.env.GENERATION_ENABLED = 'true';
  const response = await fetch(`${base}/api/analyses`, {
    method: 'POST',
    headers: { origin: 'null', 'content-type': 'application/json' },
    body: JSON.stringify({ market: UNRUNNABLE_MARKET }),
  });
  assert.equal(response.status, 403, 'an opaque origin is not this origin');
});

test('a request with no Origin at all still reaches the meter', dbTest, async () => {
  // curl sends none. Blocking it would be security theatre — and the
  // three-search meter, not the Origin header, is what bounds it.
  process.env.GENERATION_ENABLED = 'true';
  const attempt = await attemptGeneration(newVisitor());
  assert.notEqual(attempt.status, 403, 'the origin check must not become an auth gate');
});

/* ------------------------------------------------------- the kill switch */

test('GENERATION_ENABLED=false blocks everyone, quota remaining or not', dbTest, async () => {
  process.env.GENERATION_ENABLED = 'false';

  const fresh = newVisitor();
  const visitor = await attemptGeneration(fresh);
  assert.equal(visitor.status, 503, 'a visitor with all three searches is still blocked');
  assert.equal(visitor.body.reason, 'disabled');
  assert.equal(
    (await usage.getUsage(fresh)).remaining,
    3,
    'and being blocked by the switch costs them nothing',
  );

  actAs(ADMIN_EMAIL);
  const admin = await attemptGeneration(newVisitor());
  assert.equal(admin.status, 503, 'the switch outranks admin too');
  assert.equal(admin.body.reason, 'disabled');
});

test('the kill switch is read fresh, so flipping it takes effect immediately', dbTest, async () => {
  const visitorId = newVisitor();
  process.env.GENERATION_ENABLED = 'false';
  assert.equal((await attemptGeneration(visitorId)).body.reason, 'disabled');

  process.env.GENERATION_ENABLED = 'true';
  const on = await attemptGeneration(visitorId);
  assert.notEqual(on.body?.reason, 'disabled', 'no restart needed to turn it back on');
  assert.equal(
    (await usage.getUsage(visitorId)).remaining,
    3,
    'and the invalid market was rejected before anything was spent',
  );
});
