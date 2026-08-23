/**
 * Evidence Strength scoring.
 *
 * THIS IS NOT A PREDICTION OF STARTUP SUCCESS. It measures one thing: how well
 * supported a pain cluster is by the sources we happened to search. It knows
 * nothing about market size, willingness to pay, competition, feasibility,
 * regulation, timing, or whether anyone should build the thing.
 *
 * The weights are an editorial judgment, not a validated model. Because that is
 * true, the module also reports how much each cluster's *rank* depends on those
 * weights, so a position that only holds under one particular weighting is
 * visibly flagged rather than presented as a finding.
 *
 * Four of the five components are computed from evidence with no AI involved.
 * Only Severity derives from the model's reading of the quotes, and it carries
 * the smallest weight.
 */

import {
  WEIGHTS,
  MENTIONS_PER_THREAD_CAP,
  MENTIONS_PER_CONTAINER_CAP,
  FREQUENCY_SATURATION,
  WINDOW_DAYS,
  OPPORTUNITY_FLOOR,
  PLATFORM_OF,
} from './config.js';

const SEVERITY_VALUE = { mentioned: 0.25, workaround: 0.5, paying: 1, blocked: 0.85 };

/**
 * Counts the mentions that are allowed to contribute.
 *
 * Two rules stop a cluster from being inflated:
 *  - distinct voices, not mentions: one person complaining five times is one
 *    voice, so repetition by a single account adds nothing;
 *  - a per-thread cap: one viral thread cannot manufacture an opportunity on
 *    its own, no matter how many people pile into it.
 */
function countableMentions(members) {
  const perThread = new Map();
  const perContainer = new Map();
  const seenVoices = new Set();
  const counted = [];

  for (const member of members) {
    if (seenVoices.has(member.voiceId)) continue;

    const threadUsed = perThread.get(member.threadId) || 0;
    if (threadUsed >= MENTIONS_PER_THREAD_CAP) continue;

    // Every GitHub issue is its own thread, so the thread cap alone never
    // stopped one project from dominating: a single hobby repo supplied 10 of
    // 45 GitHub items in a trucking run. Cap the repo or subreddit too.
    const container = member.container || member.threadId;
    const containerUsed = perContainer.get(container) || 0;
    if (containerUsed >= MENTIONS_PER_CONTAINER_CAP) continue;

    perThread.set(member.threadId, threadUsed + 1);
    perContainer.set(container, containerUsed + 1);
    seenVoices.add(member.voiceId);
    counted.push(member);
  }
  return counted;
}

/** Log scale: the step from 1 to 3 voices matters far more than 20 to 22. */
function frequencyScore(voiceCount) {
  if (voiceCount <= 0) return 0;
  return Math.min(1, Math.log(1 + voiceCount) / Math.log(1 + FREQUENCY_SATURATION));
}

function recencyScore(members, now = Date.now()) {
  const ages = members
    .map((member) => member.publishedAt)
    .filter(Boolean)
    .map((date) => (now - new Date(date).getTime()) / 86400000);
  if (ages.length === 0) return 0;
  const meanAge = ages.reduce((sum, age) => sum + age, 0) / ages.length;
  return Math.max(0, Math.min(1, 1 - meanAge / WINDOW_DAYS));
}

