/**
 * Pain-point extraction — the one place the AI is allowed near the evidence,
 * and the place the whole design's honesty depends on.
 *
 * The model reads evidence items and reports problems people describe. Crucially
 * it must return, for every pain point, a quote that we then verify appears
 * *verbatim in that specific item's stored text*. Quotes that fail verification
 * are dropped and counted. That check is what stops the pipeline from turning
 * into an idea generator: a pain point cannot exist downstream unless a real
 * person wrote a real sentence saying it, in a source we can link and date.
 *
 * The model is never told the market's "opportunities" or asked to be creative.
 * It is asked to report what is already on the page.
 *
 * It also answers a second, separate question: what KIND of statement each one
 * is. Authenticity and evidentiary value are different things — a trucking run
 * turned the real headline fragment "So Is a Truck" into a customer pain point,
 * and a developer's own acceptance criteria into a complaint. Both quotes were
 * genuine. Only `first_hand_problem` and `reported_problem` go on to clustering
 * and ranking; everything else is set aside *with its reason* rather than
 * deleted, so the filtering can be inspected. See lib/evidence-type.js.
 */

import { askForJson } from './claude.js';
import { evidenceText } from './normalize.js';
import { MODELS } from './config.js';
import {
  ALL_CATEGORIES,
  countsAsEvidence,
  evidenceSignals,
  normalizeCategory,
} from './evidence-type.js';

const BATCH_SIZE = 10;

/**
 * A single headless `claude` call takes roughly 60-90 seconds, so batches run
 * concurrently. Kept modest because each one spawns a full CLI process.
 */
const CONCURRENCY = 3;

