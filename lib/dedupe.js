/**
 * Deduplication, so copied or repeated discussions cannot inflate the evidence.
 *
 * Four layers, cheapest first. Duplicates are never deleted — they are marked
 * with `duplicateOf` and a human-readable reason, kept in the record, and shown
 * collapsed in the UI. They contribute nothing to scoring.
 *
 * Deduplication alone is not enough to stop inflation, and this module does not
 * pretend otherwise: the scoring stage separately counts distinct voices rather
 * than mentions, and caps how much any single thread can contribute.
 */

import { prepare, preparedSimilarity, longestSharedWordRun } from './similarity.js';
import { SIMILARITY } from './config.js';

/**
 * The text that identifies an item for comparison purposes.
 *
 * A comment is identified by what it says, not by the headline it sits under.
 * Every comment on a thread inherits its parent's title for display context, so
 * including that title here would make all siblings look like copies of each
 * other — which briefly happened, and silently deleted eight distinct
 * complaints from a single Reddit thread.
 */
function dedupeText(item) {
  if (item.kind === 'comment') return item.body || item.title || '';
  return [item.title, item.body].filter(Boolean).join('\n\n');
}

/**
 * Items are compared in a stable order — oldest first, then by descending
 * engagement — so the *original* survives and the later copy is the one marked
 * derivative. Ties break on id to keep runs reproducible.
 */
function canonicalOrder(a, b) {
  const dateA = a.publishedAt || '9999-12-31';
  const dateB = b.publishedAt || '9999-12-31';
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  if (b.engagement.primary !== a.engagement.primary) {
    return b.engagement.primary - a.engagement.primary;
  }
  return a.id < b.id ? -1 : 1;
}

/**
 * @param {Array} items evidence records
 * @returns {{items: Array, stats: object}} same items, with duplicates marked
 */
export function dedupe(items) {
  const ordered = [...items].sort(canonicalOrder);

  const byUrl = new Map();
  const kept = [];
  const preparedById = new Map();
  const stats = { url: 0, nearDuplicate: 0, crosspost: 0, syndication: 0 };

  for (const item of ordered) {
    item.duplicateOf = null;
    item.dedupeReason = null;

    // Layer 1 — same canonical URL. Cheapest and most certain.
    if (item.url && byUrl.has(item.url)) {
      const original = byUrl.get(item.url);
      item.duplicateOf = original.id;
      item.dedupeReason = 'Same URL as an item already collected';
      stats.url += 1;
      continue;
    }

    const text = dedupeText(item);
    if (!text) {
      if (item.url) byUrl.set(item.url, item);
      kept.push(item);
      continue;
    }

    const prepared = prepare(text);
    let matched = null;

    for (const candidate of kept) {
      const candidatePrepared = preparedById.get(candidate.id);
      if (!candidatePrepared) continue;
      // People inside one thread quote each other and echo the post's wording.
      // Those are different people corroborating, not copies, so fuzzy matching
      // is confined to comparisons *across* threads. One person repeating
      // themselves is already neutralized downstream, where scoring counts
      // distinct voices rather than mentions.
      if (candidate.threadId === item.threadId) continue;

      const score = preparedSimilarity(prepared, candidatePrepared);

      // Layer 3 — near-identical text, regardless of who posted it.
      if (score >= SIMILARITY.nearDuplicate) {
        matched = {
          original: candidate,
          reason: `Near-identical text (${score.toFixed(2)} similarity) to an earlier item`,
          kind: 'nearDuplicate',
        };
        break;
      }

      // Layer 4a — the same person saying the same thing somewhere else.
      const sameAuthor =
        item.author && candidate.author &&
        item.author.toLowerCase() === candidate.author.toLowerCase();
      const differentContainer = item.container !== candidate.container;
      if (sameAuthor && differentContainer && score >= SIMILARITY.crosspost) {
        matched = {
          original: candidate,
          reason:
            `Crosspost: same author (${item.author}) posted ` +
            `${score.toFixed(2)}-similar text in ${candidate.container}`,
          kind: 'crosspost',
        };
        break;
      }
    }

    // Layer 4b — syndication. A long verbatim passage shared with an earlier
    // item means one copied the other, even when the surrounding text differs.
    if (!matched && text.length >= 200) {
      for (const candidate of kept) {
        // People quote the post they are replying to. Within one thread that is
        // conversation, not syndication, so only compare across threads.
        if (candidate.threadId === item.threadId) continue;
        const otherText = dedupeText(candidate);
        if (otherText.length < 200) continue;
        const run = longestSharedWordRun(text, otherText);
        if (run >= SIMILARITY.verbatimRunWords) {
          matched = {
            original: candidate,
            reason: `Shares a ${run}-word verbatim passage with an earlier item`,
            kind: 'syndication',
          };
          break;
        }
      }
    }

    if (matched) {
      item.duplicateOf = matched.original.id;
      item.dedupeReason = matched.reason;
      stats[matched.kind] += 1;
      continue;
    }

    if (item.url) byUrl.set(item.url, item);
    preparedById.set(item.id, prepared);
    kept.push(item);
  }

  return {
    items: ordered,
    stats: {
      ...stats,
      total: items.length,
      unique: kept.length,
      duplicates: items.length - kept.length,
    },
  };
}

/** Items that count toward evidence. Duplicates are excluded from all scoring. */
export function uniqueItems(items) {
  return items.filter((item) => !item.duplicateOf);
}
