import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEngagementIndex, describeEngagement } from '../lib/engagement.js';
import { scoreCluster, rankClusters, weightedScore } from '../lib/score.js';
import { clusterMentions } from '../lib/cluster.js';
import { makeEvidence } from '../lib/normalize.js';
import { WEIGHTS } from '../lib/config.js';

function item(id, source, primary) {
  return makeEvidence({
    id, source, kind: 'post', title: id, body: 'body text here',
    url: `https://example.com/${id}`, author: id,
    publishedAt: new Date().toISOString().slice(0, 10), primary,
  });
}

function mention(overrides) {
  return {
    evidenceId: overrides.evidenceId,
    pain: overrides.pain,
    quote: 'a verified quote',
    severity: overrides.severity || 'mentioned',
    source: overrides.source || 'reddit',
    voiceId: overrides.voiceId || `v:${overrides.evidenceId}`,
    threadId: overrides.threadId || `t:${overrides.evidenceId}`,
    publishedAt: overrides.publishedAt || new Date().toISOString().slice(0, 10),
  };
}

test('percentiles are computed within each source, not across sources', () => {
  // 12 of each so both clear the minimum-items floor.
  const items = [
    ...Array.from({ length: 12 }, (_, i) => item(`r${i}`, 'reddit', i * 40)),
    ...Array.from({ length: 12 }, (_, i) => item(`g${i}`, 'github', i)),
  ];
  const index = buildEngagementIndex(items);

  // A 440-upvote Reddit post and an 11-reaction GitHub issue are both top of
  // their own platform, despite a 40x difference in raw count.
  assert.equal(index.percentileFor('r11'), 1);
  assert.equal(index.percentileFor('g11'), 1);

  // And the bottom of Reddit is not rated above the top of GitHub.
  assert.ok(index.percentileFor('r0') < index.percentileFor('g11'));
});

test('a source with too few items is not normalized, and says so', () => {
  const items = [
    ...Array.from({ length: 12 }, (_, i) => item(`r${i}`, 'reddit', i * 10)),
    item('g0', 'github', 3),
    item('g1', 'github', 99),
  ];
  const index = buildEngagementIndex(items);

  assert.equal(index.perSource.github.normalized, false);
  assert.equal(index.percentileFor('g0'), 0.5, 'neutral rather than a fake ranking');
  assert.equal(index.percentileFor('g1'), 0.5);
  assert.match(index.perSource.github.note, /too few/);
});

test('engagement is described in native units and never summed across sources', () => {
  const items = [
    ...Array.from({ length: 12 }, (_, i) => item(`r${i}`, 'reddit', i * 10)),
  ];
  const index = buildEngagementIndex(items);
  const described = describeEngagement(items[11], index);

  assert.match(described.native, /110 upvotes/);
  assert.match(described.text, /percentile of reddit items/);
  // The public surface exposes a per-source percentile and the native count.
  // There is deliberately no combined total to display.
  assert.equal(Object.keys(described).sort().join(','), 'native,percentile,text');
});

test('one person complaining repeatedly counts as a single voice', () => {
  const index = buildEngagementIndex([]);
  const cluster = {
    id: 'c1', label: 'export is broken',
    members: [
      mention({ evidenceId: 'e1', pain: 'export is broken', voiceId: 'reddit:user:sam', threadId: 't1' }),
      mention({ evidenceId: 'e2', pain: 'export is broken', voiceId: 'reddit:user:sam', threadId: 't2' }),
      mention({ evidenceId: 'e3', pain: 'export is broken', voiceId: 'reddit:user:sam', threadId: 't3' }),
    ],
  };
  const scored = scoreCluster(cluster, index);
  assert.equal(scored.distinctVoices, 1);
  assert.equal(scored.qualifies, false, 'one voice cannot become an opportunity');
});

test('a single viral thread cannot manufacture an opportunity', () => {
  const index = buildEngagementIndex([]);
  const cluster = {
    id: 'c1', label: 'sync fails',
    members: Array.from({ length: 10 }, (_, i) =>
      mention({ evidenceId: `e${i}`, pain: 'sync fails', voiceId: `reddit:user:u${i}`, threadId: 'same-thread' }),
    ),
  };
  const scored = scoreCluster(cluster, index);
  // Ten different people, but all in one thread: capped at three.
  assert.equal(scored.countedMentions, 3);
  assert.equal(scored.distinctVoices, 3);
});

test('the opportunity floor requires three voices AND two source types', () => {
  const index = buildEngagementIndex([]);

  const oneSource = scoreCluster({
    id: 'c1', label: 'p',
    members: [
      mention({ evidenceId: 'a', pain: 'p', voiceId: 'v1', threadId: 't1', source: 'reddit' }),
      mention({ evidenceId: 'b', pain: 'p', voiceId: 'v2', threadId: 't2', source: 'reddit' }),
      mention({ evidenceId: 'c', pain: 'p', voiceId: 'v3', threadId: 't3', source: 'reddit' }),
    ],
  }, index);
  assert.equal(oneSource.distinctVoices, 3);
  assert.equal(oneSource.qualifies, false, 'three voices but only one source');

  const twoSources = scoreCluster({
    id: 'c2', label: 'p',
    members: [
      mention({ evidenceId: 'a', pain: 'p', voiceId: 'v1', threadId: 't1', source: 'reddit' }),
      mention({ evidenceId: 'b', pain: 'p', voiceId: 'v2', threadId: 't2', source: 'github' }),
      mention({ evidenceId: 'c', pain: 'p', voiceId: 'v3', threadId: 't3', source: 'reddit' }),
    ],
  }, index);
  assert.equal(twoSources.qualifies, true);
});

