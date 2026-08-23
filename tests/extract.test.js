import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quoteIsVerbatim } from '../lib/extract.js';

const SOURCE_TEXT =
  'We tried three different scheduling tools this year.\n\n' +
  'Every one of them breaks when two technicians are assigned to the same ' +
  'job, and we end up calling customers to apologise.';

test('accepts a quote copied exactly from the source', () => {
  assert.ok(
    quoteIsVerbatim(
      'Every one of them breaks when two technicians are assigned to the same job',
      SOURCE_TEXT,
    ),
  );
});

test('accepts a quote whose line wrapping differs from the source', () => {
  assert.ok(
    quoteIsVerbatim(
      'We tried three different\n   scheduling tools this year.',
      SOURCE_TEXT,
    ),
  );
});

test('rejects a paraphrase', () => {
  assert.equal(
    quoteIsVerbatim(
      'All of the tools break when you assign two technicians to one job',
      SOURCE_TEXT,
    ),
    false,
  );
});

test('rejects a fabricated quote that was never in the source', () => {
  assert.equal(
    quoteIsVerbatim('We would happily pay $500 a month to fix this', SOURCE_TEXT),
    false,
  );
});

test('rejects a quote with words silently inserted', () => {
  assert.equal(
    quoteIsVerbatim(
      'Every one of them completely breaks when two technicians are assigned',
      SOURCE_TEXT,
    ),
    false,
  );
});

test('rejects two real sentences stitched together across a gap', () => {
  assert.equal(
    quoteIsVerbatim(
      'We tried three different scheduling tools this year. and we end up calling customers',
      SOURCE_TEXT,
    ),
    false,
  );
});

test('rejects a quote borrowed from a different document', () => {
  const otherDocument = 'Our invoicing software double bills clients every month.';
  assert.equal(
    quoteIsVerbatim('Our invoicing software double bills clients', SOURCE_TEXT),
    false,
  );
  assert.ok(quoteIsVerbatim('Our invoicing software double bills clients', otherDocument));
});

test('rejects trivially short quotes that would match almost anything', () => {
  assert.equal(quoteIsVerbatim('breaks', SOURCE_TEXT), false);
  assert.equal(quoteIsVerbatim('', SOURCE_TEXT), false);
  assert.equal(quoteIsVerbatim(null, SOURCE_TEXT), false);
});

test('a quote may not be assembled by gluing the title onto the body', () => {
  // Joining title and body into one haystack let the model return a sentence
  // that exists in neither field on its own. Each field is checked separately.
  const title = 'Export is broken';
  const body = 'for me every single time I try it on the desktop build.';

  assert.equal(
    quoteIsVerbatim('Export is broken for me every single time', title, body),
    false,
    'this sentence was never written by anyone',
  );
  assert.ok(quoteIsVerbatim('every single time I try it on the desktop', title, body));
});

test('a quote wholly inside the title is still valid evidence', () => {
  assert.ok(
    quoteIsVerbatim(
      'Scheduling breaks with two technicians',
      'Scheduling breaks with two technicians on one job',
      '',
    ),
  );
});
