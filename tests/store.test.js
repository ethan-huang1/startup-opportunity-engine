import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { beginRun, saveRunResult, failRun, getReport, listMarkets, anyRunInProgress } from '../lib/store.js';
import { sql } from '../lib/db.js';

const FIXTURE = fileURLToPath(new URL('../runs/ai-coding-assistants.json', import.meta.url));
const TEST_SLUG = 'test-roundtrip-market';
const dbTest = { skip: !process.env.DATABASE_URL && 'DATABASE_URL not set' };

async function cleanup() {
  await sql`DELETE FROM analysis_runs WHERE market_slug = ${TEST_SLUG}`;
  await sql`DELETE FROM markets WHERE slug = ${TEST_SLUG}`;
}

test('saveRunResult -> getReport round-trips a real report exactly (it is the same jsonb in and out)', dbTest, async () => {
  await cleanup();
  try {
    const original = JSON.parse(await readFile(FIXTURE, 'utf8'));
    const claim = await beginRun(TEST_SLUG, original.market);
    assert.equal(claim.status, 'started');

    await saveRunResult(claim.runId, original);
    const reconstructed = await getReport(TEST_SLUG);

    assert.deepStrictEqual(reconstructed, original);
  } finally {
    await cleanup();
  }
});

test('a halted report is stored as degraded and still readable', dbTest, async () => {
  await cleanup();
  try {
    const halted = { market: 'test market', halted: true, opportunities: [], weakSignals: [] };
    const claim = await beginRun(TEST_SLUG, halted.market);
    await saveRunResult(claim.runId, halted);

    const [row] = await sql`SELECT status FROM analysis_runs WHERE id = ${claim.runId}`;
    assert.equal(row.status, 'degraded');
    assert.deepStrictEqual(await getReport(TEST_SLUG), halted);
  } finally {
    await cleanup();
  }
});

test('beginRun refuses a second concurrent analysis for the same market', dbTest, async () => {
  await cleanup();
  try {
    const first = await beginRun(TEST_SLUG, 'concurrency test market');
    assert.equal(first.status, 'started');

    const second = await beginRun(TEST_SLUG, 'concurrency test market');
    assert.equal(second.status, 'already_analyzing');
    assert.equal(second.runId, first.runId);
  } finally {
    await cleanup();
  }
});

test('a failed refresh keeps serving the last completed report', dbTest, async () => {
  await cleanup();
  try {
    const good = { market: 'test market', halted: false, opportunities: [], weakSignals: [] };
    const firstClaim = await beginRun(TEST_SLUG, good.market);
    await saveRunResult(firstClaim.runId, good);

    const refreshClaim = await beginRun(TEST_SLUG, good.market);
    assert.equal(refreshClaim.status, 'started', 'a completed market can still be refreshed');
    await failRun(refreshClaim.runId, 'simulated failure');

    assert.deepStrictEqual(await getReport(TEST_SLUG), good);
  } finally {
    await cleanup();
  }
});

test('a stale running row is reaped by the next claim attempt', dbTest, async () => {
  await cleanup();
  try {
    const claim = await beginRun(TEST_SLUG, 'stale test market');
    await sql`UPDATE analysis_runs SET created_at = now() - interval '21 minutes' WHERE id = ${claim.runId}`;

    const next = await beginRun(TEST_SLUG, 'stale test market');
    assert.equal(next.status, 'started', 'a run older than the stale window should not block a new claim');
    assert.notEqual(next.runId, claim.runId);
  } finally {
    await cleanup();
  }
});

test('listMarkets only includes markets with a completed or degraded run', dbTest, async () => {
  await cleanup();
  try {
    await beginRun(TEST_SLUG, 'listed market'); // running only, no report yet
    let markets = await listMarkets();
    assert.ok(!markets.some((m) => m.slug === TEST_SLUG), 'a running-only market should not be listed');

    await cleanup();
    const claim = await beginRun(TEST_SLUG, 'listed market');
    await saveRunResult(claim.runId, { market: 'listed market', halted: false, opportunities: [], weakSignals: [] });
    markets = await listMarkets();
    assert.ok(markets.some((m) => m.slug === TEST_SLUG), 'a completed market should be listed');
  } finally {
    await cleanup();
  }
});

test('getReport returns null for a market that has never been analyzed', dbTest, async () => {
  assert.equal(await getReport('never-analyzed-market'), null);
});

test('anyRunInProgress reflects a live running row and ignores stale ones', dbTest, async () => {
  await cleanup();
  try {
    assert.equal(await anyRunInProgress(), false);
    const claim = await beginRun(TEST_SLUG, 'in progress market');
    assert.equal(await anyRunInProgress(), true);

    await sql`UPDATE analysis_runs SET created_at = now() - interval '21 minutes' WHERE id = ${claim.runId}`;
    assert.equal(await anyRunInProgress(), false, 'a stale running row should not count as in progress');
  } finally {
    await cleanup();
  }
});
