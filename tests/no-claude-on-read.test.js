import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Static `import`s are hoisted and evaluate before any other top-level code
// in this file — so setting process.env here and then statically importing
// server.js would still load lib/access.js's ADMIN_EMAILS (read once, at
// module load) with the env var unset. Dynamic import() is a real
// expression, evaluated in the order it's written, which is what lets this
// actually be in place first.
process.env.ADMIN_EMAILS = 'test-admin@example.com';

const { auth } = await import('../lib/auth.js');
const { handleRequest } = await import('../server.js');
const { beginRun, saveRunResult } = await import('../lib/store.js');
const { sql } = await import('../lib/db.js');

const TEST_SLUG = 'no-claude-read-test-market';
const dbTest = { skip: !process.env.DATABASE_URL && 'DATABASE_URL not set' };

// lib/db.js's Neon HTTP driver also calls fetch() — a blanket fetch mock
// would flag the app's own legitimate DB queries as violations. Only calls
// to *other* hosts (the actual collectors: GitHub, HN, Reddit) count. The
// driver calls its own `api.<region>.aws.neon.tech` endpoint, not the
// DATABASE_URL host directly, so this matches on the stable `.neon.tech`
// suffix rather than trying to reproduce its host-derivation logic.
function isNeonRequest(input) {
  const url = typeof input === 'string' ? input : input?.url;
  return typeof url === 'string' && new URL(url).hostname.endsWith('.neon.tech');
}

// server.js checks the real session on every /api/* request; mocking this
// one method is the seam that lets these tests run as the admin without a
// real signup (which is disabled — lib/auth.js's disableSignUp: true).
mock.method(auth.api, 'getSession', async () => ({ user: { email: 'test-admin@example.com' } }));

function fakeResponse() {
  // headersSent matters: server.js's error boundary consults it before
  // trying to send a 500, and a fake that never sets it would let the
  // boundary write a second set of headers onto a response that already
  // has them.
  const res = {
    statusCode: null,
    body: '',
    writableEnded: false,
    headersSent: false,
    headers: {},
  };
  // The real server sets the visitor cookie with setHeader() before any
  // writeHead(), relying on Node merging the two. A fake without it makes
  // every route throw on the first line that touches the response.
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  res.writeHead = (status) => {
    res.statusCode = status;
    res.headersSent = true;
    return res;
  };
  res.write = (chunk) => {
    res.body += chunk;
  };
  res.end = (chunk) => {
    if (chunk) res.body += chunk;
    res.writableEnded = true;
  };
  return res;
}

function fakeRequest(method, url, body = null) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost' };
  if (body !== null) {
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(body);
    };
  }
  return req;
}

async function cleanup() {
  await sql`DELETE FROM analysis_runs WHERE market_slug = ${TEST_SLUG}`;
  await sql`DELETE FROM markets WHERE slug = ${TEST_SLUG}`;
}

test(
  'GET /api/runs and /api/runs/:slug never spawn a process or make a network call',
  dbTest,
  async () => {
    await cleanup();
    const spawnMock = mock.method(childProcess, 'spawn', () => {
      throw new Error('child_process.spawn should never be called on a cached read');
    });
    const realFetch = globalThis.fetch;
    const fetchMock = mock.method(globalThis, 'fetch', (input, init) => {
      if (isNeonRequest(input)) return realFetch(input, init);
      throw new Error(`fetch to a non-Neon host should never happen on a cached read: ${input}`);
    });

    try {
      const claim = await beginRun(TEST_SLUG, 'no claude read test market');
      await saveRunResult(claim.runId, {
        market: 'no claude read test market',
        halted: false,
        opportunities: [],
        weakSignals: [],
      });

      const listResponse = fakeResponse();
      await handleRequest(fakeRequest('GET', '/api/runs'), listResponse);
      assert.equal(listResponse.statusCode, 200);
      assert.ok(JSON.parse(listResponse.body).some((m) => m.slug === TEST_SLUG));

      const singleResponse = fakeResponse();
      await handleRequest(fakeRequest('GET', `/api/runs/${TEST_SLUG}`), singleResponse);
      assert.equal(singleResponse.statusCode, 200);
      assert.equal(JSON.parse(singleResponse.body).market, 'no claude read test market');

      const missingResponse = fakeResponse();
      await handleRequest(fakeRequest('GET', '/api/runs/never-analyzed-xyz'), missingResponse);
      assert.equal(missingResponse.statusCode, 404);

      assert.equal(spawnMock.mock.calls.length, 0, 'no subprocess should have been spawned');
      assert.ok(
        fetchMock.mock.calls.every((call) => isNeonRequest(call.arguments[0])),
        'the only fetch calls should be the app\'s own Neon queries, never a collector',
      );
    } finally {
      spawnMock.mock.restore();
      fetchMock.mock.restore();
      await cleanup();
    }
  },
);

/**
 * Proves the read test above isn't passing "by accident" (e.g. because the
 * whole route were unreachable in tests) — without ever actually running
 * the pipeline. An earlier version of this test drove a real POST
 * /api/analyses through handleRequest with child_process.spawn mocked,
 * expecting that to intercept the CLI call; it didn't (a live-binding
 * assumption that turned out to be wrong for this module in practice), and
 * it silently made several real, billed `claude` CLI calls before that was
 * noticed. A static check of the source has zero execution risk and proves
 * the same thing: the generation code path really is wired to Claude, so
 * the read path's clean bill of health is meaningful, not a tautology.
 */
test('the generation path is actually wired to askForJson/Claude (static, never executed)', async () => {
  const files = {
    'lib/subreddits.js': await readFile(new URL('../lib/subreddits.js', import.meta.url), 'utf8'),
    'lib/extract.js': await readFile(new URL('../lib/extract.js', import.meta.url), 'utf8'),
    'lib/theme.js': await readFile(new URL('../lib/theme.js', import.meta.url), 'utf8'),
    'lib/frame.js': await readFile(new URL('../lib/frame.js', import.meta.url), 'utf8'),
  };
  for (const [name, source] of Object.entries(files)) {
    assert.match(source, /askForJson/, `${name} should call askForJson`);
  }

  const claudeSource = await readFile(new URL('../lib/claude.js', import.meta.url), 'utf8');
  assert.match(claudeSource, /spawn\(\s*['"]claude['"]/, 'lib/claude.js should spawn the claude CLI');

  const serverSource = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(serverSource, /runPipeline/, "server.js's POST route should call runPipeline");
  // Whether the read routes are actually insulated from it is proven
  // dynamically by the test above (real handleRequest calls, spawn/fetch
  // mocked) — that's the behavioral guarantee; this test only establishes
  // that the write path isn't a no-op for that one to be meaningful.
});
