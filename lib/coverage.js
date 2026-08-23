/**
 * Stage 0 — is this market even visible to our sources?
 *
 * Reddit, Hacker News, and GitHub are developer- and early-adopter-heavy. Ask
 * them about independent HVAC contractors, dental practices, or freight brokers
 * and they will return a handful of tangential posts. Squeezing "opportunities"
 * out of that would produce confident nonsense that reflects the sources' bias
 * rather than the market.
 *
 * So we count what actually came back and refuse to continue when it is too
 * thin. The verdict is measured, never guessed: no model is asked whether a
 * market is "traditional".
 */

import {
  COVERAGE,
  QUALIFIED_COVERAGE,
  WINDOW_DAYS,
  SOURCE_NAMES,
  PLATFORM_OF,
} from './config.js';
import { STATE } from './http.js';
import { isInWindow } from './normalize.js';
import { CATEGORY_LABELS } from './evidence-type.js';

export const VERDICT = {
  ADEQUATE: 'adequate',
  THIN: 'thin',
  INSUFFICIENT: 'insufficient',
  // The analysis did not run, so we know nothing about this market either way.
  // Distinct from INSUFFICIENT, which is a finding.
  UNKNOWN: 'unknown',
};

/** Failure states mean we learned nothing — not that the source was silent. */
const DEGRADED_STATES = new Set([
  STATE.RATE_LIMITED,
  STATE.UNREACHABLE,
  STATE.TIMEOUT,
  STATE.ERROR,
]);

/**
 * @param {Array<{source: string, state: string, items: Array, error: ?string}>} results
 * @returns coverage report consumed by both the API and the UI
 */
export function assessCoverage(results, { windowDays = WINDOW_DAYS } = {}) {
  const perSource = results.map((result) => {
    const inWindow = result.items.filter((item) => isInWindow(item, windowDays));
    return {
      source: result.source,
      label: SOURCE_NAMES[result.source] || result.source,
      state: result.state,
      degraded: DEGRADED_STATES.has(result.state),
      itemsReturned: result.items.length,
      itemsInWindow: inWindow.length,
      error: result.error,
    };
  });

  const totalInWindow = perSource.reduce((sum, s) => sum + s.itemsInWindow, 0);
  const contributingSources = perSource.filter((s) => s.itemsInWindow > 0).length;
  const degradedSources = perSource.filter((s) => s.degraded);

  let verdict;
  if (
    totalInWindow < COVERAGE.insufficientMaxItems ||
    contributingSources < COVERAGE.minSourcesForAdequate
  ) {
    verdict = VERDICT.INSUFFICIENT;
  } else if (
    totalInWindow >= COVERAGE.adequateMinItems &&
    contributingSources >= COVERAGE.minSourcesForAdequate
  ) {
    verdict = VERDICT.ADEQUATE;
  } else {
    verdict = VERDICT.THIN;
  }

  return {
    verdict,
    totalInWindow,
    contributingSources,
    perSource,
    degradedSources: degradedSources.map((s) => s.label),
    // Shown next to the verdict so the user can see the cutoffs and disagree.
    thresholds: {
      insufficientBelow: COVERAGE.insufficientMaxItems,
      adequateAtOrAbove: COVERAGE.adequateMinItems,
      minSources: COVERAGE.minSourcesForAdequate,
    },
    explanation: explain(verdict, totalInWindow, contributingSources, degradedSources),
  };
}

/**
 * The verdict that gets reported — computed from verified customer statements,
 * not from how many items matched a keyword.
 *
 * @param {Array} mentions verified first-hand / reported problem statements
 * @param {Array} setAside statements the classifier excluded, with reasons
 * @param {object} retrieval the earlier item-count assessment, for context
 */
