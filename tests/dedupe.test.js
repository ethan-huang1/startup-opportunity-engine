import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dedupe, uniqueItems } from '../lib/dedupe.js';
import { makeEvidence, canonicalUrl } from '../lib/normalize.js';

function evidence(overrides) {
  return makeEvidence({
    id: overrides.id,
    source: overrides.source || 'reddit',
    kind: 'post',
    title: overrides.title || '',
    body: overrides.body || '',
    url: overrides.url || `https://example.com/${overrides.id}`,
    author: overrides.author ?? null,
    container: overrides.container ?? 'r/test',
    publishedAt: overrides.publishedAt || '2026-07-20',
    primary: overrides.primary ?? 0,
  });
}

test('canonicalUrl strips tracking params, www, and trailing slashes', () => {
  assert.equal(
    canonicalUrl('https://www.example.com/post/?utm_source=x&ref=y'),
    'https://example.com/post',
  );
  assert.equal(canonicalUrl('http://m.example.com/a/#section'), 'https://example.com/a');
});

test('layer 1: identical URLs collapse to one', () => {
  const { items, stats } = dedupe([
    evidence({ id: 'a', title: 'Export is broken', url: 'https://example.com/x?utm_source=rss' }),
    evidence({ id: 'b', title: 'Export is broken', url: 'https://www.example.com/x/' }),
  ]);
  assert.equal(stats.unique, 1);
  assert.equal(stats.url, 1);
  assert.equal(uniqueItems(items).length, 1);
});

test('layer 3: near-identical text collapses even from different authors', () => {
  const body =
    'I have been trying to export my notes for weeks and the export button ' +
    'silently fails every single time with no error message at all.';
  const { stats } = dedupe([
    evidence({ id: 'a', title: 'Export fails', body, author: 'alice' }),
    evidence({ id: 'b', title: 'Export fails', body: `${body} Anyone else?`, author: 'bob' }),
  ]);
  assert.equal(stats.unique, 1);
  assert.equal(stats.nearDuplicate, 1);
});

test('layer 4a: same author crossposting to another subreddit collapses', () => {
  // Reworded enough (0.61) to slip past the 0.75 near-duplicate threshold, so
  // this exercises the crosspost rule rather than layer 3.
  const { items, stats } = dedupe([
    evidence({
      id: 'a',
      body:
        'My team keeps losing track of which invoice was already sent to which ' +
        'client and we end up double billing people, which is embarrassing.',
      author: 'sameperson',
      container: 'r/smallbusiness',
    }),
    evidence({
      id: 'b',
      body:
        'My crew keeps losing track of which invoice was already sent to which ' +
        'customer and we end up double charging people, which is awkward.',
      author: 'SamePerson',
      container: 'r/freelance',
      publishedAt: '2026-07-22',
    }),
  ]);
  assert.equal(stats.unique, 1);
  assert.equal(stats.crosspost, 1);
  const duplicate = items.find((item) => item.id === 'b');
  assert.equal(duplicate.duplicateOf, 'a');
  assert.match(duplicate.dedupeReason, /Crosspost/);
});

test('layer 4b: syndicated copy sharing a long verbatim passage collapses', () => {
  const passage =
    'the scheduling system we rely on cannot handle two technicians being ' +
    'assigned to the same job site on the same afternoon and it silently ' +
    'overwrites the second assignment without warning anyone involved at all ' +
    'which means someone drives out for nothing and we lose the entire slot';
  const { stats } = dedupe([
    evidence({ id: 'a', body: `Original complaint. ${passage}`, author: 'alice' }),
    evidence({
      id: 'b',
      body:
        'Reposting something I saw elsewhere because it matches our experience ' +
        `exactly and deserves more attention than it got. ${passage} ` +
        'Completely different closing thoughts from a different author entirely.',
      author: 'bob',
      container: 'r/other',
      publishedAt: '2026-07-25',
    }),
  ]);
  assert.equal(stats.syndication, 1);
  assert.equal(stats.unique, 1);
});

