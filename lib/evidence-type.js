/**
 * Evidence categories, and the weak signals that hint at them.
 *
 * The verbatim gate proves a quote is authentic. It never proved the speaker was
 * a customer or that the sentence described a problem. A trucking run turned the
 * news headline fragment "So Is a Truck" into the pain point "Startup lacks
 * operational vehicles", and turned a developer's own acceptance criteria
 * ("Add client-side anti-spam controls") into a customer complaint. Both quotes
 * were perfectly real.
 *
 * So classification is a separate question from authenticity, and it is asked
 * separately.
 *
 * IMPORTANT: nothing in this module rejects anything on its own. The patterns
 * here produce *signals* that are shown to the classifier and recorded for
 * audit. They are not rules. A real customer can write "Fix your billing page",
 * and a real complaint need not say "I" — deleting on those grounds would throw
 * away exactly the evidence we are trying to find.
 */

/** Only the first two count toward clustering, scoring, and ranking. */
export const CATEGORY = {
  FIRST_HAND: 'first_hand_problem',
  REPORTED: 'reported_problem',
  PROPOSED_SOLUTION: 'proposed_solution',
  PROMOTIONAL: 'promotional',
  INCIDENTAL: 'incidental',
};

export const COUNTING_CATEGORIES = new Set([CATEGORY.FIRST_HAND, CATEGORY.REPORTED]);

export const CATEGORY_LABELS = {
  [CATEGORY.FIRST_HAND]: 'First-hand problem',
  [CATEGORY.REPORTED]: 'Directly reported problem',
  [CATEGORY.PROPOSED_SOLUTION]: 'Proposed solution',
  [CATEGORY.PROMOTIONAL]: 'Promotional',
  [CATEGORY.INCIDENTAL]: 'Incidental mention',
};

export const ALL_CATEGORIES = Object.values(CATEGORY);

export function countsAsEvidence(category) {
  return COUNTING_CATEGORIES.has(category);
}

const IMPERATIVE_OPENERS = /^(add|replace|move|prevent|make|implement|create|build|support|enable|introduce|refactor|update|allow|remove|migrate|ensure|expose|handle|fix)\b/i;
const PROMO_TITLE = /^(show hn|launch hn|tool submission|discovered:|\[?feature\]?:|feat:|chore:|docs:|refactor:|release |introducing |announcing )/i;
const CONVENTIONAL_COMMIT = /^(feat|fix|chore|docs|refactor|test|build|ci|perf)(\([^)]*\))?!?:/i;
const FIRST_PERSON = /\b(i|i'm|im|i've|my|we|we're|our|us|me)\b/i;

/**
 * Non-binding hints about what an item probably is.
 *
 * Returned as plain strings so they can be shown to the classifier, stored on
 * the mention, and displayed in the audit view. Their presence never decides
 * anything by itself.
 */
export function evidenceSignals(item, quote = '') {
  const signals = [];
  const title = item.title || '';
  const text = `${title}\n${item.body || ''}`;

  if (PROMO_TITLE.test(title.trim()) || CONVENTIONAL_COMMIT.test(title.trim())) {
    signals.push('title looks like a submission, announcement, or commit message');
  }
  if (quote && IMPERATIVE_OPENERS.test(quote.trim())) {
    signals.push('quote opens with an instruction, which often means a proposed fix');
  }
  if (item.source === 'github' && item.authorOwnsContainer) {
    signals.push('issue author owns the repository, so this may be their own backlog');
  }
  if (!FIRST_PERSON.test(text)) {
    signals.push('no first-person language anywhere in the item');
  }
  // "So Is a Truck" — a headline fragment with no clause of its own.
  if (quote && quote.trim().split(/\s+/).length <= 6 && !/[.?!]$/.test(quote.trim())) {
    signals.push('quote is a short fragment rather than a complete statement');
  }
  if (item.kind === 'issue' && /^\W*(\[|#)?\s*(feature|enhancement)\b/i.test(title)) {
    signals.push('titled as a feature or enhancement request');
  }

  return signals;
}

/** Normalizes whatever the model returned into a known category. */
export function normalizeCategory(raw) {
  const value = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ALL_CATEGORIES.includes(value) ? value : null;
}
