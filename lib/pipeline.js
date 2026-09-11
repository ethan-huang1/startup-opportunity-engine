/**
 * The evidence-to-opportunity pipeline, in order.
 *
 * Collect -> dedupe -> coverage gate -> extract (AI, quote-gated) -> cluster
 * (lexical, then AI theme grouping) -> normalize engagement -> score -> floor
 * gate -> frame (AI, cluster-scoped).
 *
 * The ordering is the argument. Scoring and ranking are entirely deterministic
 * and happen before any prose is written, so an opportunity is always the
 * *output* of evidence rather than a hypothesis that went looking for some.
 *
 * The model is used at three points, and is boxed in at each:
 *   - extraction can only report a problem alongside a quote we verify exists
 *     verbatim in that specific document;
 *   - theme grouping can only rearrange phrases that extraction already
 *     produced, and anything it invents is discarded (see lib/theme.js);
 *   - framing sees one cluster's quotes and nothing else.
 * None of these can introduce evidence, and none of them touch the scores.
 */

import { collectHackerNews } from './collectors/hackernews.js';
import { collectGitHub } from './collectors/github.js';
import { collectReddit } from './collectors/reddit.js';
import { collectRedditArchive, probeSubreddit } from './collectors/reddit-archive.js';
import { resolveSubreddits } from './subreddits.js';
import { dedupe, uniqueItems } from './dedupe.js';
import { assessCoverage, assessQualifiedCoverage, VERDICT } from './coverage.js';
import { assessAnalysis } from './analysis.js';
import { extractPainPoints } from './extract.js';
import { clusterMentions } from './cluster.js';
import { groupByTheme } from './theme.js';
import { buildEngagementIndex, describeEngagement } from './engagement.js';
import { scoreCluster, rankClusters } from './score.js';
import { frameOpportunities } from './frame.js';
import { isInWindow } from './normalize.js';
import {
  WINDOW_DAYS,
  WEIGHTS,
  OPPORTUNITY_FLOOR,
  SOURCE_NAMES,
  MAX_UNREAD_FOR_NEGATIVE_VERDICT,
} from './config.js';

/**
 * @param {string} market
 * @param {(event: object) => void} emit progress callback
 */
