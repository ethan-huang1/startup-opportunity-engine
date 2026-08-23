/**
 * Engagement normalization — per source, never across sources.
 *
 * A Reddit upvote, a Hacker News point, and a GitHub reaction are different
 * units on wildly different scales: Reddit posts reach thousands, HN posts
 * hundreds, and a GitHub issue with 12 reactions is genuinely popular. Adding
 * them together produces a number that means nothing, so this module never
 * does. Instead each item is ranked against *its own source's* distribution for
 * this run, and the result is a percentile, which is scale-free and needs no
 * magic constants.
 *
 * The honest limitation: a percentile is relative to what this run collected,
 * not to the platform as a whole. With too few items from a source the ranking
 * is noise, so below a floor we skip normalization and say so rather than
 * publishing a confident-looking number.
 */

import { MIN_ITEMS_FOR_PERCENTILE, ENGAGEMENT_LABELS, SOURCE_NAMES } from './config.js';

const NEUTRAL = 0.5;

/**
 * Builds per-source percentile lookups.
 *
 * @param {Array} items unique evidence records
 * @returns {{percentileFor: Function, perSource: object}}
 */
export function buildEngagementIndex(items) {
  const bySource = new Map();
  for (const item of items) {
    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source).push(item);
  }

  const perSource = {};
  const lookup = new Map();

  for (const [source, sourceItems] of bySource) {
    // Items whose platform never published a counter are excluded from the
    // distribution entirely. Treating them as zeros would both drag the
    // distribution down and hand them a percentile that implies we measured
    // something. They get `null` instead, and the UI says so.
    const scorable = sourceItems.filter((item) => item.engagement.available);
    const values = scorable
      .map((item) => item.engagement.primary)
      .sort((a, b) => a - b);

    const normalized = values.length >= MIN_ITEMS_FOR_PERCENTILE;

    perSource[source] = {
      source,
      label: ENGAGEMENT_LABELS[source] || 'engagement',
      count: values.length,
      unscorable: sourceItems.length - scorable.length,
      normalized,
      min: values[0] ?? 0,
      max: values[values.length - 1] ?? 0,
      median: values.length ? values[Math.floor(values.length / 2)] : 0,
      note: normalized
        ? `Percentiles computed within the ${values.length} ${source} items collected in this run.`
        : `Only ${values.length} ${source} items — too few for a meaningful percentile, ` +
          'so these are treated as neutral rather than ranked.',
    };

    for (const item of sourceItems) {
      if (!item.engagement.available) {
        lookup.set(item.id, null);
      } else {
        lookup.set(
          item.id,
          normalized ? percentileOf(item.engagement.primary, values) : NEUTRAL,
        );
      }
    }
  }

  return {
    perSource,
    /** 0..1 rank within this item's own source, or null when unmeasurable. */
    percentileFor(itemId) {
      const value = lookup.get(itemId);
      return value === undefined ? NEUTRAL : value;
    },
  };
}

/**
 * Fraction of values at or below `value`. Ties share the same percentile, so a
 * run where everything scored zero yields 1.0 for all of them rather than an
 * arbitrary ordering.
 */
function percentileOf(value, sortedValues) {
  if (sortedValues.length === 0) return NEUTRAL;
  let atOrBelow = 0;
  for (const candidate of sortedValues) {
    if (candidate <= value) atOrBelow += 1;
    else break;
  }
  return atOrBelow / sortedValues.length;
}

/** Human-readable engagement for display. Never combined across sources. */
export function describeEngagement(item, index) {
  const meta = index.perSource[item.source];
  const label = ENGAGEMENT_LABELS[item.source] || 'engagement';

  if (!item.engagement.available) {
    // The source name is already shown beside this line in the UI, so repeating
    // it here read as "Reddit communities · r/Truckers · Reddit communities
    // does not publish upvotes".
    return {
      native: null,
      percentile: null,
      text: `no ${label} published for this item`,
    };
  }

  const native = `${item.engagement.primary} ${label}`;
  if (!meta?.normalized) return { native, percentile: null, text: native };

  const percentile = index.percentileFor(item.id);
  return {
    native,
    percentile,
    text: `${native} · ${Math.round(percentile * 100)}th percentile of ${item.source} items in this run`,
  };
}
