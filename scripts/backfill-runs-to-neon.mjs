/**
 * One-time load of the existing runs/*.json files into Neon, using the same
 * beginRun/saveRunResult path a live analysis uses. The .json files are left
 * on disk afterward as a historical archive — this script only reads them.
 *
 * Usage: npm run backfill
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginRun, saveRunResult } from '../lib/store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNS_DIR = join(ROOT, 'runs');

function slugify(market) {
  return (
    market
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'run'
  );
}

// Older runs used `coverage` for what the pipeline now calls `retrieval`
// (collection-health) when a run halted before qualified coverage was ever
// computed. Best-effort only — these are historical files, not live data.
function normalizeLegacyReport(report) {
  if (report.retrieval) return report;
  return { ...report, retrieval: report.coverage ?? null };
}

async function main() {
  const files = (await readdir(RUNS_DIR)).filter((name) => name.endsWith('.json'));

  for (const filename of files) {
    const raw = await readFile(join(RUNS_DIR, filename), 'utf8');
    const report = normalizeLegacyReport(JSON.parse(raw));
    const slug = slugify(report.market);

    const claim = await beginRun(slug, report.market);
    if (claim.status === 'already_analyzing') {
      console.log(`skip ${filename}: ${slug} is already marked analyzing`);
      continue;
    }
    await saveRunResult(claim.runId, report);
    console.log(`loaded ${filename} -> markets.${slug} (run ${claim.runId})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
