/**
 * Text similarity, used by both deduplication and clustering.
 *
 * Deliberately not embeddings. This needs no API key, is fully deterministic,
 * and every decision it makes is a number we can show the user — "these were
 * grouped because they are 0.62 similar" is auditable in a way that a vector
 * distance from a hosted model is not.
 *
 * The approach mirrors last30days' dedupe.py: take the stronger of character
 * 3-gram overlap and word overlap. Character n-grams catch small edits and
 * typos; word overlap catches reordering and padding. Using the max means an
 * item only has to look like a duplicate one way to be treated as one.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'how', 'is', 'in', 'of', 'on', 'and', 'with',
  'from', 'by', 'at', 'this', 'that', 'it', 'what', 'are', 'do', 'can', 'i',
  'my', 'we', 'you', 'be', 'have', 'has', 'was', 'but', 'not', 'or', 'as',
  'if', 'so', 'they', 'their', 'there', 'been', 'would', 'could', 'should',
]);

export function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function charNgrams(normalized, n = 3) {
  if (normalized.length < n) return new Set(normalized ? [normalized] : []);
  const grams = new Set();
  for (let i = 0; i <= normalized.length - n; i += 1) {
    grams.add(normalized.slice(i, i + n));
  }
  return grams;
}

function contentWords(normalized) {
  return new Set(
    normalized.split(' ').filter((word) => word.length > 1 && !STOPWORDS.has(word)),
  );
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) {
    if (large.has(value)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Precomputes both representations once. Comparing n items pairwise would
 * otherwise re-tokenize the same strings thousands of times.
 */
export function prepare(text) {
  const normalized = normalizeText(text);
  return { ngrams: charNgrams(normalized), words: contentWords(normalized), normalized };
}

export function preparedSimilarity(a, b) {
  return Math.max(jaccard(a.ngrams, b.ngrams), jaccard(a.words, b.words));
}

export function similarity(textA, textB) {
  return preparedSimilarity(prepare(textA), prepare(textB));
}

/**
 * Longest run of consecutive shared words between two texts.
 *
 * This is what catches syndication: a blog that reposts a Reddit thread will
 * share a long verbatim passage even when overall Jaccard stays low because the
 * copy is wrapped in new framing.
 */
export function longestSharedWordRun(textA, textB) {
  const a = normalizeText(textA).split(' ').filter(Boolean);
  const b = normalizeText(textB).split(' ').filter(Boolean);
  if (a.length === 0 || b.length === 0) return 0;

  // Rolling single-row LCS-suffix table: O(a*b) time, O(b) memory.
  let previous = new Uint32Array(b.length + 1);
  let best = 0;

  for (let i = 1; i <= a.length; i += 1) {
    const current = new Uint32Array(b.length + 1);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}