export async function runPipeline(market, emit = () => {}) {
  const startedAt = Date.now();

  // Which communities to search. The model only proposes names; each one is
  // probed against the live archive and dropped unless it actually exists and
  // actually posted in the window.
  emit({ stage: 'communities', status: 'start', message: 'Finding where this market talks' });
  const { subreddits, stats: subredditStats } = await resolveSubreddits(
    market,
    (name) => probeSubreddit(name),
    { onProgress: ({ probing }) => emit({ stage: 'communities', status: 'progress', probing }) },
  );
  emit({
    stage: 'communities',
    status: 'done',
    subreddits,
    proposed: subredditStats.proposed,
    rejected: subredditStats.rejected,
    failed: subredditStats.failed,
  });

  emit({ stage: 'collect', status: 'start', message: 'Searching Reddit, Hacker News, and GitHub' });
  const results = await Promise.all([
    collectHackerNews(market),
    collectGitHub(market),
    collectReddit(market),
    collectRedditArchive(market, subreddits),
  ]);

  for (const result of results) {
    emit({
      stage: 'collect',
      status: 'source',
      source: result.source,
      label: SOURCE_NAMES[result.source],
      state: result.state,
      count: result.items.length,
      error: result.error,
    });
  }

  const allItems = results.flatMap((result) => result.items);
  emit({ stage: 'collect', status: 'done', count: allItems.length });

  emit({ stage: 'dedupe', status: 'start', message: 'Collapsing duplicate and copied discussions' });
  const { items, stats: dedupeStats } = dedupe(allItems);
  const unique = uniqueItems(items).filter((item) => isInWindow(item, WINDOW_DAYS));
  emit({ stage: 'dedupe', status: 'done', ...dedupeStats });

  // Coverage is judged on what survived dedup and the date window, so a market
  // that looks busy only because of reposts is correctly judged thin.
  // Stage A — retrieval. This is only "did anything come back at all", and it
  // exists to stop a hopeless run before it spends money on the LLM stages. It
  // is deliberately NOT the reported verdict: counting keyword matches is what
  // made a trucking run with zero customer evidence look adequate.
  const keptIds = new Set(unique.map((item) => item.id));
  const retrieval = assessCoverage(
    results.map((result) => ({
      ...result,
      items: result.items.filter((item) => keptIds.has(item.id)),
    })),
  );
  emit({ stage: 'coverage', status: 'done', retrieval });

  const engagementIndex = buildEngagementIndex(unique);

  const baseReport = {
    market,
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    weights: WEIGHTS,
    floor: OPPORTUNITY_FLOOR,
    retrieval,
    subreddits,
    subredditStats,
    dedupeStats,
    engagement: engagementIndex.perSource,
    evidence: items.map((item) => ({
      ...item,
      inWindow: isInWindow(item, WINDOW_DAYS),
      engagementText: describeEngagement(item, engagementIndex).text,
      engagementPercentile: describeEngagement(item, engagementIndex).percentile,
    })),
  };

  // Early stop. Nothing usable came back at all, so there is no point paying
  // for extraction. The reported verdict is still a qualified-evidence verdict —
  // this one just says we never got far enough to compute it.
  if (retrieval.verdict === VERDICT.INSUFFICIENT) {
    emit({ stage: 'halted', status: 'done', reason: 'nothing-retrieved' });
    return {
      ...baseReport,
      analysis: assessAnalysis({ extraction: null, themeStats: null, retrieval }),
      coverage: {
        verdict: VERDICT.INSUFFICIENT,
        statements: 0,
        distinctVoices: 0,
        platforms: [],
        setAsideCount: 0,
        perCategory: {},
        explanation:
          `${retrieval.explanation} Extraction was not run, so there are no ` +
          'verified customer statements to report.',
      },
      halted: true,
      haltReason: 'nothing-retrieved',
      opportunities: [],
      weakSignals: [],
      extraction: null,
      setAside: [],
      elapsedMs: Date.now() - startedAt,
    };
  }

  emit({ stage: 'extract', status: 'start', message: 'Reading posts for described problems' });
  const { mentions, setAside, stats: extractStats } = await extractPainPoints(market, unique, {
    onProgress: ({ batch, of }) =>
      emit({ stage: 'extract', status: 'progress', batch, of }),
  });
  emit({ stage: 'extract', status: 'done', ...extractStats });

  // Every batch failed: the discussions were collected but never read. Saying
  // "insufficient customer evidence" here would be a claim about the market
  // that this run did not earn.
  const extractionFailed =
    extractStats.batches > 0 && extractStats.failedBatches >= extractStats.batches;

  /** The share of collected discussions this run never managed to read. */
  const unreadFraction =
    extractStats.batches > 0 ? extractStats.failedBatches / extractStats.batches : 0;

  if (extractionFailed) {
    const analysis = assessAnalysis({ extraction: extractStats, themeStats: null, retrieval });
    emit({ stage: 'halted', status: 'done', reason: 'analysis-failed', analysis });
    return {
      ...baseReport,
      analysis,
      coverage: {
        verdict: VERDICT.UNKNOWN,
        statements: null,
        distinctVoices: null,
        platforms: [],
        setAsideCount: 0,
        perCategory: {},
        explanation: analysis.explanation,
      },
      halted: true,
      haltReason: 'analysis-failed',
      opportunities: [],
      weakSignals: [],
      extraction: extractStats,
      setAside,
      elapsedMs: Date.now() - startedAt,
    };
  }

  // Stage B — the verdict we actually report, computed from verified customer
  // statements rather than from how many items matched a keyword.
  const coverage = assessQualifiedCoverage(mentions, setAside, retrieval);
  emit({ stage: 'coverage', status: 'qualified', coverage });

  if (coverage.verdict === VERDICT.INSUFFICIENT) {
    const analysis = assessAnalysis({ extraction: extractStats, themeStats: null, retrieval });

    // Too much went unread for "insufficient" to be a finding rather than a
    // gap. Report the absence of a measurement instead of a measurement.
    if (unreadFraction > MAX_UNREAD_FOR_NEGATIVE_VERDICT) {
      emit({ stage: 'halted', status: 'done', reason: 'analysis-failed', analysis });
      return {
        ...baseReport,
        analysis,
        coverage: {
          ...coverage,
          verdict: VERDICT.UNKNOWN,
          explanation:
            `${analysis.explanation} The ${coverage.statements} statement(s) found so far ` +
            'are real, but too little of the evidence was read to say whether this market ' +
            'has enough to rank.',
        },
        halted: true,
        haltReason: 'analysis-failed',
        opportunities: [],
        weakSignals: [],
        extraction: extractStats,
        setAside,
        elapsedMs: Date.now() - startedAt,
      };
    }

    emit({ stage: 'halted', status: 'done', reason: 'insufficient-customer-evidence', analysis });
    return {
      ...baseReport,
      analysis,
      coverage,
      halted: true,
      haltReason: 'insufficient-customer-evidence',
      opportunities: [],
      weakSignals: [],
      extraction: extractStats,
      setAside,
      elapsedMs: Date.now() - startedAt,
    };
  }

  emit({ stage: 'cluster', status: 'start', message: 'Grouping recurring problems' });
  const lexical = clusterMentions(mentions);
  // Lexical grouping catches near-identical phrasings; the theme pass catches
  // the same complaint said in different words. See lib/theme.js for why this
  // stage is not purely deterministic.
  const { clusters, stats: themeStats } = await groupByTheme(lexical);
  emit({
    stage: 'cluster',
    status: 'done',
    count: clusters.length,
    lexicalGroups: lexical.length,
    themeMerged: themeStats.merged,
    themeFailed: themeStats.failed,
  });

  emit({ stage: 'score', status: 'start', message: 'Scoring evidence strength' });
  const scored = clusters.map((cluster) => scoreCluster(cluster, engagementIndex));
  const qualifying = rankClusters(scored.filter((cluster) => cluster.qualifies));
  const weakSignals = scored
    .filter((cluster) => !cluster.qualifies)
    .sort((a, b) => b.distinctVoices - a.distinctVoices);
  emit({
    stage: 'score',
    status: 'done',
    qualifying: qualifying.length,
    weak: weakSignals.length,
  });

  let opportunities = [];
  if (qualifying.length > 0) {
    emit({ stage: 'frame', status: 'start', message: 'Describing what the evidence points to' });
    opportunities = await frameOpportunities(market, qualifying, {
      onProgress: ({ done, of }) => emit({ stage: 'frame', status: 'progress', done, of }),
    });
    emit({ stage: 'frame', status: 'done', count: opportunities.length });
  }

  return {
    ...baseReport,
    halted: false,
    haltReason: null,
    analysis: assessAnalysis({ extraction: extractStats, themeStats, retrieval }),
    coverage,
    extraction: extractStats,
    setAside,
    themeStats,
    opportunities,
    weakSignals,
    elapsedMs: Date.now() - startedAt,
  };
}
