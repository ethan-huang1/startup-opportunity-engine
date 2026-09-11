/**
 * Reddit via the `last30days` plugin (MIT, pure Python stdlib).
 *
 * Reddit's public .json API is dead and the official API requires OAuth, so
 * reaching it means maintaining several fallback lanes (RSS, listing pages,
 * arctic-shift, shreddit). That maintenance is the entire reason this plugin
 * exists, so we delegate to it rather than reimplementing a fragile scraper.
 *
 * We ask for `--json-profile=raw` because the versioned "agent" profile returns
 * truncated snippets, while raw gives full post bodies and the top comments —
 * and comments are where people actually describe their problems.
 */

import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { makeEvidence, matchesQuery } from '../normalize.js';
import { STATE } from '../http.js';
import { WINDOW_DAYS, resolveLast30DaysScript } from '../config.js';

/** Maps the plugin's source_status states onto ours. */
const STATE_MAP = {
  ok: STATE.OK,
  'no-results': STATE.NO_RESULTS,
  partial: STATE.OK,
  'rate-limited': STATE.RATE_LIMITED,
  'auth-failed': STATE.ERROR,
  unreachable: STATE.UNREACHABLE,
  timeout: STATE.TIMEOUT,
  'schema-drift': STATE.ERROR,
  'skipped-unconfigured': STATE.ERROR,
  error: STATE.ERROR,
};

function runPlugin(scriptPath, query, windowDays, outputPath, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      'python3',
      [
        scriptPath,
        query,
        '--search', 'reddit',
        '--emit=json',
        '--json-profile=raw',
        '--days', String(windowDays),
        '--output', outputPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stderr: `timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: error.message, spawnFailed: true });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, timedOut: false });
    });
  });
}

/**
 * Reddit posts from the keyless lanes frequently have no author attached, so
 * `makeEvidence` falls back to per-item voice identity. Comments do carry an
 * author, a score, a date, and their own permalink, which makes each one
 * independently citable evidence from a distinct person.
 */
function toEvidence(report) {
  const items = [];
  const posts = report.items_by_source?.reddit || [];

  for (const post of posts) {
    const threadId = `reddit:post:${post.item_id}`;
    items.push(
      makeEvidence({
        id: threadId,
        source: 'reddit',
        kind: 'post',
        title: post.title || '',
        body: post.body || '',
        url: post.url,
        author: post.author || null,
        container: post.container ? `r/${post.container}` : null,
        publishedAt: post.published_at || null,
        dateConfidence: post.date_confidence || 'low',
        primary: post.engagement?.score || 0,
        comments: post.engagement?.num_comments || 0,
        threadId,
      }),
    );

    for (const comment of post.metadata?.top_comments || []) {
      const text = (comment.excerpt || '').trim();
      if (!text || !comment.url) continue;
      items.push(
        makeEvidence({
          id: `reddit:comment:${comment.url}`,
          source: 'reddit',
          kind: 'comment',
          title: post.title || '',
          body: text,
          url: comment.url,
          author: comment.author || null,
          container: post.container ? `r/${post.container}` : null,
          publishedAt: comment.date || post.published_at || null,
          dateConfidence: comment.date ? 'high' : 'low',
          primary: comment.score || 0,
          comments: 0,
          parentId: threadId,
          threadId,
        }),
      );
    }
  }

  return items;
}

export async function collectReddit(query, { windowDays = WINDOW_DAYS, timeoutMs = 240000 } = {}) {
  // A missing dependency is a failed source, stated plainly — never silence
  // that looks like "Reddit had nothing".
  const scriptPath = resolveLast30DaysScript();
  if (!scriptPath) {
    return {
      source: 'reddit',
      state: STATE.ERROR,
      items: [],
      error:
        'The last30days plugin was not found. Install it, or set LAST30DAYS_SCRIPT ' +
        'to the path of its last30days.py.',
    };
  }

  const outputPath = join(tmpdir(), `soe-reddit-${randomUUID()}.json`);

  try {
    const result = await runPlugin(scriptPath, query, windowDays, outputPath, timeoutMs);

    let report;
    try {
      report = JSON.parse(await readFile(outputPath, 'utf8'));
    } catch {
      // No parseable output means we learned nothing about Reddit — which is
      // not the same as Reddit having nothing to say.
      return {
        source: 'reddit',
        state: result.timedOut ? STATE.TIMEOUT : STATE.UNREACHABLE,
        items: [],
        error: result.spawnFailed
          ? `Could not run last30days (is python3 on PATH?): ${result.stderr}`
          : result.stderr.trim().split('\n').slice(-3).join(' ') || 'no output produced',
      };
    }

    const status = report.source_status?.reddit;
    const items = toEvidence(report).filter((item) => matchesQuery(item, query));
    const mappedState = STATE_MAP[status?.state] || STATE.ERROR;

    return {
      source: 'reddit',
      // Trust the plugin's own verdict about *why* it returned nothing, but if
      // it says ok and our relevance floor emptied the set, report no-results.
      state: mappedState === STATE.OK && items.length === 0 ? STATE.NO_RESULTS : mappedState,
      items,
      error: status?.error || null,
    };
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}
