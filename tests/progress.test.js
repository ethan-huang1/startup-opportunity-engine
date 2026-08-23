import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGES,
  PROGRESS_NOTE,
  formatElapsed,
  progressState,
  describeStage,
} from '../public/progress-model.js';

test('elapsed time is shown as minutes and seconds', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(9_000), '0:09');
  assert.equal(formatElapsed(134_000), '2:14');
  assert.equal(formatElapsed(-500), '0:00');
});

test('progress reports which stage is running, out of how many', () => {
  const state = progressState([
    { stage: 'communities', status: 'done', subreddits: ['Truckers'] },
    { stage: 'collect', status: 'start' },
  ]);
  assert.equal(state.heading, `Stage 2 of ${STAGES.length} · Collecting evidence`);
  assert.equal(state.steps[0].state, 'done');
  assert.equal(state.steps[1].state, 'active');
  assert.equal(state.steps[2].state, 'pending');
});

test('no percentage or time-remaining is ever claimed', () => {
  const state = progressState([{ stage: 'extract', status: 'progress', batch: 3, of: 11 }]);
  const rendered = [state.heading, PROGRESS_NOTE, ...state.steps.map((s) => describeStage(s.event))]
    .join(' ');
  assert.doesNotMatch(rendered, /%/, 'a percentage would be invented');
  assert.doesNotMatch(rendered, /remaining|left|eta|estimated time/i, 'an ETA would be invented');
  // Saying which batch is running is a fact, not a prediction.
  assert.match(rendered, /batch 3 of 11/);
});

test('a halted run stops claiming a stage is in progress', () => {
  const state = progressState([
    { stage: 'communities', status: 'done', subreddits: [] },
    { stage: 'collect', status: 'done', count: 4 },
    { stage: 'halted', status: 'done', reason: 'nothing-retrieved' },
  ]);
  assert.equal(state.halted, true);
  assert.equal(state.heading, 'Stopped');
  assert.ok(state.steps.every((step) => step.state !== 'active'));
});

test('a failed source is described as failed, not as finding nothing', () => {
  const failed = describeStage({
    stage: 'collect', status: 'source', source: 'reddit',
    state: 'rate-limited', count: 0, error: 'HTTP 429',
  });
  assert.match(failed, /rate-limited/);
  assert.match(failed, /not searched successfully/);

  const empty = describeStage({
    stage: 'collect', status: 'source', source: 'reddit',
    state: 'no-results', count: 0,
  });
  assert.match(empty, /0 items \(no-results\)/);
  assert.doesNotMatch(empty, /not searched successfully/);
});

test('community resolution reports what it searched and what it rejected', () => {
  assert.match(
    describeStage({ stage: 'communities', status: 'done', subreddits: ['Truckers', 'CDL'] }),
    /r\/Truckers, r\/CDL/,
  );
  assert.match(
    describeStage({ stage: 'communities', status: 'done', subreddits: [] }),
    /no matching communities/,
  );
  assert.match(
    describeStage({ stage: 'communities', status: 'progress', probing: 'HVAC' }),
    /checking r\/HVAC/,
  );
});

test('extraction reports how much was set aside, not only what passed', () => {
  const line = describeStage({
    stage: 'extract', status: 'done',
    accepted: 54, setAside: 9, rejectedUnverifiedQuote: 2,
  });
  assert.match(line, /54 customer statements verified/);
  assert.match(line, /9 set aside/);
  assert.match(line, /2 quotes rejected/);
});
