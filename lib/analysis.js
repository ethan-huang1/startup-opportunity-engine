/**
 * Whether the analysis actually ran — kept strictly separate from what it found.
 *
 * A run once collected 115 relevant discussions, had all twelve of its
 * extraction batches fail, and reported "insufficient customer evidence". That
 * is a claim about the market, and it was false: the market was never examined.
 * Failing to look is not the same as looking and finding nothing, and the two
 * must never render as the same outcome.
 *
 * Three failures are distinguished because they mean different things and have
 * different fixes:
 *   - collection failed  -> we could not reach a source
 *   - extraction failed  -> we reached the discussions but could not read them
 *   - grouping failed    -> we read them but could not organise them
 */

export const ANALYSIS = {
  COMPLETE: 'complete',
  DEGRADED: 'degraded',
  FAILED: 'failed',
};

export const STEP = {
  OK: 'ok',
  PARTIAL: 'partial',
  FAILED: 'failed',
  FALLBACK: 'fallback',
  SKIPPED: 'skipped',
};

/**
 * @param {object|null} extraction stats from extractPainPoints
 * @param {object|null} themeStats stats from groupByTheme
 * @param {object} retrieval the item-level retrieval assessment
 */
export function assessAnalysis({ extraction, themeStats, retrieval }) {
  // Reports saved before the retrieval/coverage split have neither field under
  // the current name. Treat a missing assessment as "nothing known about
  // collection" rather than crashing on an older run.
  const degradedSources = retrieval?.degradedSources ?? [];
  const collection = {
    state: degradedSources.length > 0 ? STEP.PARTIAL : STEP.OK,
    degradedSources,
    itemsRetrieved: retrieval?.totalInWindow ?? 0,
  };

  const batches = extraction?.batches ?? 0;
  const failedBatches = extraction?.failedBatches ?? 0;

  let extractionStep;
  if (!extraction) extractionStep = STEP.SKIPPED;
  else if (batches > 0 && failedBatches >= batches) extractionStep = STEP.FAILED;
  else if (failedBatches > 0) extractionStep = STEP.PARTIAL;
  else extractionStep = STEP.OK;

  // groupByTheme already degrades safely: when the model call fails it returns
  // the deterministic lexical clusters unchanged. That fallback is real, so a
  // grouping failure means "grouped more coarsely", not "no grouping".
  let groupingStep;
  if (!themeStats) groupingStep = STEP.SKIPPED;
  else if (themeStats.failed) groupingStep = STEP.FALLBACK;
  else groupingStep = STEP.OK;

  let state;
  if (extractionStep === STEP.FAILED) state = ANALYSIS.FAILED;
  else if (
    extractionStep === STEP.PARTIAL ||
    groupingStep === STEP.FALLBACK ||
    collection.state === STEP.PARTIAL
  ) state = ANALYSIS.DEGRADED;
  else state = ANALYSIS.COMPLETE;

  return {
    state,
    collection,
    extraction: { state: extractionStep, batches, failedBatches },
    grouping: { state: groupingStep },
    headline: headlineFor(state, extractionStep, groupingStep),
    explanation: explainAnalysis(state, collection, {
      step: extractionStep, batches, failedBatches,
    }, groupingStep),
  };
}

function headlineFor(state, extractionStep, groupingStep) {
  if (state === ANALYSIS.FAILED) return 'Analysis failed';
  if (extractionStep === STEP.PARTIAL) return 'Analysis incomplete';
  if (groupingStep === STEP.FALLBACK) return 'Analysis degraded';
  return 'Analysis complete';
}

function explainAnalysis(state, collection, extraction, groupingStep) {
  const parts = [];

  if (state === ANALYSIS.FAILED) {
    parts.push(
      `${collection.itemsRetrieved} relevant discussions were collected successfully, ` +
      `but all ${extraction.batches} attempts to read them failed. Nothing below ` +
      'describes this market — it describes a run that could not be completed. ' +
      'Re-running is the fix; treat any absence of results as unknown, not as a finding.',
    );
    return parts.join(' ');
  }

  if (extraction.step === STEP.PARTIAL) {
    parts.push(
      `${extraction.failedBatches} of ${extraction.batches} batches of discussions ` +
      'could not be read, so some evidence that exists was never examined. ' +
      'Counts below understate what is there.',
    );
  }

  if (groupingStep === STEP.FALLBACK) {
    parts.push(
      'Grouping related problems fell back to text similarity alone, which splits ' +
      'the same complaint worded two ways into separate groups. Anything shown as ' +
      'unsupported may simply be fragmented, so a zero result here is not a ' +
      'conclusion about the market.',
    );
  }

  if (collection.state === STEP.PARTIAL) {
    parts.push(
      `${collection.degradedSources.join(' and ')} did not complete, so material ` +
      'that exists there was never retrieved.',
    );
  }

  if (parts.length === 0) {
    parts.push('All discussions were collected, read, and grouped without error.');
  }
  return parts.join(' ');
}

/**
 * True when a zero or thin result may be an artefact of the run rather than a
 * fact about the market. The UI uses this to withhold market conclusions.
 */
export function resultsAreTrustworthy(analysis) {
  return (
    analysis.state === ANALYSIS.COMPLETE ||
    // A partly-degraded collection still examined everything it retrieved.
    (analysis.extraction.state === STEP.OK && analysis.grouping.state !== STEP.FALLBACK)
  );
}
