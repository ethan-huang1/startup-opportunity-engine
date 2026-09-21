/**
 * End-to-end signup, sign-in, and what an account is actually for, against
 * a real ephemeral server and the real Neon database.
 *
 * Signing in is optional now: reading and the three free searches both work
 * anonymously (tests/quota.test.js). What remains worth asserting here is
 * that an account can be created and used, that it can never escalate
 * itself to admin, and that ADMIN_EMAILS is the only thing that confers the
 * one privilege there is — an exemption from the search meter.
 *
 * Nothing here is mocked except the one thing that must never happen:
 * child_process.spawn. If any assertion below accidentally
 * reaches the pipeline, the test fails loudly instead of quietly making
 * billed `claude` calls (which is exactly how an earlier version of
 * tests/no-claude-on-read.test.js burned real money).
 */

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import childProcess from 'node:child_process';

mock.method(childProcess, 'spawn', () => {
  throw new Error('no test in this file may spawn a subprocess');
});

const ADMIN_EMAIL = 'auth-test-admin@example.com';
const USER_EMAIL = 'auth-test-user@example.com';
const PASSWORD = 'correct-horse-battery';

// Better Auth reads its base URL, and lib/access.js its allowlist, once at
// module load — so the server has to exist (and its port be known) before
// either module is imported. Dynamic import is what makes that ordering
// possible; a static import would be hoisted above all of this.
let base;
let sql;

const server = createServer((request, response) => handler(request, response));
let handler = () => {};

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  process.env.BETTER_AUTH_URL = base;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  // Forced off for the whole file: nothing here needs generation to run,
  // and the switch failing closed is the cheapest possible guarantee that
  // it cannot. Every generation attempt below therefore lands on 503
  // `disabled`, whoever makes it.
  process.env.GENERATION_ENABLED = 'false';
  delete process.env.VERCEL;

  ({ handleRequest: handler } = await import('../server.js'));
  ({ sql } = await import('../lib/db.js'));

  await deleteTestAccounts();
});

after(async () => {
  await deleteTestAccounts();
  await new Promise((resolve) => server.close(resolve));
});

async function deleteTestAccounts() {
  const emails = [ADMIN_EMAIL, USER_EMAIL];
  const ids = await sql`SELECT id FROM "user" WHERE email = ANY(${emails})`;
  for (const { id } of ids) {
    await sql`DELETE FROM session WHERE "userId" = ${id}`;
    await sql`DELETE FROM account WHERE "userId" = ${id}`;
    await sql`DELETE FROM "user" WHERE id = ${id}`;
  }
}

/** Minimal cookie jar: one signed-in identity per instance. */
function client() {
  let cookie = '';
  return {
    async request(path, { method = 'GET', body } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          // Better Auth rejects a state-changing request with no Origin
          // (MISSING_OR_NULL_ORIGIN). A browser always sends one; fetch()
          // from Node does not, so the client has to act like a browser.
          origin: base,
          ...(cookie ? { cookie } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = response.headers.getSetCookie?.() ?? [];
      for (const raw of setCookie) {
        const pair = raw.split(';')[0];
        if (pair.startsWith('better-auth')) cookie = pair;
      }
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, body: json, text };
    },
    signUp(email, extra = {}) {
      return this.request('/api/auth/sign-up/email', {
        method: 'POST',
        body: { email, password: PASSWORD, name: 'Auth Test', ...extra },
      });
    },
    signIn(email, password = PASSWORD) {
      return this.request('/api/auth/sign-in/email', {
        method: 'POST',
        body: { email, password },
      });
    },
  };
}

const dbTest = { skip: !process.env.DATABASE_URL && 'DATABASE_URL not set' };

/* ------------------------------------------------------------ signing up */

