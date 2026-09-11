/**
 * Report storage: markets (identity) + append-only analysis_runs (history,
 * one row per run, the whole pipeline report stored as jsonb once it
 * finishes). A market with no row has never been analyzed — there is no
 * separate "not_analyzed" status to keep in sync.
 *
 * Every read here only ever looks at the latest 'complete'/'degraded' run
 * for a market — a 'running' or 'failed' row is invisible to reads, so an
 * in-flight or failed refresh never disturbs the last good report.
 */

import { sql } from './db.js';

// A "running" row older than this is treated as abandoned (a crashed
// process, a dead serverless instance) rather than genuinely in flight, so a
// new request can reclaim the market instead of being locked out forever.
// ponytail: no crash-recovery signal beyond a timer; a real job queue with
// heartbeats would replace this if abandoned runs turn out to be common.
const STALE_ANALYZING_MINUTES = 20;

/**
 * Atomically claims a market for analysis. Returns `{ status: 'started',
 * runId }` if this call may proceed, or `{ status: 'already_analyzing',
 * runId }` if another analysis is already in flight (and not stale).
 *
 * The actual atomicity guarantee is the partial unique index
 * (`analysis_runs_one_running_per_market`), not the `WHERE NOT EXISTS`
 * below — that's only a cheap pre-check to avoid throwing in the common
 * non-racing case. Two truly concurrent claims can both pass the pre-check;
 * the loser gets a `23505` unique-violation from the index at insert time,
 * caught below and treated the same as "already analyzing".
 */
export async function beginRun(slug, marketQuery) {
  await sql`
    INSERT INTO markets (slug, query) VALUES (${slug}, ${marketQuery})
    ON CONFLICT (slug) DO UPDATE SET query = EXCLUDED.query
  `;

  await sql`
    UPDATE analysis_runs SET status = 'failed', error = 'abandoned (stale)', completed_at = now()
    WHERE market_slug = ${slug} AND status = 'running'
      AND created_at < now() - interval '1 minute' * ${STALE_ANALYZING_MINUTES}
  `;

  let claimed;
  try {
    claimed = await sql`
      INSERT INTO analysis_runs (market_slug, query, status)
      SELECT ${slug}, ${marketQuery}, 'running'
      WHERE NOT EXISTS (
        SELECT 1 FROM analysis_runs WHERE market_slug = ${slug} AND status = 'running'
      )
      RETURNING id
    `;
  } catch (error) {
    if (error.code !== '23505') throw error;
    claimed = [];
  }

  if (claimed.length === 0) {
    const [current] = await sql`
      SELECT id FROM analysis_runs WHERE market_slug = ${slug} AND status = 'running'
      ORDER BY created_at DESC LIMIT 1
    `;
    return { status: 'already_analyzing', runId: current?.id ?? null };
  }

  return { status: 'started', runId: claimed[0].id };
}

/**
 * True if any market is currently mid-analysis and not stale. A basic,
 * system-wide brake on top of beginRun()'s per-market claim — one admin
 * account has no reason to run two analyses at once. There is a small race
 * between this check and the next beginRun() call (two requests for
 * different markets could both pass it), which is an accepted gap for a
 * "basic" concurrency guard on an admin-only route, not a hard invariant.
 */
export async function anyRunInProgress() {
  const rows = await sql`
    SELECT 1 FROM analysis_runs
    WHERE status = 'running' AND created_at >= now() - interval '1 minute' * ${STALE_ANALYZING_MINUTES}
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Marks a run failed with no report, e.g. when the pipeline throws. */
export async function failRun(runId, message) {
  await sql`
    UPDATE analysis_runs SET status = 'failed', error = ${message}, completed_at = now()
    WHERE id = ${runId}
  `;
}

// 'failed' is reserved for failRun()'s no-report exception case; anything
// that produced a report — even one the pipeline itself halted on thin
// evidence — is 'degraded' (report.halted) or 'complete'. Report quality
// detail lives inside report.analysis, already rendered by the UI; the
// storage-level status only needs to say "is there a report to show".
function statusFor(report) {
  return report.halted ? 'degraded' : 'complete';
}

/** Persists a finished pipeline report against a run created by beginRun(). */
export async function saveRunResult(runId, report) {
  await sql`
    UPDATE analysis_runs
    SET status = ${statusFor(report)}, query = ${report.market},
        report = ${JSON.stringify(report)}::jsonb, completed_at = now()
    WHERE id = ${runId}
  `;
}

/** The latest finished report for a market, or null if never analyzed. */
export async function getReport(slug) {
  const [row] = await sql`
    SELECT report FROM analysis_runs
    WHERE market_slug = ${slug} AND status IN ('complete', 'degraded')
    ORDER BY created_at DESC LIMIT 1
  `;
  return row?.report ?? null;
}

/** Summary list for `/api/runs`: every market's latest finished run. */
export async function listMarkets() {
  const rows = await sql`
    SELECT m.slug, r.query AS market, r.created_at AS generated_at,
      r.report -> 'coverage' ->> 'verdict' AS verdict,
      jsonb_array_length(coalesce(r.report -> 'opportunities', '[]'::jsonb)) AS opportunities
    FROM markets m
    JOIN LATERAL (
      SELECT * FROM analysis_runs
      WHERE market_slug = m.slug AND status IN ('complete', 'degraded')
      ORDER BY created_at DESC LIMIT 1
    ) r ON true
    ORDER BY r.created_at DESC
  `;
  return rows.map((row) => ({
    slug: row.slug,
    market: row.market,
    generatedAt: row.generated_at ? new Date(row.generated_at).toISOString() : null,
    verdict: row.verdict,
    opportunities: Number(row.opportunities),
  }));
}
