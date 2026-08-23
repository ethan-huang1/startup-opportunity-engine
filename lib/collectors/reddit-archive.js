/**
 * Reddit via arctic-shift, a public archive — keyless, and targetable by
 * subreddit.
 *
 * This is what reaches non-technical markets. Reddit hosts the trade
 * communities that Hacker News and GitHub do not (r/Truckers, r/HVAC,
 * r/Construction, r/smallbusiness), but the paths to them are poor: Reddit's
 * public .json API is dead, its official API needs OAuth, and its RSS endpoints
 * rate-limit hard — four of five requests returned 429 even spaced three
 * seconds apart. The archive answers reliably and lets us name the community.
 *
 * THE HONEST COST: arctic-shift captures posts at ingest time, before votes
 * accumulate, so every score comes back as 1. Engagement from this source is
 * not a measurement of anything and is marked unavailable — the same treatment
 * Hacker News comment points already get. Reach simply ignores these items
 * rather than ranking them as unpopular.
 */

import { getJson, runCollector, HttpError, STATE } from '../http.js';
import { makeEvidence, toIsoDate, matchesQuery } from '../normalize.js';
import { WINDOW_DAYS } from '../config.js';

const POSTS_URL = 'https://arctic-shift.photon-reddit.com/api/posts/search';
const COMMENTS_URL = 'https://arctic-shift.photon-reddit.com/api/comments/search';

/** Bodies the archive kept but Reddit no longer shows. */
const UNUSABLE_BODY = /^\s*(\[removed\]|\[deleted\]|\[ removed by moderator \])\s*$/i;

function windowStart(windowDays) {
  return new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
}

function permalink(value) {
  if (!value) return '';
  return value.startsWith('http') ? value : `https://www.reddit.com${value}`;
}

async function fetchSubreddit(url, subreddit, windowDays, limit) {
  const params = new URLSearchParams({
    subreddit,
    after: windowStart(windowDays),
    limit: String(limit),
    sort: 'desc',
  });
  const data = await getJson(`${url}?${params}`, { timeoutMs: 25000 });
  return data?.data || [];
}

function postToEvidence(post) {
  const body = post.selftext || '';
  const threadId = `reddit:post:${post.id}`;
  return makeEvidence({
    id: threadId,
    source: 'reddit-archive',
    kind: 'post',
    title: post.title || '',
    body: UNUSABLE_BODY.test(body) ? '' : body,
    url: permalink(post.permalink || post.url),
    author: post.author && post.author !== '[deleted]' ? post.author : null,
    container: post.subreddit ? `r/${post.subreddit}` : null,
    publishedAt: toIsoDate(post.created_utc),
    dateConfidence: 'high',
    primary: 0,
    comments: 0,
    // Archive scores are captured before voting settles; every one is 1.
    engagementAvailable: false,
    threadId,
  });
}

function commentToEvidence(comment) {
  const body = comment.body || '';
  if (UNUSABLE_BODY.test(body)) return null;
  const threadId = comment.link_id
    ? `reddit:post:${String(comment.link_id).replace(/^t3_/, '')}`
    : `reddit:comment:${comment.id}`;
  return makeEvidence({
    id: `reddit:comment:${comment.id}`,
    source: 'reddit-archive',
    kind: 'comment',
    title: comment.link_title || '',
    body,
    url: permalink(comment.permalink),
    author: comment.author && comment.author !== '[deleted]' ? comment.author : null,
    container: comment.subreddit ? `r/${comment.subreddit}` : null,
    publishedAt: toIsoDate(comment.created_utc),
    dateConfidence: 'high',
    primary: 0,
    comments: 0,
    engagementAvailable: false,
    parentId: threadId,
    threadId,
  });
}

/**
 * Counts in-window items for one subreddit. Used to validate a suggested
 * community before committing to it.
 */
export async function probeSubreddit(subreddit, { windowDays = WINDOW_DAYS } = {}) {
  const posts = await fetchSubreddit(POSTS_URL, subreddit, windowDays, 10);
  return posts.length;
}

/**
 * @param {string} query the market, used for the relevance floor
 * @param {string[]} subreddits validated community names
 */
export async function collectRedditArchive(
  query,
  subreddits,
  { windowDays = WINDOW_DAYS, perSubreddit = 40 } = {},
) {
  return runCollector('reddit-archive', async () => {
    if (subreddits.length === 0) return [];

    const items = [];
    let reached = 0;
    let lastError = null;

    // Sequential: the archive answers 422 "slow down" when pushed, and a
    // partial result is better than a throttled one.
    for (const subreddit of subreddits) {
      try {
        const [posts, comments] = [
          await fetchSubreddit(POSTS_URL, subreddit, windowDays, perSubreddit),
          await fetchSubreddit(COMMENTS_URL, subreddit, windowDays, perSubreddit),
        ];
        reached += 1;
        for (const post of posts) items.push(postToEvidence(post));
        for (const comment of comments) {
          const evidence = commentToEvidence(comment);
          if (evidence) items.push(evidence);
        }
      } catch (error) {
        lastError = error;
      }
    }

    // Every community failed, so we learned nothing about Reddit. Saying
    // "no results" here would claim these communities were silent.
    if (reached === 0 && lastError) {
      throw new HttpError(
        `arctic-shift unreachable for all ${subreddits.length} communities: ${lastError.message}`,
        lastError instanceof HttpError ? lastError.state : STATE.UNREACHABLE,
      );
    }

    return items
      .filter((item) => (item.title || item.body))
      .filter((item) => matchesQuery(item, query));
  });
}
