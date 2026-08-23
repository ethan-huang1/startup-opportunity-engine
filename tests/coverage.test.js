import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessCoverage, VERDICT } from '../lib/coverage.js';
import { makeEvidence } from '../lib/normalize.js';
import { STATE } from '../lib/http.js';

const today = new Date().toISOString().slice(0, 10);

function items(source, count) {
  return Array.from({ length: count }, (_, i) =>
    makeEvidence({
      id: `${source}-${i}`, source, kind: 'post', title: 't', body: 'b',
      url: `https://example.com/${source}/${i}`, publishedAt: today,
    }),
  );
}

test('a well-covered market is adequate', () => {
  const coverage = assessCoverage([
    { source: 'hackernews', state: STATE.OK, items: items('hackernews', 30), error: null },
    { source: 'github', state: STATE.OK, items: items('github', 20), error: null },
    { source: 'reddit', state: STATE.OK, items: items('reddit', 10), error: null },
  ]);
  assert.equal(coverage.verdict, VERDICT.ADEQUATE);
  assert.equal(coverage.totalInWindow, 60);
});

test('a traditional market with almost nothing is insufficient', () => {
  const coverage = assessCoverage([
    { source: 'hackernews', state: STATE.NO_RESULTS, items: [], error: null },
    { source: 'github', state: STATE.OK, items: items('github', 1), error: null },
    { source: 'reddit', state: STATE.OK, items: items('reddit', 3), error: null },
  ]);
  assert.equal(coverage.verdict, VERDICT.INSUFFICIENT);
  assert.match(coverage.explanation, /developer- and tech-community-skewed/);
});

test('one source alone is insufficient however much it returns', () => {
  const coverage = assessCoverage([
    { source: 'hackernews', state: STATE.OK, items: items('hackernews', 200), error: null },
    { source: 'github', state: STATE.NO_RESULTS, items: [], error: null },
    { source: 'reddit', state: STATE.NO_RESULTS, items: [], error: null },
  ]);
  assert.equal(coverage.verdict, VERDICT.INSUFFICIENT, 'corroboration needs more than one source');
});

test('a failed source never supports a claim about the market', () => {
  const coverage = assessCoverage([
    { source: 'hackernews', state: STATE.NO_RESULTS, items: [], error: null },
    { source: 'github', state: STATE.NO_RESULTS, items: [], error: null },
    { source: 'reddit', state: STATE.RATE_LIMITED, items: [], error: 'rate limited' },
  ]);
  assert.equal(coverage.verdict, VERDICT.INSUFFICIENT);
  assert.deepEqual(coverage.degradedSources, ['Reddit search']);
  assert.match(coverage.explanation, /did not complete/);
  assert.doesNotMatch(
    coverage.explanation,
    /most likely do not discuss/,
    'must not conclude the market is quiet when we never managed to look',
  );
});

test('degraded sources are flagged even on an otherwise adequate run', () => {
  const coverage = assessCoverage([
    { source: 'hackernews', state: STATE.OK, items: items('hackernews', 30), error: null },
    { source: 'github', state: STATE.OK, items: items('github', 20), error: null },
    { source: 'reddit', state: STATE.UNREACHABLE, items: [], error: 'network' },
  ]);
  assert.equal(coverage.verdict, VERDICT.ADEQUATE);
  assert.deepEqual(coverage.degradedSources, ['Reddit search']);
  assert.match(coverage.explanation, /not evidence of absence/);
});

test('items outside the 30-day window do not count toward coverage', () => {
  const old = makeEvidence({
    id: 'old', source: 'reddit', kind: 'post', title: 't', body: 'b',
    url: 'https://example.com/old', publishedAt: '2020-01-01',
  });
  const coverage = assessCoverage([
    { source: 'reddit', state: STATE.OK, items: [old, ...items('reddit', 2)], error: null },
    { source: 'github', state: STATE.NO_RESULTS, items: [], error: null },
    { source: 'hackernews', state: STATE.NO_RESULTS, items: [], error: null },
  ]);
  assert.equal(coverage.totalInWindow, 2);
  assert.equal(coverage.perSource[0].itemsReturned, 3);
});
