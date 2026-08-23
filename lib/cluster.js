/**
 * Groups pain-point mentions into recurring themes.
 *
 * Single-pass leader clustering: mentions are visited in a fixed order, and
 * each either joins the first existing cluster it is similar enough to, or
 * becomes the leader of a new one. Deterministic, order-stable, and every
 * decision is a number the UI can show — "joined because it is 0.62 similar to
 * this cluster's leader" — which a vector distance from a hosted embedding
 * model could not be.
 */

import { prepare, preparedSimilarity } from './similarity.js';
import { SIMILARITY } from './config.js';

/**
 * Visit order decides which mention becomes a cluster's leader, so it must be
 * deterministic. Strongest evidence leads: severity first (someone who
 * abandoned the task describes the problem more sharply than someone who
 * mentioned it), then recency, then id as a stable tiebreak.
 */
const SEVERITY_RANK = { blocked: 3, paying: 2, workaround: 1, mentioned: 0 };

function visitOrder(a, b) {
  const severity = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
  if (severity !== 0) return severity;
  const dateA = a.publishedAt || '';
  const dateB = b.publishedAt || '';
  if (dateA !== dateB) return dateA > dateB ? -1 : 1;
  return a.evidenceId < b.evidenceId ? -1 : 1;
}

/**
 * @param {Array} mentions verified pain-point mentions
 * @returns {Array} clusters, each with its members and the similarity that put them there
 */
export function clusterMentions(mentions) {
  const ordered = [...mentions].sort(visitOrder);
  const clusters = [];

  for (const mention of ordered) {
    const prepared = prepare(mention.pain);

    let best = null;
    for (const cluster of clusters) {
      const score = preparedSimilarity(prepared, cluster.leaderPrepared);
      if (score >= SIMILARITY.clusterJoin && (!best || score > best.score)) {
        best = { cluster, score };
      }
    }

    if (best) {
      best.cluster.members.push({ ...mention, joinedAt: Number(best.score.toFixed(3)) });
    } else {
      clusters.push({
        id: `cluster-${clusters.length + 1}`,
        // The leader's phrasing names the cluster until an opportunity is
        // framed for it. It is a real extracted phrase, not a generated label.
        label: mention.pain,
        leaderPrepared: prepared,
        members: [{ ...mention, joinedAt: 1 }],
      });
    }
  }

  return clusters.map(({ leaderPrepared, ...cluster }) => cluster);
}
