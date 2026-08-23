/**
 * GitHub issues via the public search API. Free, no auth required.
 *
 * Issues are the least speculative evidence we collect: a bug report or feature
 * request is someone describing a problem they actually hit, with a date and a
 * permanent link. Sorting by reactions surfaces the ones others agreed with.
 *
 * Rate limits: the *search* API allows only 10 requests/minute unauthenticated
 * (much tighter than the 60/hour core limit). One run makes a single request,
 * so this is comfortable, but it is why we do not paginate or fetch comments
 * per issue. Setting GITHUB_TOKEN raises the limit to 30/minute.
 */

import { getJson, runCollector } from '../http.js';
import { makeEvidence, toIsoDate, matchesQuery } from '../normalize.js';
import { WINDOW_DAYS } from '../config.js';

const SEARCH_URL = 'https://api.github.com/search/issues';

function windowStartDate(windowDays) {
  return new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);
}

/** GitHub's query syntax chokes on punctuation from free-text market names. */
function cleanQuery(query) {
  return query.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** `https://api.github.com/repos/owner/name` -> `owner/name` */
function repoFromApiUrl(apiUrl) {
  if (!apiUrl) return null;
  const match = apiUrl.match(/repos\/([^/]+\/[^/]+)$/);
  return match ? match[1] : null;
}

export async function collectGitHub(query, { windowDays = WINDOW_DAYS, limit = 100 } = {}) {
  return runCollector('github', async () => {
    const search = [
      cleanQuery(query),
      'in:title,body',
      'is:issue',
      `created:>=${windowStartDate(windowDays)}`,
    ].join(' ');

    const params = new URLSearchParams({
      q: search,
      sort: 'reactions',
      order: 'desc',
      per_page: String(limit),
    });

    const headers = { Accept: 'application/vnd.github+json' };
    // Optional. Raises the search limit from 10/min to 30/min.
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const data = await getJson(`${SEARCH_URL}?${params}`, { headers });

    const items = (data.items || []).map((issue) => {
      const repo = repoFromApiUrl(issue.repository_url);
      const owner = repo ? repo.split('/')[0] : null;
      return makeEvidence({
        id: `gh:issue:${issue.id}`,
        source: 'github',
        kind: 'issue',
        title: issue.title || '',
        body: issue.body || '',
        url: issue.html_url,
        author: issue.user?.login || null,
        container: repo,
        publishedAt: toIsoDate(issue.created_at),
        dateConfidence: 'high',
        primary: issue.reactions?.total_count || 0,
        comments: issue.comments || 0,
        // A signal for the classifier and the audit view — not a filter. Issues
        // filed by the repo owner are often that person's own backlog, but
        // maintainers also relay genuine user reports, and 18 of 45 items in a
        // trucking run matched this. Deleting them outright would have thrown
        // away real reports along with the noise.
        authorOwnsContainer: Boolean(
          owner && issue.user?.login &&
          owner.toLowerCase() === issue.user.login.toLowerCase(),
        ),
        threadId: `gh:issue:${issue.id}`,
      });
    });

    return items.filter((item) => matchesQuery(item, query));
  });
}
