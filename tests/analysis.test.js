/**
 * Failure-handling tests.
 *
 * The two cases here are reproduced from real saved runs, not invented:
 *
 *  - `fixtures/failed-extraction-run.json` is that run preserved verbatim: an
 *    `AI coding assistants` run that collected 115 in-window discussions and
 *    then had all 12 extraction batches fail. It reported "insufficient
 *    customer evidence" — a claim about the market that the run never earned.
 *    It lives in fixtures/ because a later successful run of the same market
 *    overwrote runs/ai-coding-assistants.json, and this failure case has to
 *    stay reproducible. Copied unedited; no field was touched.
 *
 *  - `runs/hvac.json` is the saved grouping-failure case: 4 of its 19
 *    extraction batches failed AND its theme pass failed, leaving grouping on
 *    the deterministic lexical fallback. It produced zero opportunities, which
 *    must not be presented as a finding about the HVAC market.
 *
 *  - `runs/independent-hvac-contractors.json` halted before extraction, so
 *    grouping never ran at all. A market conclusion is equally unavailable
 *    there, for a third reason, and none of these must look alike.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assessAnalysis, ANALYSIS, STEP, resultsAreTrustworthy } from '../lib/analysis.js';
import { VERDICT } from '../lib/coverage.js';

const ROOT = new URL('..', import.meta.url).pathname;
const loadRun = async (name) =>
  JSON.parse(await readFile(join(ROOT, 'runs', `${name}.json`), 'utf8'));

/** The preserved total-extraction-failure run. */
const loadFailedRun = async () =>
  JSON.parse(await readFile(join(ROOT, 'fixtures', 'failed-extraction-run.json'), 'utf8'));

const cleanRetrieval = {
  totalInWindow: 115,
  degradedSources: [],
};

/* ------------------------------- total extraction failure (saved AI case) */

test('the saved AI-coding-assistants run had every extraction batch fail', async () => {
  const run = await loadFailedRun();
  // Guard the premise: if this stops being the failure case, the test below is
  // no longer reproducing anything real.
  assert.equal(run.extraction.batches, 12);
  assert.equal(run.extraction.failedBatches, 12);
  assert.equal(run.extraction.returned, 0);
  assert.ok(run.retrieval.totalInWindow > 100, 'collection itself succeeded');
});

test('a run that read nothing is failed, not "insufficient evidence"', async () => {
  const run = await loadFailedRun();
  const analysis = assessAnalysis({
    extraction: run.extraction,
    themeStats: null,
    retrieval: run.retrieval,
  });

  assert.equal(analysis.state, ANALYSIS.FAILED);
  assert.equal(analysis.extraction.state, STEP.FAILED);
  assert.equal(analysis.headline, 'Analysis failed');
  assert.equal(resultsAreTrustworthy(analysis), false);
});

test('the failure message says collection worked and analysis did not', async () => {
  const run = await loadFailedRun();
  const { explanation } = assessAnalysis({
    extraction: run.extraction,
    themeStats: null,
    retrieval: run.retrieval,
  });

  assert.match(explanation, /collected successfully/);
  assert.match(explanation, /all 12 attempts to read them failed/);
  assert.match(explanation, /does not describe this market|Nothing below\s+describes this market/);
  assert.doesNotMatch(
    explanation,
    /insufficient (customer )?evidence/i,
    'must never imply the market lacks evidence when nothing was read',
  );
});

test('a failed analysis reports an unknown verdict, never a finding', () => {
  // UNKNOWN and INSUFFICIENT are different claims and must stay different.
  assert.notEqual(VERDICT.UNKNOWN, VERDICT.INSUFFICIENT);
  assert.equal(VERDICT.UNKNOWN, 'unknown');
});

/* ------------------------------------------------- partial batch failure */

test('some batches failing is degraded, and the count is reported', () => {
  const analysis = assessAnalysis({
    extraction: { batches: 12, failedBatches: 4, returned: 30 },
    themeStats: { failed: false, merged: 3 },
    retrieval: cleanRetrieval,
  });

  assert.equal(analysis.state, ANALYSIS.DEGRADED);
  assert.equal(analysis.extraction.state, STEP.PARTIAL);
  assert.equal(analysis.extraction.failedBatches, 4);
  assert.equal(analysis.headline, 'Analysis incomplete');
  assert.match(analysis.explanation, /4 of 12 batches/);
  assert.match(analysis.explanation, /understate/);
});

/* ----------------------------------------------------- grouping fallback */

test('grouping failure is degraded and warns that zero is not a conclusion', () => {
  const analysis = assessAnalysis({
    extraction: { batches: 8, failedBatches: 0, returned: 40 },
    themeStats: { failed: true, merged: 0 },
    retrieval: cleanRetrieval,
  });

  assert.equal(analysis.state, ANALYSIS.DEGRADED);
  // groupByTheme already returns the deterministic lexical clusters when the
  // model call fails, so this is a fallback rather than a loss.
  assert.equal(analysis.grouping.state, STEP.FALLBACK);
  assert.match(analysis.explanation, /text similarity/);
  assert.match(analysis.explanation, /not a\s+conclusion about the market/);
  assert.equal(resultsAreTrustworthy(analysis), false);
});

/* --------------------------------- saved HVAC grouping failure (real data) */

