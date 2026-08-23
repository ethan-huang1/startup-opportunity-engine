/**
 * Turns a qualifying evidence cluster into a described opportunity.
 *
 * This is the only stage that writes prose, and it is deliberately boxed in:
 * one call per cluster, and the model sees *only that cluster's verified
 * quotes*. It cannot see other clusters, the ranking, the scores, or the rest
 * of the corpus, so it has nothing to synthesize an idea out of except the
 * evidence in front of it.
 *
 * There is no cross-cluster synthesis step anywhere in this pipeline. That is
 * exactly where an "AI idea generator" would smuggle in inventions, so it does
 * not exist. Opportunities are 1:1 with clusters that cleared the evidence
 * floor: no evidence, no opportunity.
 *
 * Everything produced here is tagged `inferred` and rendered as such.
 */

import { askForJson } from './claude.js';
import { MODELS, SOURCE_NAMES } from './config.js';

const CONCURRENCY = 3;

function buildPrompt(market, cluster) {
  const quotes = cluster.members
    .map((member) => {
      const source = SOURCE_NAMES[member.source] || member.source;
      return `- [${source}, ${member.publishedAt || 'undated'}] "${member.quote}"`;
    })
    .join('\n');

  return `Researching the market "${market}", these quotes were collected from separate public posts and grouped because they describe the same underlying problem.

${quotes}

Describe the opportunity these quotes point to. Base every statement only on what is quoted above — you have not seen any other evidence, and there is none.

Return raw JSON with exactly these keys:
- "name": a short plain name for the opportunity (under 8 words). Name the problem being solved, not a product.
- "customer": who specifically is affected, as evidenced by the quotes
- "problem": one or two sentences stating the problem the quotes describe
- "whyNow": one sentence on what makes this current, or "" if the quotes give no basis for that
- "evidenceGaps": one sentence naming what these quotes do NOT establish (for example willingness to pay, how many people are affected, whether a solution exists)

Rules:
- Do not invent details, numbers, company names, or customer segments that are not in the quotes.
- Do not propose a product, pricing, or go-to-market.
- Do not claim the market is large or that this is a good business — nothing above supports that.
- "evidenceGaps" must be honest and specific. It is the most useful field here.

Reply with raw JSON only.`;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function pump() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => pump()));
  return results;
}

/**
 * @param {string} market
 * @param {Array} clusters ranked clusters that cleared the evidence floor
 * @returns {Array} clusters with an `opportunity` field (null when framing failed)
 */
export async function frameOpportunities(market, clusters, { onProgress } = {}) {
  let completed = 0;

  return mapWithConcurrency(clusters, CONCURRENCY, async (cluster) => {
    let framed = null;
    try {
      const response = await askForJson(buildPrompt(market, cluster), { model: MODELS.frame });
      framed = {
        name: String(response.name || '').trim(),
        customer: String(response.customer || '').trim(),
        problem: String(response.problem || '').trim(),
        whyNow: String(response.whyNow || '').trim(),
        evidenceGaps: String(response.evidenceGaps || '').trim(),
      };
      if (!framed.name || !framed.problem) framed = null;
    } catch {
      // Framing is the presentation layer. If it fails the evidence is still
      // real, so the cluster is kept and rendered from its quotes alone.
      framed = null;
    } finally {
      completed += 1;
      onProgress?.({ done: completed, of: clusters.length });
    }

    return { ...cluster, opportunity: framed };
  });
}