/** Runs tasks with a bounded number in flight, preserving result order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function pump() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => pump()),
  );
  return results;
}

/** Collapses whitespace so formatting differences don't fail a real quote. */
function normalizeForMatch(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The verbatim gate.
 *
 * Returns true only when the quote genuinely occurs in one contiguous field of
 * the item. Whitespace is normalized (sources vary in line wrapping) but
 * nothing else is: a paraphrase, a merged sentence, or a quote borrowed from a
 * different item all fail here, which is the point.
 *
 * Title and body are checked SEPARATELY and never as one joined string. Joining
 * them let a quote span the boundary — a post titled "Export is broken" with a
 * body starting "for me every single time" would validate the sentence "Export
 * is broken for me every single time", which nobody wrote. Requiring the quote
 * to sit inside a single field closes that.
 *
 * @param {string} quote candidate quote from the model
 * @param {...string} fields the item's own fields, checked independently
 */
export function quoteIsVerbatim(quote, ...fields) {
  if (!quote || quote.trim().length < 12) return false;
  const needle = normalizeForMatch(quote);
  return fields.some((field) => field && normalizeForMatch(field).includes(needle));
}

function buildPrompt(market, batch) {
  const documents = batch
    .map((item, index) => {
      const text = evidenceText(item);
      const signals = evidenceSignals(item);
      return [
        `--- DOCUMENT ${index + 1} ---`,
        `id: ${item.id}`,
        `source: ${item.source}${item.container ? ` (${item.container})` : ''}`,
        signals.length ? `hints (may be wrong — judge the text yourself): ${signals.join('; ')}` : null,
        `text:`,
        text.slice(0, 6000),
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');

  return `You are reading real public posts and comments gathered while researching the market: "${market}".

Your job is to REPORT problems that people in these documents actually describe, and to say what KIND of statement each one is. You are not brainstorming, not evaluating business ideas, and not suggesting solutions.

For each distinct problem someone describes, output an object with:
- "id": the exact id of the document it came from
- "pain": a short neutral phrase naming the problem (under 12 words), written by you
- "quote": a sentence or clause copied EXACTLY, character for character, from that document's text
- "category": one of
    "first_hand_problem"  = someone in this market — a worker, operator, buyer, or
                            customer of "${market}" — describing a problem they
                            themselves hit in that context
    "reported_problem"    = someone relaying a problem that people in this market hit
                            (a maintainer summarising user reports, a journalist quoting
                            affected people, a support write-up)
    "proposed_solution"   = a feature request, spec, acceptance criterion, or plan for
                            what should be built
    "promotional"         = a launch, tool submission, self-promotion, or announcement
    "incidental"          = anything else, INCLUDING a completely genuine, clearly
                            described problem that is simply not about this market or
                            the people in it
- "severity": one of "mentioned", "workaround", "paying", "blocked"
    "mentioned"  = states the problem
    "workaround" = describes a manual or hacky way they cope
    "paying"     = pays for something, or would pay, to solve it
    "blocked"    = abandoned the task, churned, or lost work/money

HOW TO CATEGORISE — read the text, not the surface form:
- FIRST ASK: is this person in the market "${market}", or serving it, or buying from it?
  If not, the category is "incidental" no matter how real or well-described their problem
  is. Searching for "trucking" turns up genuine bug reports from a PDF library, an agent
  framework, and a writing tool. Those are real first-hand problems for their authors and
  they are "incidental" here, because none of those people are in trucking. Three of them
  were nearly ranked as a trucking opportunity.
- Judge by what the statement DOES, not how it is worded. "Fix your billing page, it has
  charged me twice" is a first-hand problem even though it opens with an instruction.
  A complaint written as "the app crashes on export" with no "I" is still first-hand.
- A statement is a proposed_solution when its substance is what should be BUILT, even if
  it mentions a problem as justification. "Add HOS tracking so drivers cannot violate
  limits" is a proposed_solution.
- A "hints" line may appear above a document. Those are mechanical guesses and are often
  wrong. Use them as a prompt to look closely, never as the answer.

RULES THAT MATTER MORE THAN COVERAGE:
1. The "quote" must be copied verbatim from that document. Do not fix typos, do not join separate sentences, do not shorten with ellipses. It is automatically checked against the source text and discarded if it does not match exactly.
2. Never take a quote from one document and attach it to another document's id.
3. Only report a problem if the document actually describes one. Announcements, release notes, job postings, and general discussion often contain none.
4. Returning an empty array is a correct and expected answer. Do not invent problems to fill space.
5. Categorise honestly. A wrong "first_hand_problem" is worse than a correct "incidental" — everything you mark as first-hand or reported is treated as real customer evidence.

Documents:

${documents}

Reply with raw JSON only: an array of objects. If no document describes a problem, reply with [].`;
}

/**
 * @param {string} market the user's query
 * @param {Array} items unique (non-duplicate) evidence records
 * @param {{onProgress?: Function}} options
 * @returns {{mentions: Array, stats: object}}
 */
export async function extractPainPoints(market, items, { onProgress } = {}) {
  const withText = items.filter((item) => evidenceText(item).length >= 40);
  const byId = new Map(withText.map((item) => [item.id, item]));

  const batches = [];
  for (let i = 0; i < withText.length; i += BATCH_SIZE) {
    batches.push(withText.slice(i, i + BATCH_SIZE));
  }

  const mentions = [];
  // Everything the classifier set aside, kept with its reason so the filtering
  // can be audited instead of trusted. Over-filtering must be visible.
  const setAside = [];
  const stats = {
    itemsConsidered: withText.length,
    batches: batches.length,
    returned: 0,
    rejectedUnverifiedQuote: 0,
    rejectedUnknownId: 0,
    rejectedUnknownCategory: 0,
    failedBatches: 0,
    byCategory: Object.fromEntries(ALL_CATEGORIES.map((name) => [name, 0])),
  };

  let completed = 0;
  const responses = await mapWithConcurrency(batches, CONCURRENCY, async (batch) => {
    try {
      return await askForJson(buildPrompt(market, batch), { model: MODELS.extract });
    } catch {
      // One failed batch must not sink the run; it means less evidence, and the
      // run reports that rather than pretending it saw everything.
      return null;
    } finally {
      completed += 1;
      onProgress?.({ batch: completed, of: batches.length });
    }
  });

  for (const response of responses) {
    if (response === null) {
      stats.failedBatches += 1;
      continue;
    }

    const rows = Array.isArray(response) ? response : response?.results || [];
    for (const row of rows) {
      stats.returned += 1;

      const item = byId.get(row?.id);
      if (!item) {
        stats.rejectedUnknownId += 1;
        continue;
      }
      if (!quoteIsVerbatim(row.quote, item.title, item.body)) {
        stats.rejectedUnverifiedQuote += 1;
        continue;
      }

      const category = normalizeCategory(row.category);
      if (!category) {
        // An unrecognised category is not a licence to treat it as evidence.
        stats.rejectedUnknownCategory += 1;
        continue;
      }
      stats.byCategory[category] += 1;

      const mention = {
        evidenceId: item.id,
        pain: String(row.pain || '').trim(),
        quote: String(row.quote).trim(),
        category,
        signals: evidenceSignals(item, row.quote),
        severity: ['mentioned', 'workaround', 'paying', 'blocked'].includes(row.severity)
          ? row.severity
          : 'mentioned',
        // Carried forward so scoring never has to re-join against evidence.
        source: item.source,
        container: item.container,
        voiceId: item.voiceId,
        threadId: item.threadId,
        publishedAt: item.publishedAt,
      };

      if (countsAsEvidence(category)) {
        mentions.push(mention);
      } else {
        setAside.push(mention);
      }
    }
  }

  stats.accepted = mentions.length;
  stats.setAside = setAside.length;
  stats.rejectionRate =
    stats.returned > 0
      ? (stats.returned - stats.accepted) / stats.returned
      : 0;

  return { mentions, setAside, stats };
}