export function assessQualifiedCoverage(mentions, setAside, retrieval) {
  const voices = new Set(mentions.map((m) => m.voiceId));
  const platforms = new Set(mentions.map((m) => PLATFORM_OF[m.source] || m.source));

  const perCategory = {};
  for (const mention of [...mentions, ...setAside]) {
    perCategory[mention.category] = (perCategory[mention.category] || 0) + 1;
  }

  const statements = mentions.length;
  let verdict;
  if (
    statements < QUALIFIED_COVERAGE.insufficientBelowStatements ||
    voices.size < QUALIFIED_COVERAGE.insufficientBelowVoices ||
    platforms.size < QUALIFIED_COVERAGE.minPlatforms
  ) {
    verdict = VERDICT.INSUFFICIENT;
  } else if (
    statements >= QUALIFIED_COVERAGE.adequateMinStatements &&
    voices.size >= QUALIFIED_COVERAGE.adequateMinVoices &&
    platforms.size >= QUALIFIED_COVERAGE.minPlatforms
  ) {
    verdict = VERDICT.ADEQUATE;
  } else {
    verdict = VERDICT.THIN;
  }

  return {
    verdict,
    statements,
    distinctVoices: voices.size,
    platforms: [...platforms],
    setAsideCount: setAside.length,
    perCategory,
    categoryLabels: CATEGORY_LABELS,
    thresholds: QUALIFIED_COVERAGE,
    explanation: explainQualified(verdict, statements, voices.size, platforms, retrieval),
  };
}

function explainQualified(verdict, statements, voices, platforms, retrieval) {
  const collected = retrieval?.totalInWindow ?? 0;
  const base =
    `${statements} verified customer ${statements === 1 ? 'statement' : 'statements'} ` +
    `from ${voices} distinct ${voices === 1 ? 'person' : 'people'} across ` +
    `${platforms.size} ${platforms.size === 1 ? 'platform' : 'platforms'}, ` +
    `out of ${collected} items collected.`;

  if (verdict === VERDICT.INSUFFICIENT) {
    if (platforms.size < QUALIFIED_COVERAGE.minPlatforms) {
      return (
        `${base} Only ${platforms.size === 1 ? 'one platform carries' : 'no platform carries'} ` +
        'this conversation, so nothing here can be corroborated against an independent ' +
        'source. Separate subreddits are the same platform, not two. Ranking on this ' +
        'would describe where we happened to look rather than the market.'
      );
    }
    return (
      `${base} Most of what came back was not a customer describing a problem — ` +
      'it was incidental mentions, promotional posts, or proposals for what someone ' +
      'wants built. There is not enough real customer evidence here to rank anything.'
    );
  }
  if (verdict === VERDICT.THIN) {
    return (
      `${base} Enough to read, not enough to rank confidently — a few statements ` +
      'either way would reshuffle the order.'
    );
  }
  return base;
}

function explain(verdict, total, sources, degraded) {
  const degradedList = degraded.map((s) => s.label).join(' and ');
  const degradedNote =
    degraded.length > 0
      ? ` ${degradedList} did not complete (${degraded.map((s) => s.state).join(', ')}), ` +
        'so this count understates what may exist — absence of evidence from a ' +
        'failed source is not evidence of absence.'
      : '';

  const counted =
    `${total} in-window ${total === 1 ? 'item' : 'items'}` +
    (sources > 0 ? ` across ${sources} ${sources === 1 ? 'source' : 'sources'}` : ' from any source');

  if (verdict === VERDICT.INSUFFICIENT) {
    // A source that failed tells us nothing about the market. Concluding "these
    // customers do not post here" would be unsupported when we never actually
    // managed to look, so the two cases get different explanations.
    if (degraded.length > 0) {
      return (
        `Only ${counted}, and the search did not complete: ${degradedList} returned ` +
        `${degraded.map((s) => s.state).join(', ')}. There is not enough here to rank ` +
        'anything, and we cannot tell you whether that is because this market is ' +
        'quiet on these sources or because we failed to reach them. Retrying may ' +
        'give a different answer.'
      );
    }
    return (
      `Only ${counted}. Reddit, Hacker News, and GitHub are developer- and ` +
      'tech-community-skewed, and the people in this market most likely do not ' +
      'discuss their problems there. Any opportunities ranked from this little ' +
      'evidence would describe the sources, not the market.'
    );
  }
  if (verdict === VERDICT.THIN) {
    return (
      `${total} in-window items across ${sources} sources. That is enough to look ` +
      'at, but not enough to rank confidently — treat the ordering below as ' +
      'exploratory, since a few posts either way would reshuffle it.' + degradedNote
    );
  }
  return (
    `${total} in-window items across ${sources} sources.` + degradedNote
  );
}
