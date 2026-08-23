/**
 * End-to-end chain verification for a finished report.
 *
 * A verbatim quote proves the text is authentic. It does NOT prove that the
 * opportunity written above it follows from that text. The fabricated fixture
 * that prompted this module had ten genuinely-sliced quotes attached to claims
 * nobody made — every quote was real, and the conclusion was still invented.
 *
 * So this walks the whole chain instead of one link:
 *
 *   evidence item -> extracted mention -> cluster member -> framed opportunity
 *
 * and checks that each hop is anchored to the one before it. It is deliberately
 * mechanical: it can catch cross-wiring, orphaned citations, and arithmetic that
 * does not match its parts. It cannot judge whether prose is a fair reading of
 * its quotes — nothing automated can — which is why the fixture generator
 * refuses to synthesize framing at all.
 */

import { quoteIsVerbatim } from './extract.js';
import { weightedScore } from './score.js';
import { PLATFORM_OF } from './config.js';

/**
 * @param {object} report a finished pipeline report
 * @returns {{ok: boolean, problems: string[], checked: object}}
 */
export function verifyReportChain(report) {
  const problems = [];
  const evidenceById = new Map((report.evidence || []).map((item) => [item.id, item]));

  const checked = {
    opportunities: 0,
    weakSignals: 0,
    mentions: 0,
    quotes: 0,
  };

  const clusters = [
    ...(report.opportunities || []).map((cluster) => ({ cluster, ranked: true })),
    ...(report.weakSignals || []).map((cluster) => ({ cluster, ranked: false })),
  ];

  for (const { cluster, ranked } of clusters) {
    const where = `${ranked ? 'opportunity' : 'weak signal'} "${cluster.label}"`;
    if (ranked) checked.opportunities += 1;
    else checked.weakSignals += 1;

    if (!cluster.members || cluster.members.length === 0) {
      problems.push(`${where}: has no members — nothing supports it`);
      continue;
    }

    const platforms = new Set();

    for (const member of cluster.members) {
      checked.mentions += 1;

      // Hop 1: the mention must point at evidence we actually collected.
      const item = evidenceById.get(member.evidenceId);
      if (!item) {
        problems.push(`${where}: cites "${member.evidenceId}" which is not in the evidence list`);
        continue;
      }

      // Hop 2: the quote must be verbatim in that item's own fields. Title and
      // body are passed separately so a quote cannot span the boundary.
      checked.quotes += 1;
      if (!quoteIsVerbatim(member.quote, item.title, item.body)) {
        problems.push(
          `${where}: quote is not verbatim in ${item.id} — "${(member.quote || '').slice(0, 60)}…"`,
        );
      }

      // Hop 3: the mention's carried metadata must match the item it came from,
      // so a quote cannot be re-attributed to a different person or platform.
      if (member.source !== item.source) {
        problems.push(`${where}: mention claims source "${member.source}" but ${item.id} is "${item.source}"`);
      }
      if (member.voiceId !== item.voiceId) {
        problems.push(`${where}: mention voice "${member.voiceId}" does not match ${item.id}`);
      }
      if (member.publishedAt !== item.publishedAt) {
        problems.push(`${where}: mention date ${member.publishedAt} does not match ${item.id} (${item.publishedAt})`);
      }
      if (!item.url) {
        problems.push(`${where}: ${item.id} has no source URL, so the claim is not traceable`);
      }

      platforms.add(PLATFORM_OF[item.source] || item.source);
    }

    // Hop 4: the cluster's own summary numbers must match its members.
    const recomputedPlatforms = [...platforms].sort().join(',');
    const declaredPlatforms = [...new Set(cluster.sourceTypes || [])].sort().join(',');
    if (declaredPlatforms && recomputedPlatforms !== declaredPlatforms) {
      problems.push(
        `${where}: declares platforms [${declaredPlatforms}] but its members are from [${recomputedPlatforms}]`,
      );
    }

    // Hop 5: the score must equal its published parts.
    if (cluster.components && report.weights) {
      const recomputed = weightedScore(cluster.components, report.weights);
      if (Math.abs(recomputed - cluster.score) > 1e-6) {
        problems.push(
          `${where}: score ${cluster.score} does not equal its components (${recomputed.toFixed(6)})`,
        );
      }
    }

    // Hop 6: a ranked opportunity must carry framing, and framing must not
    // exist without a cluster to have come from.
    if (ranked && !cluster.opportunity) {
      problems.push(`${where}: ranked but has no framing`);
    }
    if (!ranked && cluster.opportunity) {
      problems.push(`${where}: not ranked, yet carries framing — framing is only produced for qualifying clusters`);
    }
  }

  // A report that claims a fixture provenance must say where it came from.
  if (report.fixture && !report.fixtureSource) {
    problems.push('fixture report does not record which run it was snapshotted from');
  }

  return { ok: problems.length === 0, problems, checked };
}
