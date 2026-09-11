/**
 * Every tunable number in the pipeline lives here, in one place, so the values
 * that shape results are easy to find, read, and argue with.
 *
 * These are judgment calls, not science. The UI shows them to the user.
 */

import { existsSync, globSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WINDOW_DAYS = 30;

/**
 * Where the last30days plugin lives. Reddit collection shells out to it.
 *
 * This used to be a hard-coded path containing both a username and a pinned
 * version, so it broke on any other machine and on every plugin update.
 * Resolution order: LAST30DAYS_SCRIPT env var, then the newest version in
 * the local plugin cache. Returns null when the plugin is not installed —
 * the Reddit collector reports that as a failed source rather than
 * pretending Reddit had nothing to say (see lib/collectors/reddit.js).
 */
export function resolveLast30DaysScript({
  env = process.env.LAST30DAYS_SCRIPT,
  home = homedir(),
} = {}) {
  if (env) return existsSync(env) ? env : null;

  const versions = globSync(
    'last30days/*/skills/last30days/scripts/last30days.py',
    { cwd: join(home, '.claude/plugins/cache/last30days-skill') },
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const newest = versions.at(-1);
  return newest ? join(home, '.claude/plugins/cache/last30days-skill', newest) : null;
}

/**
 * Stage 0 coverage thresholds.
 *
 * Reddit, Hacker News, and GitHub skew heavily toward developers and early
 * adopters. For traditional markets they return little or nothing, and forcing
 * opportunities out of a handful of tangential posts would produce confident
 * nonsense. These cutoffs decide when we refuse to continue.
 */
export const COVERAGE = {
  adequateMinItems: 40,
  insufficientMaxItems: 15,
  minSourcesForAdequate: 2,
};

/**
 * The verdict that actually gets reported, measured on *qualified customer
 * evidence* rather than on how many keyword matches came back.
 *
 * A trucking run collected 68 in-window items and was called "adequate". None
 * of the 28 problems it extracted was a trucking customer describing anything —
 * they were developers' own backlogs, headline fragments, and commentary. Item
 * count turned out to say nothing about whether a market is visible to us.
 *
 * These floors are set relative to the opportunity floor below: a run needs
 * materially more than one cluster's worth of corroborated evidence before
 * ranking anything is meaningful. They are judgment calls, shown in the UI
 * next to the real counts so they can be argued with.
 */
export const QUALIFIED_COVERAGE = {
  adequateMinStatements: 15,
  adequateMinVoices: 10,
  insufficientBelowStatements: 8,
  insufficientBelowVoices: 6,
  minPlatforms: 2,
};

/** Text-similarity thresholds. Mirrors the approach used in last30days' dedupe.py. */
export const SIMILARITY = {
  /** Two items are the same discussion at or above this. */
  nearDuplicate: 0.75,
  /** Same author across different containers at or above this is a crosspost. */
  crosspost: 0.6,
  /** Consecutive shared words that indicate one item copied another. */
  verbatimRunWords: 25,
  /** A pain mention joins a cluster at or above this similarity to its leader. */
  clusterJoin: 0.45,
};

/**
 * Evidence Strength weights.
 *
 * IMPORTANT: this is not a prediction of startup success. It measures only how
 * well-supported a pain cluster is by the sources we searched. The weights are
 * an editorial judgment, not a validated model, which is why the UI exposes
 * them as sliders and flags opportunities whose rank depends on them.
 */
export const WEIGHTS = {
  frequency: 0.3,
  reach: 0.25,
  recency: 0.2,
  sourceDiversity: 0.15,
  severity: 0.1,
};

/** Anti-inflation: one loud thread must not be able to manufacture an opportunity. */
export const MENTIONS_PER_THREAD_CAP = 3;

/**
 * Nor may one repository or subreddit.
 *
 * Every GitHub issue is its own thread, so the per-thread cap never engaged
 * against a single project filing many tickets: one hobby repo supplied 10 of
 * the 45 GitHub items in a trucking run. This caps the *container* — a repo or
 * a subreddit — as well as the thread.
 */
export const MENTIONS_PER_CONTAINER_CAP = 4;

/** Frequency saturates here — beyond this many distinct voices, score stops climbing. */
export const FREQUENCY_SATURATION = 12;

/**
 * How much of the evidence a run may fail to read and still be allowed to
 * publish a NEGATIVE verdict about the market.
 *
 * "Insufficient customer evidence" is a finding, not the absence of one, and
 * it can only be earned by actually reading the discussions. A run that lost
 * 14 of its 15 extraction batches to a throttled model and then announced
 * that open-source maintainers have nothing to say made exactly the claim
 * the total-failure guard exists to prevent — it just failed at 93% instead
 * of 100%. Above this fraction the verdict becomes `unknown`.
 *
 * Deliberately one-sided: losing batches can only ever hide evidence, never
 * manufacture it, so a POSITIVE result stands on whatever was read. Only the
 * negative claim needs to have earned it.
 */
export const MAX_UNREAD_FOR_NEGATIVE_VERDICT = 1 / 3;

/** A cluster must clear both of these to be framed as an opportunity. */
export const OPPORTUNITY_FLOOR = {
  minDistinctVoices: 3,
  minSourceTypes: 2,
};

/**
 * Percentile normalization needs a distribution to be meaningful. Below this
 * many items from a source, percentiles are noise, so we skip them and say so.
 */
export const MIN_ITEMS_FOR_PERCENTILE = 10;

/** Native primary engagement counter per source. Never summed across sources. */
export const ENGAGEMENT_LABELS = {
  reddit: 'upvotes',
  'reddit-archive': 'upvotes',
  hackernews: 'points',
  github: 'reactions',
};

// Two collectors read Reddit and are named apart so a run can show which one
// produced what. They remain ONE platform for corroboration — see PLATFORM_OF.
export const SOURCE_NAMES = {
  reddit: 'Reddit search',
  'reddit-archive': 'Reddit communities',
  hackernews: 'Hacker News',
  github: 'GitHub',
};

/**
 * Which independent platform a collector's items belong to.
 *
 * Corroboration is only meaningful across genuinely separate places. Two
 * subreddits are two corners of one platform, not two sources, and the two
 * Reddit collectors (the plugin's undirected search and the arctic-shift
 * subreddit archive) read the same site. Source diversity counts the values
 * here, never collector names and never containers.
 */
export const PLATFORM_OF = {
  reddit: 'reddit',
  'reddit-archive': 'reddit',
  hackernews: 'hackernews',
  github: 'github',
};

/** Models used for the two AI stages, via the local `claude` CLI. */
export const MODELS = {
  extract: 'claude-haiku-4-5-20251001',
  frame: 'claude-sonnet-5',
};
