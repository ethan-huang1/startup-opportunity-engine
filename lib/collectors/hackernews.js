/**
 * Hacker News via the Algolia API. Free, no key, no auth.
 *
 * We search stories *and* comments separately. Comments matter more here: a
 * story title rarely states a problem, but the thread under it is full of
 * people describing what does not work for them.
 */

import { getJson, runCollector } from '../http.js';
import { makeEvidence, toIsoDate, decodeEntities, matchesQuery } from '../normalize.js';
import { WINDOW_DAYS } from '../config.js';

const SEARCH_URL = 'https://hn.algolia.com/api/v1/search';

/** Algolia rejects long boolean-ish queries; keep it to plain words. */
function flattenQuery(query) {
  return query.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function windowStartSeconds(windowDays) {
  return Math.floor((Date.now() - windowDays * 86400000) / 1000);
}

/** Algolia returns comment text as HTML; the extraction gate needs plain text. */
function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(
    html.replace(/<\/?(p|br|li)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function search(query, tags, windowDays, hitsPerPage) {
  const params = new URLSearchParams({
    query: flattenQuery(query),
    tags,
    numericFilters: `created_at_i>=${windowStartSeconds(windowDays)}`,
    hitsPerPage: String(hitsPerPage),
  });
  const data = await getJson(`${SEARCH_URL}?${params}`);
  return data.hits || [];
}

/**
 * @param {string} query market or customer group
 * @param {{windowDays?: number, limit?: number}} options
 */
export async function collectHackerNews(query, { windowDays = WINDOW_DAYS, limit = 100 } = {}) {
  return runCollector('hackernews', async () => {
    const [stories, comments] = await Promise.all([
      search(query, 'story', windowDays, limit),
      search(query, 'comment', windowDays, limit),
    ]);

    const items = [];

    for (const hit of stories) {
      const text = stripHtml(hit.story_text);
      items.push(
        makeEvidence({
          id: `hn:story:${hit.objectID}`,
          source: 'hackernews',
          kind: 'post',
          title: hit.title || '',
          // Link submissions have no body of their own; the title is the claim.
          body: text || '',
          url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          author: hit.author || null,
          container: 'news.ycombinator.com',
          publishedAt: toIsoDate(hit.created_at),
          dateConfidence: 'high',
          primary: hit.points || 0,
          comments: hit.num_comments || 0,
          threadId: `hn:story:${hit.objectID}`,
        }),
      );
    }

    for (const hit of comments) {
      const text = stripHtml(hit.comment_text);
      if (!text) continue;
      const storyId = hit.story_id ? `hn:story:${hit.story_id}` : `hn:comment:${hit.objectID}`;
      items.push(
        makeEvidence({
          id: `hn:comment:${hit.objectID}`,
          source: 'hackernews',
          kind: 'comment',
          title: hit.story_title || '',
          body: text,
          url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          author: hit.author || null,
          container: 'news.ycombinator.com',
          publishedAt: toIsoDate(hit.created_at),
          dateConfidence: 'high',
          // HN does not publish comment points, so there is no counter to
          // report. Flagged unavailable rather than zero so it is excluded
          // from percentiles instead of ranked against real scores.
          primary: 0,
          comments: 0,
          engagementAvailable: false,
          parentId: storyId,
          threadId: storyId,
        }),
      );
    }

    return items.filter((item) => matchesQuery(item, query));
  });
}
