/**
 * Snapshots a real pipeline run as the browser-test fixture.
 *
 * This tool used to BUILD a fixture: it hand-wrote opportunity prose and paired
 * it with quotes cut from arbitrary evidence by slicing the first 160
 * characters. Every quote was real and every claim was invented — the exact
 * "plausible conclusion with citations stapled on" pattern this project exists
 * to prevent, sitting in the project's own demo surface. All ten of its quotes
 * later failed the corrected verbatim gate.
 *
 * It now only ever copies. It writes no prose, edits no claim, and refuses to
 * emit a fixture whose chain does not verify. If a run has no opportunities,
 * that is a fact about the run, and the fix is to do a better run — not to
 * manufacture one here.
 *
 * Usage: node tests/make-fixture.mjs runs/<slug>.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { verifyReportChain } from '../lib/verify-chain.js';

const source = process.argv[2];
if (!source) {
  console.error('Usage: node tests/make-fixture.mjs runs/<slug>.json');
  process.exit(2);
}

const report = JSON.parse(await readFile(source, 'utf8'));

if (report.fixture) {
  console.error(`${source} is itself a fixture. Snapshot a real run instead.`);
  process.exit(2);
}

const { ok, problems, checked } = verifyReportChain(report);
if (!ok) {
  console.error(`${source} failed chain verification and will not be used as a fixture:\n`);
  for (const problem of problems) console.error('  -', problem);
  process.exit(1);
}

if ((report.opportunities || []).length === 0) {
  console.error(
    `${source} contains no opportunities, so it cannot exercise the ranked UI.\n` +
    'Run a market that produces some. Do not hand-write them.',
  );
  process.exit(1);
}

// Copied verbatim. The only added fields record that this is a snapshot and
// where it came from, so the fixture can never be mistaken for a live run.
const fixture = {
  ...report,
  fixture: true,
  fixtureSource: source,
  fixtureCapturedAt: new Date().toISOString(),
};

await writeFile('fixtures/sample-report.json', JSON.stringify(fixture, null, 2));

console.log(
  `fixture snapshotted from ${source}\n` +
  `  ${checked.opportunities} opportunities, ${checked.weakSignals} weak signals, ` +
  `${checked.quotes} quotes verified, ${report.evidence.length} evidence items\n` +
  '  chain verified: every quote verbatim in its own item, every citation resolves,\n' +
  '  every score equals its components.',
);