test('genuinely distinct complaints must NOT collapse', () => {
  const { stats } = dedupe([
    evidence({
      id: 'a',
      title: 'Export to CSV silently truncates at 1000 rows',
      body: 'Every export I run stops at exactly one thousand rows with no warning.',
      author: 'alice',
    }),
    evidence({
      id: 'b',
      title: 'Mobile app logs me out every few hours',
      body: 'I have to re-authenticate constantly on my phone and it loses my draft.',
      author: 'bob',
    }),
    evidence({
      id: 'c',
      title: 'No way to share a note with a client without an account',
      body: 'Clients refuse to sign up just to read one page I sent them.',
      author: 'carol',
    }),
  ]);
  assert.equal(stats.unique, 3);
  assert.equal(stats.duplicates, 0);
});

test('duplicates are marked, never removed from the record', () => {
  const body = 'The billing page times out whenever I have more than fifty line items on it.';
  const { items } = dedupe([
    evidence({ id: 'a', body, author: 'alice' }),
    evidence({ id: 'b', body, author: 'bob' }),
  ]);
  assert.equal(items.length, 2, 'both items still present');
  assert.equal(uniqueItems(items).length, 1, 'only one counts toward evidence');
  assert.ok(items.some((item) => item.dedupeReason), 'duplicate carries a reason');
});

test('distinct comments on one thread survive despite a shared parent title', () => {
  // Regression: comments inherit their post's title for display. Comparing
  // title+body made every sibling look like a copy of the others, which wiped
  // out eight genuinely different complaints from one real Reddit thread.
  const sharedTitle =
    'Just wanted to share my Kept, an open source self-hosted Google Keep ' +
    'style app I have built for people who love the original but want to own ' +
    'their own data and run it themselves on their own hardware at home';

  const comment = (id, body) =>
    makeEvidence({
      id,
      source: 'reddit',
      kind: 'comment',
      title: sharedTitle,
      body,
      url: `https://reddit.com/r/x/comments/1/comment/${id}`,
      author: id,
      container: 'r/GoogleKeep',
      publishedAt: '2026-07-29',
      threadId: 'reddit:post:1',
      parentId: 'reddit:post:1',
    });

  const { stats } = dedupe([
    comment('c1', 'One of my biggest frustrations is that it lacks a list view with latest notes at the top.'),
    comment('c2', 'A folder feature would be great, with a main folder holding several sub folders inside.'),
    comment('c3', 'Something I always wanted was a smarter version of location based reminders.'),
    comment('c4', 'Is there any way to import everything I already have via Google Takeout?'),
  ]);

  assert.equal(stats.unique, 4, 'four distinct complaints must all survive');
  assert.equal(stats.duplicates, 0);
});

test('a reply quoting its parent post stays as a separate voice', () => {
  const passage =
    'the scheduling system cannot handle two technicians assigned to the same ' +
    'job site on the same afternoon and it silently overwrites the second ' +
    'assignment without warning anyone which means someone drives out for nothing';

  const { stats } = dedupe([
    makeEvidence({
      id: 'post',
      source: 'reddit', kind: 'post', title: 'Scheduling problems',
      body: passage, url: 'https://reddit.com/r/x/comments/1',
      author: 'alice', container: 'r/x', publishedAt: '2026-07-01',
      threadId: 'reddit:post:1',
    }),
    makeEvidence({
      id: 'reply',
      source: 'reddit', kind: 'comment', title: 'Scheduling problems',
      body: `Quoting you: ${passage} — this is exactly what happens to us every week without fail.`,
      url: 'https://reddit.com/r/x/comments/1/comment/2',
      author: 'bob', container: 'r/x', publishedAt: '2026-07-02',
      threadId: 'reddit:post:1', parentId: 'reddit:post:1',
    }),
  ]);

  assert.equal(stats.syndication, 0, 'quoting within a thread is conversation');
  assert.equal(stats.unique, 2);
});

test('the earlier item survives and the later one is marked derivative', () => {
  const body = 'Invoices export with the wrong tax column and we fix it by hand every month.';
  const { items } = dedupe([
    evidence({ id: 'later', body, publishedAt: '2026-07-28', author: 'bob' }),
    evidence({ id: 'earlier', body, publishedAt: '2026-07-01', author: 'alice' }),
  ]);
  assert.equal(items.find((item) => item.id === 'later').duplicateOf, 'earlier');
  assert.equal(items.find((item) => item.id === 'earlier').duplicateOf, null);
});
