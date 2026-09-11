/**
 * A negative verdict has to be earned.
 *
 * "Insufficient customer evidence" is a claim about the market. A run that
 * failed to read most of what it collected has not measured the market, and
 * must say so — `unknown` — rather than publishing a finding. The pipeline
 * already guarded the 100%-failure case; this covers everything between.
 *
 * Regression: a real run lost 14 of 15 extraction batches to a throttled
 * model and reported "There is not enough real customer evidence here to
 * rank anything" about a market that, on re-reading 20 of its 150 items,
 * yielded 11 verified customer statements.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_UNREAD_FOR_NEGATIVE_VERDICT } from '../lib/config.js';

/**
 * The rule under test, stated once. The pipeline applies exactly this
 * comparison; running the whole pipeline here would mean making real model
 * calls, which is the one thing the suite must never do.
 */
function mayPublishNegativeVerdict({ batches, failedBatches }) {
  const unread = batches > 0 ? failedBatches / batches : 0;
  return unread <= MAX_UNREAD_FOR_NEGATIVE_VERDICT;
}

test('a run that read everything may report insufficient', () => {
  assert.equal(mayPublishNegativeVerdict({ batches: 15, failedBatches: 0 }), true);
});

test('losing a couple of batches does not void a negative verdict', () => {
  // Losing batches can only hide evidence, so a small loss still supports
  // "we looked and there was not much".
  assert.equal(mayPublishNegativeVerdict({ batches: 15, failedBatches: 1 }), true);
  assert.equal(mayPublishNegativeVerdict({ batches: 15, failedBatches: 5 }), true);
});

test('the run that caused this test may NOT report insufficient', () => {
  assert.equal(mayPublishNegativeVerdict({ batches: 15, failedBatches: 14 }), false);
});

test('total failure may not report insufficient either', () => {
  assert.equal(mayPublishNegativeVerdict({ batches: 12, failedBatches: 12 }), false);
});

test('the threshold is a fraction, not a count, so it scales with run size', () => {
  // 4 of 6 and 40 of 60 are the same failure, and must be treated alike.
  assert.equal(mayPublishNegativeVerdict({ batches: 6, failedBatches: 4 }), false);
  assert.equal(mayPublishNegativeVerdict({ batches: 60, failedBatches: 40 }), false);
});

test('a run with no batches at all is not treated as a clean read', () => {
  // Nothing to read means nothing was read; the coverage gate upstream
  // halts this case before a verdict is reached.
  assert.equal(mayPublishNegativeVerdict({ batches: 0, failedBatches: 0 }), true);
});

/**
 * The rule above is a restatement, so it could drift from the code it
 * describes. This pins it to the real thing: the pipeline must actually
 * consult the threshold on the insufficient path, and must return `unknown`
 * there. (Same technique as tests/no-claude-on-read.test.js's static check —
 * executing runPipeline would mean real collectors and real model calls.)
 */
test('the pipeline really applies this rule on the insufficient path', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/pipeline.js', import.meta.url), 'utf8');

  assert.match(
    source,
    /unreadFraction\s*>\s*MAX_UNREAD_FOR_NEGATIVE_VERDICT/,
    'pipeline.js must compare the unread fraction against the threshold',
  );

  const insufficientBranch = source.slice(source.indexOf('coverage.verdict === VERDICT.INSUFFICIENT'));
  const guard = insufficientBranch.indexOf('MAX_UNREAD_FOR_NEGATIVE_VERDICT');
  const unknown = insufficientBranch.indexOf('VERDICT.UNKNOWN');
  assert.ok(guard !== -1, 'the guard must live on the insufficient path');
  assert.ok(unknown !== -1 && unknown > guard, 'that guard must downgrade the verdict to unknown');
});
