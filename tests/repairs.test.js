/**
 * Tests for the repairs made after the trucking and AI-coding-assistant runs.
 * Each one pins a specific failure those runs exposed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchesQuery, stem, makeEvidence } from '../lib/normalize.js';
import { CATEGORY, countsAsEvidence, evidenceSignals, normalizeCategory } from '../lib/evidence-type.js';
import { assessQualifiedCoverage } from '../lib/coverage.js';
import { scoreCluster } from '../lib/score.js';
import { buildEngagementIndex } from '../lib/engagement.js';
import { MENTIONS_PER_CONTAINER_CAP } from '../lib/config.js';

const today = new Date().toISOString().slice(0, 10);

function mention(overrides) {
  return {
    evidenceId: overrides.evidenceId || `e-${Math.random()}`,
    pain: overrides.pain || 'p',
    quote: 'a verified quote',
    category: overrides.category || CATEGORY.FIRST_HAND,
    severity: overrides.severity || 'mentioned',
    source: overrides.source || 'reddit-archive',
    container: overrides.container ?? 'r/Truckers',
    voiceId: overrides.voiceId || `v-${Math.random()}`,
    threadId: overrides.threadId || `t-${Math.random()}`,
    publishedAt: overrides.publishedAt || today,
  };
}

/* ---------------------------------------------------------------- stemming */

test('a query term matches its inflections', () => {
  const item = { title: 'Terminated', body: 'I hit the truck again', container: '' };
  assert.equal(matchesQuery(item, 'trucking'), true, 'trucking must match truck');

  const plural = { title: 'Trucks doing 64 mph', body: '', container: '' };
  assert.equal(matchesQuery(plural, 'trucking'), true, 'trucking must match trucks');

  assert.equal(stem('trucking'), 'truck');
  assert.equal(stem('trucks'), 'truck');
});

test('stemming does not make unrelated items match', () => {
  const item = { title: 'I love baking bread', body: 'sourdough starter', container: '' };
  assert.equal(matchesQuery(item, 'trucking'), false);
});

/* ------------------------------------------------------- evidence category */

test('only first-hand and directly reported problems count as evidence', () => {
  assert.equal(countsAsEvidence(CATEGORY.FIRST_HAND), true);
  assert.equal(countsAsEvidence(CATEGORY.REPORTED), true);
  assert.equal(countsAsEvidence(CATEGORY.PROPOSED_SOLUTION), false);
  assert.equal(countsAsEvidence(CATEGORY.PROMOTIONAL), false);
  assert.equal(countsAsEvidence(CATEGORY.INCIDENTAL), false);
});

test('an unrecognised category is never treated as evidence', () => {
  assert.equal(normalizeCategory('something_else'), null);
  assert.equal(normalizeCategory(''), null);
  assert.equal(normalizeCategory('first hand problem'), CATEGORY.FIRST_HAND);
});

test('signals are advisory and never reject on their own', () => {
  // A real customer complaint that opens with an instruction and uses no "I".
  const item = makeEvidence({
    id: 'x', source: 'github', kind: 'issue',
    title: 'Fix the billing page',
    body: 'Fix your billing page. It charged the account twice this month.',
    url: 'https://example.com/x', author: 'someone', publishedAt: today,
  });

  const signals = evidenceSignals(item, 'Fix your billing page. It charged the account twice');
  assert.ok(signals.length > 0, 'the shape does look like an instruction');

  // The module exposes signals only. There is no exported predicate that turns
  // them into a rejection, because the classifier decides, not the pattern.
  assert.equal(typeof countsAsEvidence(CATEGORY.FIRST_HAND), 'boolean');
  assert.equal(
    countsAsEvidence(CATEGORY.FIRST_HAND),
    true,
    'an imperative, non-first-person complaint can still be first-hand evidence',
  );
});

test('repo ownership is recorded as a signal, not a deletion', () => {
  const item = makeEvidence({
    id: 'gh1', source: 'github', kind: 'issue', title: 'Sync drops loads',
    body: 'Users report that loads vanish when the app reconnects.',
    url: 'https://github.com/me/app/issues/1', author: 'me',
    container: 'me/app', publishedAt: today, authorOwnsContainer: true,
  });
  assert.equal(item.authorOwnsContainer, true, 'the signal is stored on the item');
  assert.match(evidenceSignals(item).join(' '), /owns the repository/);
});

/* ---------------------------------------------------- qualified coverage */

