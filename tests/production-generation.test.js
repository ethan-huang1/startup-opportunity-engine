/**
 * The generation permission matrix, driven through the real route.
 *
 * This exists because of a real bug: `generationAvailability()` refused
 * outright whenever `VERCEL` was set, ahead of the kill switch, so setting
 * GENERATION_ENABLED=true in production changed nothing and the UI insisted
 * the deployment served saved reports only. The environment must not
 * override the switch — but the admin check must still hold in every
 * environment.
 *
 * SAFETY: every request below sends a market that is too short to be valid
 * ("ab"). server.js validates the market *after* the admin check, the kill
 * switch, the `claude` preflight and the rate limit, but *before*
 * `beginRun()` and `streamRun()`. So reaching the 400 proves the request
 * passed every gate, while guaranteeing the pipeline is never started and
 * not one model call is billed. Do not change this to a valid market: with
 * generation enabled and the CLI present, that would launch a real
 * multi-minute run from the test suite.
 */

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const ADMIN_EMAIL = 'prod-matrix-admin@example.com';
const ORDINARY_EMAIL = 'prod-matrix-user@example.com';

/** Deliberately below the 3-character minimum. See SAFETY above. */
const UNRUNNABLE_MARKET = 'ab';

let base;
let handler = () => {};
let auth;
const server = createServer((request, response) => handler(request, response));

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // Both read at module load, so they have to be set before the imports.
  process.env.BETTER_AUTH_URL = base;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  // Simulates a serverless deployment. The point of this file is that this
  // makes no difference to the decision.
  process.env.VERCEL = '1';

  ({ auth } = await import('../lib/auth.js'));
  ({ handleRequest: handler } = await import('../server.js'));
});

after(async () => {
  delete process.env.VERCEL;
  await new Promise((resolve) => server.close(resolve));
});

/**
 * Signing in for real would need a password and a database round trip per
 * case; the identity is not what is under test here, the gates after it
 * are. So the session is mocked and everything downstream is the real
 * route, reading the real ADMIN_EMAILS.
 */
function actAs(email) {
  mock.restoreAll();
  mock.method(auth.api, 'getSession', async () => (email ? { user: { email } } : null));
}

async function attemptGeneration() {
  const response = await fetch(`${base}/api/analyses`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ market: UNRUNNABLE_MARKET }),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

/**
 * "Allowed" cannot mean 200 here, because the request is deliberately
 * invalid so that nothing runs. It means: past the admin check and past the
 * kill switch. Which of the two later gates it lands on depends on whether
 * this machine has the `claude` CLI, so both outcomes are accepted — what
 * matters is that neither refusal is an authorization or switch refusal.
 */
function assertReachedTheGenerator(result, label) {
  assert.notEqual(result.status, 403, `${label}: must not be refused as non-admin`);
  assert.notEqual(
    result.body?.reason,
    'disabled',
    `${label}: must not be refused by the kill switch`,
  );
  const acceptable =
    result.status === 400 || (result.status === 503 && result.body?.reason === 'no-claude');
  assert.ok(
    acceptable,
    `${label}: expected to reach market validation (400) or the claude preflight ` +
      `(503 no-claude), got ${result.status} ${result.text}`,
  );
}

test('production + admin + GENERATION_ENABLED=true -> allowed', async () => {
  process.env.GENERATION_ENABLED = 'true';
  actAs(ADMIN_EMAIL);
  assertReachedTheGenerator(await attemptGeneration(), 'production admin, enabled');
});

test('production + admin + GENERATION_ENABLED=false -> blocked by the kill switch', async () => {
  process.env.GENERATION_ENABLED = 'false';
  actAs(ADMIN_EMAIL);
  const result = await attemptGeneration();
  assert.equal(result.status, 503);
  assert.equal(result.body.reason, 'disabled');
});

test('production + admin + GENERATION_ENABLED missing -> fails closed', async () => {
  delete process.env.GENERATION_ENABLED;
  actAs(ADMIN_EMAIL);
  const result = await attemptGeneration();
  assert.equal(result.status, 503);
  assert.equal(result.body.reason, 'disabled');
});

test('production + ordinary user + GENERATION_ENABLED=true -> blocked by authorization', async () => {
  process.env.GENERATION_ENABLED = 'true';
  actAs(ORDINARY_EMAIL);
  const result = await attemptGeneration();
  assert.equal(result.status, 403, 'an ordinary account must never generate, switch or no switch');
  assert.match(result.body.error, /admin/i);
});

test('production + anonymous + GENERATION_ENABLED=true -> blocked as unauthenticated', async () => {
  process.env.GENERATION_ENABLED = 'true';
  actAs(null);
  const result = await attemptGeneration();
  assert.equal(result.status, 401);
});

test('localhost + admin + GENERATION_ENABLED=true -> allowed, as before', async () => {
  delete process.env.VERCEL;
  process.env.GENERATION_ENABLED = 'true';
  actAs(ADMIN_EMAIL);
  try {
    assertReachedTheGenerator(await attemptGeneration(), 'local admin, enabled');
  } finally {
    process.env.VERCEL = '1';
  }
});

test('the reported capability matches what the route will actually do', async () => {
  // /api/session is what the UI trusts to decide whether to show a control.
  // If it disagrees with the route, the UI offers buttons that fail.
  actAs(ADMIN_EMAIL);
  for (const [value, expected] of [['true', true], ['false', false]]) {
    process.env.GENERATION_ENABLED = value;
    const session = await fetch(`${base}/api/session`, { headers: { origin: base } });
    const body = await session.json();
    assert.equal(body.isAdmin, true);
    assert.equal(
      body.generation.available,
      expected,
      `with GENERATION_ENABLED=${value}, /api/session should report available=${expected}`,
    );
    // And it must never claim this deployment is read-only while it is not.
    if (expected) assert.equal(body.generation.message, null);
  }
});