function severityScore(members) {
  if (members.length === 0) return 0;
  // The strongest signal in a cluster carries most of the weight: one person
  // who abandoned the task says more than five who mentioned it in passing.
  const values = members.map((m) => SEVERITY_VALUE[m.severity] ?? 0.25);
  const max = Math.max(...values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return max * 0.7 + mean * 0.3;
}

/** Computes the five components for one cluster. All 0..1. */
export function scoreCluster(cluster, engagementIndex, { now = Date.now() } = {}) {
  const counted = countableMentions(cluster.members);
  const voices = new Set(counted.map((m) => m.voiceId));
  // Independent PLATFORMS, not collectors and not containers. Two subreddits
  // are two corners of one site, and the plugin's Reddit search and the
  // arctic-shift archive both read Reddit. Corroboration only means something
  // across genuinely separate places.
  const sources = new Set(counted.map((m) => PLATFORM_OF[m.source] || m.source));

  // Items whose platform publishes no counter (HN comments) return null and are
  // left out rather than counted as zero, which would understate real reach.
  const reachValues = counted
    .map((m) => engagementIndex.percentileFor(m.evidenceId))
    .filter((value) => value !== null);
  const reach = reachValues.length
    ? reachValues.reduce((sum, value) => sum + value, 0) / reachValues.length
    : 0;

  const components = {
    frequency: frequencyScore(voices.size),
    reach,
    recency: recencyScore(counted, now),
    sourceDiversity: Math.min(1, sources.size / 3),
    severity: severityScore(counted),
  };

  return {
    ...cluster,
    countedMentions: counted.length,
    distinctVoices: voices.size,
    sourceTypes: [...sources],
    components,
    score: weightedScore(components, WEIGHTS),
    qualifies:
      voices.size >= OPPORTUNITY_FLOOR.minDistinctVoices &&
      sources.size >= OPPORTUNITY_FLOOR.minSourceTypes,
  };
}

export function weightedScore(components, weights) {
  return (
    components.frequency * weights.frequency +
    components.reach * weights.reach +
    components.recency * weights.recency +
    components.sourceDiversity * weights.sourceDiversity +
    components.severity * weights.severity
  );
}

/**
 * Alternative weightings used to test how stable the ranking is.
 *
 * Each is a defensible way to read the same evidence — someone who cares most
 * about how many people are affected, versus how badly, versus how recently.
 * If the order changes depending on which you pick, that is worth knowing.
 */
const ALTERNATIVE_WEIGHTS = [
  { name: 'balanced', frequency: 0.2, reach: 0.2, recency: 0.2, sourceDiversity: 0.2, severity: 0.2 },
  { name: 'breadth-first', frequency: 0.5, reach: 0.2, recency: 0.1, sourceDiversity: 0.15, severity: 0.05 },
  { name: 'severity-first', frequency: 0.15, reach: 0.1, recency: 0.15, sourceDiversity: 0.1, severity: 0.5 },
  { name: 'recency-first', frequency: 0.15, reach: 0.15, recency: 0.5, sourceDiversity: 0.1, severity: 0.1 },
  { name: 'corroboration-first', frequency: 0.2, reach: 0.1, recency: 0.1, sourceDiversity: 0.5, severity: 0.1 },
];

/**
 * Ranks clusters and marks the ones whose position depends on the weighting.
 *
 * A cluster that sits 1st under one reasonable weighting and 5th under another
 * is not a robust finding, and the UI says so instead of quietly presenting
 * whichever order the default weights produced.
 */
export function rankClusters(scored) {
  const ranked = [...scored].sort((a, b) => b.score - a.score);

  const positions = new Map(ranked.map((cluster, index) => [cluster.id, [index]]));
  for (const weights of ALTERNATIVE_WEIGHTS) {
    const alternative = [...scored]
      .map((cluster) => ({ id: cluster.id, value: weightedScore(cluster.components, weights) }))
      .sort((a, b) => b.value - a.value);
    alternative.forEach((entry, index) => positions.get(entry.id).push(index));
  }

  return ranked.map((cluster, index) => {
    const seen = positions.get(cluster.id);
    const swing = Math.max(...seen) - Math.min(...seen);
    return {
      ...cluster,
      rank: index + 1,
      rankSwing: swing,
      // Any movement under a defensible weighting means this position is a
      // product of the weights rather than of the evidence. No threshold is
      // used because there is no principled place to put one — the honest
      // artifact is `rankRange`, which the UI shows as "ranked 1st-3rd
      // depending on weighting".
      rankSensitive: swing >= 1,
      rankRange: [Math.min(...seen) + 1, Math.max(...seen) + 1],
    };
  });
}
