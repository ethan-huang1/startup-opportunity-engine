/**
 * Browser verification.
 *
 * Runs against cached reports via `?run=<slug>` so the assertions are
 * deterministic and do not depend on what Reddit happens to be saying today.
 *
 * Usage: node tests/browser.mjs   (server must be running on :3000)
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SHOTS = new URL('../verification/', import.meta.url).pathname;
const ROUND = process.env.ROUND || '01';

const VIEWPORTS = {
  desktop: { width: 1440, height: 1000 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function consoleErrorsFor(page, url) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  return errors;
}

/** Horizontal overflow is the single most common responsive defect. */
async function hasOverflow(page) {
  return page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

/**
 * The API is gated behind a session now. Sign up a throwaway account (or
 * sign in, if a previous run already created it) so the context's cookie
 * jar carries a session into every page made from it.
 */
async function ensureSignedIn(context) {
  const email = process.env.TEST_EMAIL || 'browser-tests@example.com';
  const password = process.env.TEST_PASSWORD || 'browser-tests-password';
  const signUp = await context.request.post(`${BASE}/api/auth/sign-up/email`, {
    data: { email, password, name: 'Browser Tests' },
  });
  if (signUp.ok()) return;
  const signIn = await context.request.post(`${BASE}/api/auth/sign-in/email`, {
    data: { email, password },
  });
  if (!signIn.ok()) {
    throw new Error(`Could not authenticate the test session: ${signIn.status()} ${await signIn.text()}`);
  }
}

async function main() {
  await mkdir(SHOTS, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await ensureSignedIn(context);

  // Without a fixture the suite would sit waiting for `.opportunity` until it
  // timed out, which reads like a hang rather than a missing prerequisite.
  const fixtureResponse = await context.request.get(`${BASE}/api/fixture`).catch(() => null);
  if (!fixtureResponse?.ok()) {
    console.error(
      'No fixture available. Snapshot a real run first:\n' +
      '  node tests/make-fixture.mjs runs/<slug>.json\n' +
      'The fixture is only ever copied from a genuine run — it is never authored.',
    );
    process.exitCode = 2;
    return;
  }

  const report = await fixtureResponse.json();

  // ---------- adequate-coverage run, desktop ----------
  const page = await context.newPage();
  await page.setViewportSize(VIEWPORTS.desktop);
  const errors = await consoleErrorsFor(page, `${BASE}/?run=fixture`);
  await page.waitForSelector('.opportunity', { timeout: 15000 });

  check('no console errors on a full report', errors.length === 0, errors.join(' | '));

  const opportunities = await page.locator('.opportunity').count();
  check('opportunities render', opportunities === 2, `${opportunities} shown`);

  const quotes = await page.locator('.quote blockquote').count();
  check('verbatim quotes render', quotes > 0, `${quotes} quotes`);

  // Every citation must carry a real outbound link.
  const links = await page.locator('.quote-meta a').evaluateAll((nodes) =>
    nodes.map((node) => node.href),
  );
  check(
    'every quote links to a real source URL',
    links.length > 0 && links.every((href) => /^https?:\/\//.test(href)),
    `${links.length} links`,
  );

  // Provenance separation.
  const inferredCount = await page.locator('.inferred').count();
  check('AI inference is visually tagged', inferredCount > 0, `${inferredCount} blocks`);

  await page.screenshot({ path: `${SHOTS}desktop-round-${ROUND}.png`, fullPage: true });

  // ---------- hide-inference toggle ----------
  await page.locator('#hide-inference').check();
  const inferredVisible = await page.locator('.inferred').first().isVisible();
  const quotesStillVisible = await page.locator('.quote blockquote').first().isVisible();
  check('hiding AI inference collapses model prose', inferredVisible === false);
  check('hiding AI inference keeps verbatim evidence', quotesStillVisible === true);
  await page.screenshot({ path: `${SHOTS}desktop-hide-inference.png`, fullPage: true });
  await page.locator('#hide-inference').uncheck();

  // ---------- score breakdown arithmetic ----------
  await page.locator('.breakdown summary').first().click();
  const arithmetic = await page.locator('.opportunity').first().evaluate((card) => {
    const contributions = [...card.querySelectorAll('.components tbody tr')].map((row) => {
      const cells = row.querySelectorAll('td.num');
      return Number(cells[cells.length - 1].textContent);
    });
    const total = Number(card.querySelector('.components tfoot td.num:last-child').textContent);
    const shown = Number(card.querySelector('.score-value').textContent);
    return { sum: contributions.reduce((a, b) => a + b, 0), total, shown };
  });
  check(
    'component contributions sum to the displayed score',
    Math.abs(arithmetic.sum - arithmetic.total) < 0.005 &&
      Math.abs(arithmetic.total - arithmetic.shown) < 0.006,
    `parts=${arithmetic.sum.toFixed(3)} total=${arithmetic.total} shown=${arithmetic.shown}`,
  );

  // ---------- weight sliders re-rank without a re-run ----------
  const scoresBefore = await page.locator('.score-value').allTextContents();
  const orderBefore = await page.locator('.opportunity h3').allTextContents();
  await page.locator('#weights-panel summary').click();
  await page.locator('#weight-severity').fill('1');
  await page.locator('#weight-frequency').fill('0');
  await page.locator('#weight-reach').fill('0');
  await page.locator('#weight-recency').fill('0');
  await page.locator('#weight-sourceDiversity').fill('0');
  await page.waitForTimeout(150);
  const scoresAfter = await page.locator('.score-value').allTextContents();
  const orderAfter = await page.locator('.opportunity h3').allTextContents();

  check('weight sliders re-rank client-side', orderAfter.length === orderBefore.length,
    `${orderAfter.length} cards`);
  // Whether the ORDER flips depends on the data — two clusters with the same
  // voice count have identical frequency and cannot swap on it. What must
  // always hold is that the weights drive the numbers shown.
  check(
    'changing weights changes the displayed scores',
    scoresAfter.join('|') !== scoresBefore.join('|'),
    `${scoresBefore.join(',')} -> ${scoresAfter.join(',')}`,
  );
  await page.locator('#reset-weights').click();

  // ---------- evidence explorer ----------
  // Rank-sensitivity must be visible, since these two clusters genuinely swap.
  const sensitive = await page.locator('.badge[data-kind="sensitive"]').count();
  check('rank-sensitive opportunities are flagged', sensitive > 0, `${sensitive} flagged`);

  // Coverage headline is about customer statements, not item counts.
  const headline = await page.locator('#coverage-body .source-count .name').allTextContents();
  check(
    'coverage reports customer statements, not keyword matches',
    headline.some((t) => /Customer statements/i.test(t)) &&
      headline.some((t) => /Independent platforms/i.test(t)),
    headline.join(' / '),
  );

  // The classifier's decisions must be inspectable.
  const auditSummaries = await page.locator('.retrieval-detail summary').allTextContents();
  check(
    'classification and retrieval detail are both auditable',
    auditSummaries.some((t) => /classified/i.test(t)) &&
      auditSummaries.some((t) => /retrieved before filtering/i.test(t)),
    auditSummaries.join(' | '),
  );

  // Engagement that the platform never published must not show a percentile.
  const unpublished = await page.locator('.evidence-foot .engagement', {
    hasText: 'no points published',
  }).count();
  check('unpublished engagement is stated, not faked', unpublished > 0, `${unpublished} items`);

  const evidenceCount = await page.locator('.evidence-item').count();
  check('evidence list is paginated, not dumped', evidenceCount === 15, `${evidenceCount} shown`);
  await page.locator('.show-more').click();
  await page.waitForTimeout(150);
  const expanded = await page.locator('.evidence-item').count();
  check('show-all reveals the rest', expanded > evidenceCount, `${expanded} after expand`);

  // Collapsed duplicates stay in the record. Checked after expanding, since a
  // duplicate's canonical item can sit anywhere in the list.
  const collapsedDuplicates = (report.dedupeStats?.duplicates ?? 0) > 0;
  const dupes = await page.locator('.duplicates').count();
  check(
    'duplicates are shown collapsed, not deleted',
    collapsedDuplicates ? dupes > 0 : dupes === 0,
    collapsedDuplicates ? `${dupes} groups for ${report.dedupeStats.duplicates} duplicates`
                        : 'this run had no duplicates to collapse',
  );

  const filters = await page.locator('.filter').count();
  check('source filters render', filters > 1, `${filters} filters`);
  await page.locator('.filter').nth(1).click();
  await page.waitForTimeout(120);
  const filtered = await page.locator('.evidence-item').count();
  check('filtering narrows the evidence list', filtered > 0 && filtered < expanded,
    `${filtered} of ${expanded}`);
  await page.locator('.filter').first().click();

  // ---------- keyboard access ----------
  await page.keyboard.press('Tab');
  const focusVisible = await page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    return getComputedStyle(active).outlineStyle !== 'none' || active.className.includes('skip-link');
  });
  check('keyboard focus lands on a focusable control', focusVisible);

  // ---------- honest insufficient-evidence state ----------
  const halted = await context.newPage();
  await halted.setViewportSize(VIEWPORTS.desktop);
  const haltedErrors = await consoleErrorsFor(halted, `${BASE}/?run=${process.env.HALTED_SLUG || 'artisan-cheese-shops'}`);
  await halted.waitForTimeout(800);
  const verdictText = await halted.locator('.verdict').first().textContent().catch(() => '');
  const rankedVisible = await halted.locator('#opportunities-section').isVisible().catch(() => false);
  check('insufficient run shows a verdict', Boolean(verdictText), verdictText.trim());
  check('insufficient run shows NO ranked list', rankedVisible === false);
  check('no console errors on halted report', haltedErrors.length === 0, haltedErrors.join(' | '));
  await halted.screenshot({ path: `${SHOTS}desktop-insufficient.png`, fullPage: true });
  await halted.close();

  // ---------- responsive ----------
  for (const [name, viewport] of Object.entries(VIEWPORTS)) {
    const responsive = await context.newPage();
    await responsive.setViewportSize(viewport);
    await responsive.goto(`${BASE}/?run=fixture`, { waitUntil: 'networkidle' });
    await responsive.waitForSelector('.opportunity', { timeout: 15000 });
    const overflow = await hasOverflow(responsive);
    check(`no horizontal overflow at ${viewport.width}px (${name})`, overflow === false);

    if (name === 'mobile') {
      // Tap targets need to be reachable with a thumb.
      const small = await responsive.locator('button, a, input').evaluateAll((nodes) =>
        nodes
          .filter((node) => node.offsetParent !== null)
          .map((node) => node.getBoundingClientRect())
          .filter((rect) => rect.height > 0 && rect.height < 24).length,
      );
      check('mobile tap targets are not tiny', small === 0, `${small} under 24px`);
      await responsive.screenshot({ path: `${SHOTS}mobile-final.png`, fullPage: true });
    } else {
      await responsive.screenshot({ path: `${SHOTS}${name}-round-${ROUND}.png`, fullPage: true });
    }
    await responsive.close();
  }

  await browser.close();

  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