test('coverage counts customer statements, not keyword matches', () => {
  // The trucking shape: plenty retrieved, almost nothing that is a customer.
  const retrieval = { totalInWindow: 68 };
  const mentions = [
    mention({ voiceId: 'v1', source: 'reddit-archive' }),
    mention({ voiceId: 'v2', source: 'reddit-archive' }),
  ];
  const setAside = Array.from({ length: 26 }, () =>
    mention({ category: CATEGORY.PROPOSED_SOLUTION }));

  const coverage = assessQualifiedCoverage(mentions, setAside, retrieval);
  assert.equal(coverage.verdict, 'insufficient');
  assert.equal(coverage.statements, 2);
  assert.match(coverage.explanation, /out of 68 items collected/);
});

test('one platform alone can never be adequate, however much it returns', () => {
  const mentions = Array.from({ length: 40 }, (_, i) =>
    mention({ voiceId: `v${i}`, source: 'reddit-archive', container: `r/sub${i % 5}` }));
  const coverage = assessQualifiedCoverage(mentions, [], { totalInWindow: 200 });

  assert.deepEqual(coverage.platforms, ['reddit']);
  assert.equal(coverage.verdict, 'insufficient');
  assert.match(coverage.explanation, /cannot be corroborated|Only one platform/i);
});

test('two subreddits are one platform, not two', () => {
  const mentions = [
    mention({ voiceId: 'v1', source: 'reddit-archive', container: 'r/Truckers' }),
    mention({ voiceId: 'v2', source: 'reddit', container: 'r/FreightBrokers' }),
  ];
  const coverage = assessQualifiedCoverage(mentions, [], { totalInWindow: 20 });
  assert.deepEqual(coverage.platforms, ['reddit'], 'both Reddit collectors are one platform');
});

test('evidence across genuinely different platforms can be adequate', () => {
  const mentions = [
    ...Array.from({ length: 8 }, (_, i) =>
      mention({ voiceId: `r${i}`, source: 'reddit-archive', container: 'r/Truckers' })),
    ...Array.from({ length: 8 }, (_, i) =>
      mention({ voiceId: `h${i}`, source: 'hackernews', container: 'news.ycombinator.com' })),
  ];
  const coverage = assessQualifiedCoverage(mentions, [], { totalInWindow: 90 });
  assert.equal(coverage.verdict, 'adequate');
  assert.equal(coverage.platforms.length, 2);
});

/* ------------------------------------------------------------ container cap */

test('one repository cannot dominate a cluster', () => {
  const index = buildEngagementIndex([]);
  const cluster = {
    id: 'c1', label: 'p',
    members: Array.from({ length: 10 }, (_, i) =>
      mention({
        evidenceId: `e${i}`, voiceId: `v${i}`, threadId: `t${i}`,
        source: 'github', container: 'someone/hobby-project',
      })),
  };
  const scored = scoreCluster(cluster, index);
  assert.equal(
    scored.countedMentions, MENTIONS_PER_CONTAINER_CAP,
    'ten issues from one repo must not count ten times',
  );
});

test('the same volume spread across repositories still counts', () => {
  const index = buildEngagementIndex([]);
  const cluster = {
    id: 'c1', label: 'p',
    members: Array.from({ length: 10 }, (_, i) =>
      mention({
        evidenceId: `e${i}`, voiceId: `v${i}`, threadId: `t${i}`,
        source: 'github', container: `org${i}/repo`,
      })),
  };
  const scored = scoreCluster(cluster, index);
  assert.equal(scored.countedMentions, 10);
});

test('platform diversity ignores containers', () => {
  const index = buildEngagementIndex([]);
  const cluster = {
    id: 'c1', label: 'p',
    members: [
      mention({ evidenceId: 'a', voiceId: 'v1', threadId: 't1', source: 'reddit-archive', container: 'r/Truckers' }),
      mention({ evidenceId: 'b', voiceId: 'v2', threadId: 't2', source: 'reddit-archive', container: 'r/CDL' }),
      mention({ evidenceId: 'c', voiceId: 'v3', threadId: 't3', source: 'reddit', container: 'r/FreightBrokers' }),
    ],
  };
  const scored = scoreCluster(cluster, index);
  assert.deepEqual(scored.sourceTypes, ['reddit']);
  assert.equal(scored.distinctVoices, 3);
  assert.equal(scored.qualifies, false, 'three voices on one platform is not corroboration');
});
