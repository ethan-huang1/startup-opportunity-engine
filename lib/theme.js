/**
 * Groups lexically-distinct pain phrases that describe the same underlying
 * problem.
 *
 * WHY THIS STAGE EXISTS — and why it uses the model.
 *
 * Clustering was originally meant to be purely lexical. Measured against a real
 * 65-phrase run, it could not work: "Cannot access notes across devices" and
 * "Org mode lacks device syncing" are the same complaint and share exactly one
 * word after stemming. Character and token overlap tuned to catch them also
 * merged "Cannot access notes across devices" with "Notes lack security
 * features and access controls", which is a different problem entirely. No
 * threshold separated the two cases, so the deterministic version silently
 * fragmented real recurring pain into singletons and reported "insufficient
 * evidence" for markets where the evidence was actually there.
 *
 * WHAT IS AND IS NOT DELEGATED.
 *
 * The model only decides *which already-extracted phrases belong together*. It
 * is structurally unable to affect what the evidence says:
 *   - it never sees the market framing, the scores, or the ranking;
 *   - it cannot introduce a phrase — anything it returns that we did not
 *     extract is dropped, exactly like an unverified quote;
 *   - it cannot introduce or move evidence, because quotes stay bound to the
 *     phrase they were verified against;
 *   - anything it fails to assign survives on its own rather than disappearing.
 *
 * Scoring and ranking remain fully deterministic on whatever groups come out,
 * and the UI shows which phrases were merged so the grouping is auditable.
 */

import { askForJson } from './claude.js';
import { MODELS } from './config.js';

function buildPrompt(labels) {
  const numbered = labels.map((label, index) => `${index + 1}. ${label}`).join('\n');

  return `Below are short phrases describing problems, each extracted from a different public post.

Group together the ones that describe THE SAME underlying problem. Different wording for the same complaint belongs in one group — for example "cannot access notes across devices" and "no syncing between phone and laptop" are the same problem.

Do NOT group problems that merely share a topic. "Cannot sync across devices" and "notes lack encryption" are both about notes, but they are different problems and must stay separate.

Phrases:
${numbered}

Return raw JSON: an array of groups, each shaped:
{"theme": "<short neutral name for the shared problem, under 10 words>", "members": [<the phrase numbers in this group>]}

Rules:
- Use each number at most once.
- A phrase that shares no problem with any other is its own group of one. Most phrases will be.
- Only use numbers from the list above.
- Prefer leaving things separate when unsure. Wrongly merging two different problems is worse than leaving them apart.

Reply with raw JSON only.`;
}

/**
 * @param {Array} clusters lexical clusters (each with `label` and `members`)
 * @returns {{clusters: Array, stats: object}} merged clusters
 */
export async function groupByTheme(clusters, { onProgress } = {}) {
  const stats = {
    inputGroups: clusters.length,
    merged: 0,
    rejectedUnknownIndex: 0,
    rejectedDuplicateIndex: 0,
    failed: false,
  };

  // Nothing to gain from a call when there is nothing that could merge.
  if (clusters.length < 2) return { clusters, stats };

  onProgress?.({ status: 'start', count: clusters.length });

  let response;
  try {
    response = await askForJson(buildPrompt(clusters.map((cluster) => cluster.label)), {
      model: MODELS.extract,
    });
  } catch {
    // Grouping is an enhancement. If it fails the lexical clusters are still
    // valid evidence groupings, just more fragmented, and the run says so.
    stats.failed = true;
    return { clusters, stats };
  }

  const groups = Array.isArray(response) ? response : response?.groups || [];
  const used = new Set();
  const merged = [];

  for (const group of groups) {
    const indices = [];
    for (const raw of group?.members || []) {
      const index = Number(raw) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= clusters.length) {
        stats.rejectedUnknownIndex += 1;
        continue;
      }
      if (used.has(index)) {
        stats.rejectedDuplicateIndex += 1;
        continue;
      }
      used.add(index);
      indices.push(index);
    }
    if (indices.length === 0) continue;

    const parts = indices.map((index) => clusters[index]);
    if (parts.length === 1) {
      merged.push(parts[0]);
      continue;
    }

    stats.merged += parts.length - 1;
    merged.push({
      id: parts[0].id,
      // Fall back to the strongest lexical label if the model's theme is empty,
      // so a group is never nameless.
      label: String(group.theme || '').trim() || parts[0].label,
      themed: true,
      mergedFrom: parts.map((part) => part.label),
      members: parts.flatMap((part) => part.members),
    });
  }

  // Anything the model ignored keeps its own group rather than vanishing.
  for (const [index, cluster] of clusters.entries()) {
    if (!used.has(index)) merged.push(cluster);
  }

  onProgress?.({ status: 'done', count: merged.length });
  return { clusters: merged, stats: { ...stats, outputGroups: merged.length } };
}
