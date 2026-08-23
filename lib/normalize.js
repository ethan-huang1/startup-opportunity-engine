/**
 * One evidence shape for every source.
 *
 * Collectors call `makeEvidence` so that downstream stages never need to know
 * which platform an item came from — except where that difference is real, like
 * engagement units, which are deliberately kept per-source and never mixed.
 */

/**
 * Identity of the *person* behind an item, used to count distinct voices.
 *
 * One person complaining five times is one voice, not five. Where a source
 * gives us no author (Reddit's keyless lanes often omit it on posts), we fall
 * back to the item's own URL so it counts as exactly one voice rather than
 * silently merging with every other authorless item.
 */
function deriveVoiceId(source, author, url) {
  if (author && author !== '[deleted]' && author !== '[removed]') {
    return `${source}:user:${author.toLowerCase()}`;
  }
  return `${source}:item:${url}`;
}

/** Strips tracking params and host variations so the same page compares equal. */
export function canonicalUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|source$|si$|share)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hostname = url.hostname.replace(/^(www\.|m\.|old\.|new\.)/, '');
    url.pathname = url.pathname.replace(/\/amp\/?$/, '/').replace(/\/+$/, '') || '/';
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

/** ISO date (YYYY-MM-DD) from anything the sources hand us, or null. */
export function toIsoDate(value) {
  if (!value) return null;
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Builds one evidence record.
 *
 * `body` is stored in full and never truncated: the extraction stage verifies
 * that quotes appear verbatim in this text, so trimming it here would cause
 * legitimate quotes to be rejected.
 */
export function makeEvidence({
  id,
  source,
  kind,
  title = '',
  body = '',
  url,
  author = null,
  container = null,
  publishedAt = null,
  dateConfidence = 'low',
  primary = 0,
  comments = 0,
  engagementAvailable = true,
  parentId = null,
  threadId = null,
  authorOwnsContainer = false,
}) {
  const canonical = canonicalUrl(url);
  return {
    id,
    source,
    kind,
    title: (title || '').trim(),
    body: (body || '').trim(),
    url: canonical,
    author,
    voiceId: deriveVoiceId(source, author, canonical),
    container,
    publishedAt,
    dateConfidence,
    engagement: {
      primary: Number(primary) || 0,
      comments: Number(comments) || 0,
      // False when the platform does not publish this counter at all, which is
      // different from a real score that happens to be zero. Hacker News hides
      // comment points, and reporting "0 points, 81st percentile" for those
      // implied a popularity we never measured.
      available: engagementAvailable,
    },
    parentId,
    // Recorded as an evidence-quality *signal*, never as grounds for deletion:
    // a maintainer filing an issue on their own repo is often writing their own
    // backlog, but is also how real user reports get relayed.
    authorOwnsContainer,
    // Root discussion this belongs to. Used to cap how much a single viral
    // thread can contribute to an opportunity's score.
    threadId: threadId || id,
    duplicateOf: null,
    dedupeReason: null,
  };
}

/** Full searchable text of an item. */
export function evidenceText(item) {
  return [item.title, item.body].filter(Boolean).join('\n\n');
}

/** True when the item's date falls inside the research window. */
export function isInWindow(item, windowDays) {
  if (!item.publishedAt) return false;
  const ageMs = Date.now() - new Date(item.publishedAt).getTime();
  return ageMs >= 0 && ageMs <= windowDays * 86400000;
}

/** Decodes HTML entities, including numeric ones. */
export function decodeEntities(text) {
  if (!text) return '';
  const named = {
    quot: '"', apos: "'", amp: '&', lt: '<', gt: '>', nbsp: ' ', hellip: '…',
    mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

const QUERY_STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'and', 'with', 'from', 'by',
  'at', 'is', 'are', 'my', 'our', 'how', 'what', 'best', 'app', 'apps', 'tool',
  'tools', 'software', 'platform', 'service', 'company', 'companies',
]);

/** Significant words from a query: lowercased, de-duplicated, stopwords removed. */
export function queryTokens(query) {
  const words = (query || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !QUERY_STOPWORDS.has(word));
  return [...new Set(words)];
}

/**
 * Strips a common inflectional ending so related word forms compare equal.
 *
 * Deliberately crude. Without it, the query "trucking" did not match the words
 * "truck" or "trucks", and a Reddit collector that had genuinely returned 12
 * items had every one of them silently discarded — the source was then reported
 * as having found nothing.
 */
export function stem(word) {
  if (word.length <= 4) return word;
  return word
    .replace(/ies$/, 'y')
    .replace(/(ing|ed|es|s)$/, '');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a query word and its common inflections at a word boundary, so
 * "truck" finds trucking / trucks / trucker but not "truckload-only" noise
 * inside unrelated words.
 */
function tokenPattern(token) {
  // The optional leading `e` restores what stemming removed: "taking" reduces
  // to "tak", which must still match "take". Without it, a query for "note
  // taking apps" missed a post saying "I take notes daily".
  return new RegExp(`\\b${escapeRegex(stem(token))}(e|es|ed|er|ers|ing|s)?\\b`, 'gi');
}

/**
 * Deterministic relevance floor.
 *
 * Keyword search returns plenty of items that merely mention a word — HN's
 * "Who wants to be hired" threads match almost anything, and GitHub happily
 * returns an icon-loading bug for "note taking app" because the body contains
 * the word "note". The rule: at least two of the query's meaningful words must
 * appear, or the only one if the query has just one. Simple enough to state to
 * the user, and it removes most of the noise before it reaches the AI.
 */
export function matchesQuery(item, query) {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return true;

  const haystack = `${item.title} ${item.body} ${item.container || ''}`.toLowerCase();

  // Single meaningful word: presence is all we can ask for.
  if (tokens.length === 1) return tokenPattern(tokens[0]).test(haystack);

  // Multi-word queries need the words to appear *near each other*. Requiring
  // mere presence let a headless-Chrome scraping issue through for "note
  // taking apps", because the body happened to contain "note" and "taking"
  // paragraphs apart. Co-occurrence within a short window is a much better
  // proxy for the item actually being about the topic, and is still a rule we
  // can state plainly to the user.
  // Roughly a sentence or two. Narrower (60 chars) rejected legitimate posts
  // that simply phrase the topic differently — "best app for my notes" — and
  // cost Reddit five sixths of its results. Wider than a paragraph stops
  // filtering anything at all.
  const WINDOW = 200;
  const positions = [];
  for (const token of tokens) {
    const pattern = tokenPattern(token);
    let match = pattern.exec(haystack);
    while (match !== null) {
      positions.push({ token, index: match.index });
      match = pattern.exec(haystack);
    }
  }
  positions.sort((a, b) => a.index - b.index);

  for (let i = 0; i < positions.length; i += 1) {
    const nearby = new Set([positions[i].token]);
    for (let j = i + 1; j < positions.length; j += 1) {
      if (positions[j].index - positions[i].index > WINDOW) break;
      nearby.add(positions[j].token);
      if (nearby.size >= 2) return true;
    }
  }
  return false;
}
