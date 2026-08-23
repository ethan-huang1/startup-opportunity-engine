/**
 * Chain-integrity tests.
 *
 * These guard the property that a verbatim quote alone does not establish:
 * that the conclusion shown to a user is anchored, hop by hop, to evidence we
 * actually collected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { verifyReportChain } from '../lib/verify-chain.js';
import { makeEvidence } from '../lib/normalize.js';
import { WEIGHTS } from '../lib/config.js';

const ROOT = new URL('..', import.meta.url).pathname;

function evidence(id, overrides = {}) {
  return makeEvidence({
    id,
    source: overrides.source || 'reddit',
    kind: 'post',
    title: overrides.title ?? 'Scheduling keeps double booking us',
    body: overrides.body ?? 'Two techs get assigned the same slot and nobody is told.',
    url: overrides.url || `https://example.com/${id}`,
    author: overrides.author || `author-${id}`,
    publishedAt: overrides.publishedAt || '2026-07-20',
    primary: 10,
  });
}

function member(item, quote, overrides = {}) {
  return {
    evidenceId: overrides.evidenceId || item.id,
    pain: 'double booking',
    quote,
    severity: 'mentioned',
    source: overrides.source || item.source,
    voiceId: overrides.voiceId || item.voiceId,
    threadId: item.threadId,
    publishedAt: overrides.publishedAt || item.publishedAt,
  };
}

function report({ items, members, opportunity = {}, components, score }) {
  const comps = components || {
    frequency: 0.5, reach: 0.5, recency: 0.5, sourceDiversity: 0.5, severity: 0.5,
  };
  const total = score ?? (
    comps.frequency * WEIGHTS.frequency + comps.reach * WEIGHTS.reach +
    comps.recency * WEIGHTS.recency + comps.sourceDiversity * WEIGHTS.sourceDiversity +
    comps.severity * WEIGHTS.severity
  );
  return {
    weights: WEIGHTS,
    evidence: items,
    weakSignals: [],
    opportunities: [{
      id: 'cluster-1',
      label: 'double booking',
      members,
      components: comps,
      score: total,
      distinctVoices: new Set(members.map((m) => m.voiceId)).size,
      sourceTypes: [...new Set(members.map((m) => m.source))],
      opportunity: { name: 'Double booking', problem: 'Two techs, one slot.', ...opportunity },
    }],
  };
}

test('a well-formed report passes every hop', () => {
  const item = evidence('e1');
  const result = verifyReportChain(
    report({ items: [item], members: [member(item, 'Two techs get assigned the same slot')] }),
  );
  assert.equal(result.ok, true, result.problems.join(' | '));
  assert.equal(result.checked.quotes, 1);
});

test('catches a citation pointing at evidence that was never collected', () => {
  const item = evidence('e1');
  const bad = member(item, 'Two techs get assigned the same slot', { evidenceId: 'ghost' });
  const result = verifyReportChain(report({ items: [item], members: [bad] }));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /not in the evidence list/);
});

test('catches a quote that is not verbatim in the item it cites', () => {
  const item = evidence('e1');
  const result = verifyReportChain(
    report({ items: [item], members: [member(item, 'We would pay anything to fix this')] }),
  );
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /not verbatim/);
});

test('catches a quote stitched across the title and body boundary', () => {
  const item = evidence('e1', {
    title: 'Export is broken',
    body: 'for me every single time I try it.',
  });
  const result = verifyReportChain(
    report({ items: [item], members: [member(item, 'Export is broken for me every single time')] }),
  );
  assert.equal(result.ok, false, 'a sentence spanning two fields was never written');
  assert.match(result.problems.join(' '), /not verbatim/);
});

test('catches a quote re-attributed to a different voice', () => {
  const item = evidence('e1');
  const stolen = member(item, 'Two techs get assigned the same slot', {
    voiceId: 'reddit:user:someone-else',
  });
  const result = verifyReportChain(report({ items: [item], members: [stolen] }));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /voice .* does not match/);
});

test('catches a score that does not equal its published components', () => {
  const item = evidence('e1');
  const result = verifyReportChain(
    report({ items: [item], members: [member(item, 'Two techs get assigned the same slot')], score: 0.99 }),
  );
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /does not equal its components/);
});

test('catches an opportunity with no supporting members', () => {
  const result = verifyReportChain(report({ items: [evidence('e1')], members: [] }));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /no members/);
});

test('two subreddits are one platform, not two sources', () => {
  const a = makeEvidence({
    id: 'a', source: 'reddit-archive', kind: 'post', title: 't', body: 'we lose loads constantly',
    url: 'https://reddit.com/r/Truckers/comments/1', author: 'alice',
    container: 'r/Truckers', publishedAt: '2026-07-20', primary: 5,
  });
  const b = makeEvidence({
    id: 'b', source: 'reddit-archive', kind: 'post', title: 't', body: 'we lose loads constantly',
    url: 'https://reddit.com/r/FreightBrokers/comments/2', author: 'bob',
    container: 'r/FreightBrokers', publishedAt: '2026-07-21', primary: 5,
  });
  const built = report({
    items: [a, b],
    members: [member(a, 'we lose loads constantly'), member(b, 'we lose loads constantly')],
  });
  // Declared as one platform — the verifier must agree.
  built.opportunities[0].sourceTypes = ['reddit'];
  const result = verifyReportChain(built);
  assert.equal(result.ok, true, result.problems.join(' | '));
});

test('catches a cluster claiming more platforms than its members have', () => {
  const item = evidence('e1');
  const built = report({ items: [item], members: [member(item, 'Two techs get assigned the same slot')] });
  built.opportunities[0].sourceTypes = ['reddit', 'github'];
  const result = verifyReportChain(built);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /declares platforms/);
});

test('the committed fixture passes chain verification', async () => {
  let fixture;
  try {
    fixture = JSON.parse(await readFile(join(ROOT, 'fixtures/sample-report.json'), 'utf8'));
  } catch {
    // Before the first snapshot there is nothing to check, and inventing one
    // here is exactly what went wrong last time.
    return;
  }
  const result = verifyReportChain(fixture);
  assert.equal(result.ok, true, `fixture chain is broken:\n${result.problems.join('\n')}`);
  assert.ok(fixture.fixtureSource, 'fixture must record the run it came from');
  assert.ok(fixture.opportunities.length > 0, 'fixture must exercise the ranked UI');
});

test('every cached run passes chain verification', async () => {
  let files = [];
  try {
    files = (await readdir(join(ROOT, 'runs'))).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  for (const name of files) {
    const run = JSON.parse(await readFile(join(ROOT, 'runs', name), 'utf8'));
    const result = verifyReportChain(run);
    assert.equal(result.ok, true, `${name} chain is broken:\n${result.problems.join('\n')}`);
  }
});