test('a visitor can create an account and is signed in immediately', dbTest, async () => {
  const user = client();
  const signUp = await user.signUp(USER_EMAIL);
  assert.equal(signUp.status, 200, signUp.text);

  const session = await user.request('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.email, USER_EMAIL);
});

test('the same email cannot be registered twice', dbTest, async () => {
  const duplicate = await client().signUp(USER_EMAIL);
  assert.notEqual(duplicate.status, 200, 'a duplicate signup must not succeed');

  const rows = await sql`SELECT count(*)::int AS n FROM "user" WHERE email = ${USER_EMAIL}`;
  assert.equal(rows[0].n, 1, 'exactly one account should exist for that email');
});

test('signing in works with the right password and fails with the wrong one', dbTest, async () => {
  const good = await client().signIn(USER_EMAIL);
  assert.equal(good.status, 200, good.text);

  const bad = await client().signIn(USER_EMAIL, 'not-the-password');
  assert.notEqual(bad.status, 200, 'a wrong password must not produce a session');

  const anonymous = await client().request('/api/session');
  assert.equal(anonymous.status, 200, 'no session is the normal case, not a refusal');
  assert.equal(anonymous.body.email, null);
  assert.equal(anonymous.body.isAdmin, false);
});

/* --------------------------------------------------------- normal user */

test('signing up never grants admin, even if the request asks for it', dbTest, async () => {
  const user = client();
  await user.signIn(USER_EMAIL);

  // Admin is derived server-side from ADMIN_EMAILS on every request; there
  // is no field on the account a signup could set to escalate.
  const escalation = await client().signUp('auth-test-escalate@example.com', {
    role: 'admin',
    isAdmin: true,
  });
  if (escalation.status === 200) {
    const escalated = await client();
    await escalated.signIn('auth-test-escalate@example.com');
    const session = await escalated.request('/api/session');
    assert.equal(session.body.isAdmin, false, 'a self-registered account is never an admin');
    await sql`DELETE FROM session WHERE "userId" IN (SELECT id FROM "user" WHERE email = 'auth-test-escalate@example.com')`;
    await sql`DELETE FROM account WHERE "userId" IN (SELECT id FROM "user" WHERE email = 'auth-test-escalate@example.com')`;
    await sql`DELETE FROM "user" WHERE email = 'auth-test-escalate@example.com'`;
  }

  const session = await user.request('/api/session');
  assert.equal(session.body.isAdmin, false);
  assert.equal(session.body.generation.available, false);
  assert.equal(session.body.quota.unlimited, false);
});

test('an ordinary account gets exactly what an anonymous visitor gets', dbTest, async () => {
  const user = client();
  await user.signIn(USER_EMAIL);
  const signedIn = await user.request('/api/session');
  const anonymous = await client().request('/api/session');

  assert.equal(signedIn.body.isAdmin, false);
  assert.equal(signedIn.body.quota.unlimited, false, 'an account is not a way around the meter');
  assert.equal(signedIn.body.quota.limit, anonymous.body.quota.limit);
});

test('a normal user can read saved analyses', dbTest, async () => {
  const user = client();
  await user.signIn(USER_EMAIL);

  const list = await user.request('/api/runs');
  assert.equal(list.status, 200, 'reading the catalogue is the product');
  assert.ok(Array.isArray(list.body));

  const missing = await user.request('/api/runs/definitely-not-a-real-market-xyz');
  assert.equal(missing.status, 404, 'a market with no report is a 404, not a 403');
  assert.equal(missing.body.error, 'not_analyzed');
});

test('a normal user is stopped by the kill switch, same as anyone', dbTest, async () => {
  const user = client();
  await user.signIn(USER_EMAIL);

  const attempt = await user.request('/api/analyses', {
    method: 'POST',
    body: { market: 'some market nobody has analyzed' },
  });
  // 503, not 403: there is no authorization gate on generation any more,
  // only the switch and the meter. With the switch off, the switch wins —
  // and crucially, this costs the account none of its three searches.
  assert.equal(attempt.status, 503);
  assert.equal(attempt.body.reason, 'disabled');

  const after = await user.request('/api/session');
  assert.equal(after.body.quota.remaining, 3, 'a refusal by the switch spends nothing');
});

/* --------------------------------------------------------------- admin */

test('an admin is unmetered and is stopped only by the kill switch', dbTest, async () => {
  const admin = client();
  const signUp = await admin.signUp(ADMIN_EMAIL);
  assert.equal(signUp.status, 200, signUp.text);

  const session = await admin.request('/api/session');
  assert.equal(session.body.isAdmin, true, 'ADMIN_EMAILS is what confers admin');
  assert.deepEqual(session.body.quota, { unlimited: true }, 'and admin means unmetered');

  const attempt = await admin.request('/api/analyses', {
    method: 'POST',
    body: { market: 'some market nobody has analyzed' },
  });
  // The switch outranks admin: being the maintainer is an exemption from
  // the meter, not from the kill switch.
  assert.equal(attempt.status, 503);
  assert.equal(attempt.body.reason, 'disabled');
});

test('GET on the generation route does not generate anything', dbTest, async () => {
  const user = client();
  await user.signIn(USER_EMAIL);
  const attempt = await user.request('/api/analyses');
  // Only the POST branch generates; a GET falls through to the static
  // handler and finds no such file. Either way nothing runs and nothing
  // is spent.
  assert.equal(attempt.status, 404);

  const after = await user.request('/api/session');
  assert.equal(after.body.quota.remaining, 3);
});