test('the saved HVAC run really did lose batches and fall back on grouping', async () => {
  const run = await loadRun('hvac');
  // Premise guard, as above: if this stops being the degraded case the
  // assertions below are no longer reproducing anything real.
  assert.equal(run.extraction.batches, 19);
  assert.equal(run.extraction.failedBatches, 4);
  assert.equal(run.themeStats.failed, true, 'the theme pass failed');
  assert.equal(run.opportunities.length, 0, 'and it produced no opportunities');
});

test('the saved HVAC run is degraded on both extraction and grouping', async () => {
  const run = await loadRun('hvac');
  const analysis = assessAnalysis({
    extraction: run.extraction,
    themeStats: run.themeStats,
    retrieval: run.retrieval,
  });

  assert.equal(analysis.state, ANALYSIS.DEGRADED);
  assert.equal(analysis.extraction.state, STEP.PARTIAL);
  assert.equal(analysis.extraction.failedBatches, 4);
  assert.equal(analysis.grouping.state, STEP.FALLBACK);
  assert.equal(analysis.headline, 'Analysis incomplete');
});

test('its zero opportunities are not presented as a market conclusion', async () => {
  const run = await loadRun('hvac');
  const analysis = assessAnalysis({
    extraction: run.extraction,
    themeStats: run.themeStats,
    retrieval: run.retrieval,
  });

  assert.equal(resultsAreTrustworthy(analysis), false);
  assert.match(analysis.explanation, /4 of 19 batches/);
  assert.match(analysis.explanation, /not a\s+conclusion about the market/);
});

/* ------------------------------------- grouping never reached (saved HVAC) */

test('the saved HVAC run halted before extraction or grouping ran', async () => {
  const run = await loadRun('independent-hvac-contractors');
  assert.equal(run.halted, true);
  assert.equal(run.extraction, null, 'extraction never ran');
  assert.equal(run.themeStats, undefined, 'grouping never ran');
});

test('assessAnalysis survives a report saved before the retrieval split', () => {
  const analysis = assessAnalysis({ extraction: null, themeStats: null, retrieval: undefined });
  assert.equal(analysis.collection.itemsRetrieved, 0);
  assert.equal(analysis.extraction.state, STEP.SKIPPED);
});

test('never-reached stages are marked skipped, not failed', async () => {
  const run = await loadRun('independent-hvac-contractors');
  // This run predates the retrieval/coverage split, so it carries the older
  // field name — which is exactly why assessAnalysis must tolerate its absence.
  const analysis = assessAnalysis({
    extraction: run.extraction,
    themeStats: null,
    retrieval: run.retrieval ?? run.coverage,
  });

  assert.equal(analysis.extraction.state, STEP.SKIPPED);
  assert.equal(analysis.grouping.state, STEP.SKIPPED);
  // Nothing broke — the run stopped on purpose because too little came back.
  assert.notEqual(analysis.state, ANALYSIS.FAILED);
});

/* -------------------------------------------------- collection vs the rest */

test('collection, extraction, and grouping failures stay distinguishable', () => {
  const collectionOnly = assessAnalysis({
    extraction: { batches: 6, failedBatches: 0, returned: 20 },
    themeStats: { failed: false },
    retrieval: { totalInWindow: 60, degradedSources: ['Reddit search'] },
  });
  assert.equal(collectionOnly.collection.state, STEP.PARTIAL);
  assert.equal(collectionOnly.extraction.state, STEP.OK);
  assert.equal(collectionOnly.grouping.state, STEP.OK);
  assert.match(collectionOnly.explanation, /Reddit search did not complete/);

  const extractionOnly = assessAnalysis({
    extraction: { batches: 6, failedBatches: 6, returned: 0 },
    themeStats: null,
    retrieval: cleanRetrieval,
  });
  assert.equal(extractionOnly.collection.state, STEP.OK);
  assert.equal(extractionOnly.extraction.state, STEP.FAILED);

  const groupingOnly = assessAnalysis({
    extraction: { batches: 6, failedBatches: 0, returned: 20 },
    themeStats: { failed: true },
    retrieval: cleanRetrieval,
  });
  assert.equal(groupingOnly.extraction.state, STEP.OK);
  assert.equal(groupingOnly.grouping.state, STEP.FALLBACK);
});

test('the successful re-run of the same market is complete, not failed', async () => {
  // The counterpart to the preserved failure: same market, same pipeline, and
  // the difference is entirely in whether the analysis ran.
  const run = await loadRun('ai-coding-assistants');
  assert.equal(run.extraction.failedBatches, 0);
  assert.equal(run.analysis.state, ANALYSIS.COMPLETE);
  assert.equal(run.analysis.extraction.state, STEP.OK);
  assert.equal(run.analysis.grouping.state, STEP.OK);
  assert.ok(run.opportunities.length > 0, 'a complete analysis produced ranked results');
});

test('a clean run is complete and its results can be trusted', () => {
  const analysis = assessAnalysis({
    extraction: { batches: 6, failedBatches: 0, returned: 30 },
    themeStats: { failed: false, merged: 4 },
    retrieval: { totalInWindow: 90, degradedSources: [] },
  });
  assert.equal(analysis.state, ANALYSIS.COMPLETE);
  assert.equal(analysis.headline, 'Analysis complete');
  assert.equal(resultsAreTrustworthy(analysis), true);
  assert.match(analysis.explanation, /collected, read, and grouped without error/);
});