test('components sum to the displayed score using the published weights', () => {
  const index = buildEngagementIndex([]);
  const scored = scoreCluster({
    id: 'c1', label: 'p',
    members: [
      mention({ evidenceId: 'a', pain: 'p', voiceId: 'v1', threadId: 't1', source: 'reddit', severity: 'paying' }),
      mention({ evidenceId: 'b', pain: 'p', voiceId: 'v2', threadId: 't2', source: 'github' }),
    ],
  }, index);

  const recomputed = weightedScore(scored.components, WEIGHTS);
  assert.ok(Math.abs(recomputed - scored.score) < 1e-9, 'score is exactly its parts');
  assert.ok(scored.score >= 0 && scored.score <= 1);
});

test('rank-sensitive clusters are flagged when weighting changes the order', () => {
  const index = buildEngagementIndex([]);

  // Broad but mild: many voices, lowest severity.
  const broad = scoreCluster({
    id: 'broad', label: 'minor annoyance',
    members: Array.from({ length: 8 }, (_, i) =>
      mention({
        evidenceId: `b${i}`, pain: 'minor annoyance', voiceId: `v${i}`,
        threadId: `t${i}`, source: i % 2 ? 'github' : 'reddit', severity: 'mentioned',
      }),
    ),
  }, index);

  // Narrow but severe: few voices, people abandoning the task.
  const severe = scoreCluster({
    id: 'severe', label: 'data loss on export',
    members: Array.from({ length: 3 }, (_, i) =>
      mention({
        evidenceId: `s${i}`, pain: 'data loss on export', voiceId: `w${i}`,
        threadId: `u${i}`, source: i % 2 ? 'github' : 'reddit', severity: 'blocked',
      }),
    ),
  }, index);

  const ranked = rankClusters([broad, severe]);
  assert.equal(ranked.length, 2);
  assert.ok(
    ranked.some((cluster) => cluster.rankSensitive),
    'breadth-vs-severity disagreement must be surfaced, not hidden',
  );
  for (const cluster of ranked) {
    assert.equal(cluster.rankRange.length, 2);
    assert.ok(cluster.rankRange[0] <= cluster.rank && cluster.rank <= cluster.rankRange[1]);
  }
});

test('clustering is deterministic and records why each member joined', () => {
  const mentions = [
    mention({ evidenceId: 'a', pain: 'cannot export my notes' }),
    mention({ evidenceId: 'b', pain: 'cannot export notes easily' }),
    mention({ evidenceId: 'c', pain: 'no dark mode on mobile' }),
    mention({ evidenceId: 'd', pain: 'billing page times out' }),
  ];

  const first = clusterMentions(mentions);
  const second = clusterMentions([...mentions].reverse());

  assert.equal(first.length, 3, 'two export complaints merge, the others do not');
  assert.deepEqual(
    first.map((c) => c.members.length).sort(),
    second.map((c) => c.members.length).sort(),
    'input order must not change the outcome',
  );
  for (const cluster of first) {
    for (const member of cluster.members) {
      assert.ok(member.joinedAt > 0 && member.joinedAt <= 1, 'similarity is recorded');
    }
  }
});

test('a counter the platform never publishes is not scored as zero', () => {
  // HN hides comment points. Treating that as "0 points" both dragged the
  // distribution down and produced "0 points, 81st percentile" in the UI,
  // implying a popularity that was never measured.
  const stories = Array.from({ length: 12 }, (_, i) => item(`s${i}`, 'hackernews', i * 5));
  const comment = makeEvidence({
    id: 'c1', source: 'hackernews', kind: 'comment', title: 't', body: 'b',
    url: 'https://news.ycombinator.com/item?id=1', author: 'someone',
    publishedAt: new Date().toISOString().slice(0, 10),
    primary: 0, engagementAvailable: false,
  });

  const index = buildEngagementIndex([...stories, comment]);

  assert.equal(index.percentileFor('c1'), null, 'no percentile is invented');
  assert.equal(index.perSource.hackernews.count, 12, 'unscorable items stay out of the distribution');
  assert.equal(index.perSource.hackernews.unscorable, 1);

  const described = describeEngagement(comment, index);
  assert.equal(described.native, null);
  assert.match(described.text, /no points published/);
  assert.doesNotMatch(described.text, /percentile/);
});

test('reach ignores unmeasurable items instead of averaging in zeros', () => {
  const scored = item('r0', 'reddit', 500);
  const unscorable = makeEvidence({
    id: 'u0', source: 'hackernews', kind: 'comment', title: 't', body: 'b',
    url: 'https://news.ycombinator.com/item?id=2', author: 'x',
    publishedAt: new Date().toISOString().slice(0, 10),
    primary: 0, engagementAvailable: false,
  });
  // 12 reddit items so reddit clears the percentile floor and r0 ranks top.
  const filler = Array.from({ length: 11 }, (_, i) => item(`f${i}`, 'reddit', i));
  const index = buildEngagementIndex([scored, unscorable, ...filler]);

  const cluster = {
    id: 'c1', label: 'p',
    members: [
      mention({ evidenceId: 'r0', pain: 'p', voiceId: 'v1', threadId: 't1', source: 'reddit' }),
      mention({ evidenceId: 'u0', pain: 'p', voiceId: 'v2', threadId: 't2', source: 'hackernews' }),
    ],
  };
  const result = scoreCluster(cluster, index);
  assert.equal(result.components.reach, 1, 'the one measurable item defines reach');
});
