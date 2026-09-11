import {
  PROGRESS_NOTE,
  formatElapsed,
  progressState,
  describeStage,
} from './progress-model.js';

/**
 * Client for the opportunity engine.
 *
 * The rendering rule this file exists to enforce: every string on screen is
 * either something a person wrote (quoted verbatim, linked, dated), something
 * the code computed (shown with its arithmetic), or something the model wrote
 * (visibly tagged and collapsible). Nothing is displayed without one of those
 * three provenances.
 */

const SOURCE_LABELS = {
  reddit: 'Reddit search',
  'reddit-archive': 'Reddit communities',
  hackernews: 'Hacker News',
  github: 'GitHub',
};
const COMPONENT_LABELS = {
  frequency: 'Frequency',
  reach: 'Reach',
  recency: 'Recency',
  sourceDiversity: 'Source diversity',
  severity: 'Severity',
};
const COMPONENT_MEANING = {
  frequency: 'How many different people raised it',
  reach: 'How much their posts were engaged with, ranked within each source',
  recency: 'How recently, across the 30-day window',
  sourceDiversity: 'How many different sources it appeared in',
  severity: 'How badly it affects them, read from their wording',
};

const state = {
  report: null,
  weights: null,
  evidenceFilter: 'all',
  evidenceExpanded: false,
};

const $ = (id) => document.getElementById(id);

/** Everything user- or model-supplied goes through here before reaching the DOM. */
function text(value) {
  return document.createTextNode(String(value ?? ''));
}

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value ?? '');
    else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? text(child) : child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Tidies markdown syntax for the evidence *preview* only.
 *
 * GitHub issue bodies arrive full of `###`, `**`, and link syntax, which reads
 * as noise in a summary line. This is display sugar and is deliberately never
 * applied to quotes: those are the evidence, and they are shown exactly as the
 * person wrote them.
 */
function tidyPreview(markdown) {
  return (markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/[*_`>]+/g, '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------------------------------------------------------- progress */

let elapsedTimer = null;
let runStartedAt = null;

function startElapsedClock() {
  runStartedAt = Date.now();
  stopElapsedClock();
  // Ticks every second so the page visibly keeps moving during the long,
  // quiet stretches where the model is thinking and nothing else changes.
  elapsedTimer = setInterval(() => {
    const node = $('elapsed');
    if (node) node.textContent = formatElapsed(Date.now() - runStartedAt);
  }, 1000);
}

function stopElapsedClock() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function renderProgress(events) {
  const status = $('status');
  clear(status);
  status.hidden = false;

  const { halted, heading, steps } = progressState(events);

  status.appendChild(
    el('div', { class: 'progress-head' }, [
      el('span', { class: 'progress-stage', text: heading }),
      el('span', { class: 'progress-elapsed' }, [
        'elapsed ',
        el('span', {
          id: 'elapsed',
          text: formatElapsed(Date.now() - (runStartedAt || Date.now())),
        }),
      ]),
    ]),
  );

  // A step track, not a percentage bar: it marks which stages are finished and
  // never implies we know how far through the current one we are.
  const track = el('ol', { class: 'stage-track' });
  for (const step of steps) {
    track.appendChild(
      el('li', { class: 'stage-step', 'data-state': step.state }, [
        el('span', { class: 'stage-name', text: step.label }),
        el('span', { class: 'stage-detail', text: describeStage(step.event) }),
      ]),
    );
  }
  status.appendChild(track);

  if (!halted) {
    status.appendChild(el('p', { class: 'progress-note', text: PROGRESS_NOTE }));
  }
}

/* ---------------------------------------------------------------- coverage */

const STEP_LABELS = {
  ok: 'completed',
  partial: 'partly failed',
  failed: 'failed',
  fallback: 'fell back to text similarity',
  skipped: 'not reached',
};

/**
 * Renders the run's health, separately from its findings.
 *
 * A run that collected 115 discussions and then failed to read every one of
 * them once reported "insufficient customer evidence" — a statement about the
 * market that the run had not earned. Collection, extraction, and grouping
 * failures are shown apart from results so that never reads as a finding again.
 */
function renderAnalysis(analysis) {
  const banner = $('analysis-banner');
  if (!analysis || analysis.state === 'complete') {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  banner.dataset.state = analysis.state;
  $('analysis-headline').textContent = analysis.headline;
  $('analysis-explanation').textContent = analysis.explanation;

  const steps = $('analysis-steps');
  clear(steps);

  const rows = [
    ['Collecting discussions', analysis.collection.state,
      `${analysis.collection.itemsRetrieved} items retrieved`],
    ['Reading them for problems', analysis.extraction.state,
      analysis.extraction.batches
        ? `${analysis.extraction.batches - analysis.extraction.failedBatches} of ` +
          `${analysis.extraction.batches} batches read`
        : 'not run'],
    ['Grouping related problems', analysis.grouping.state, ''],
  ];

  for (const [label, state, detail] of rows) {
    steps.appendChild(
      el('li', { 'data-state': state }, [
        el('span', { class: 'analysis-step-name', text: label }),
        el('span', { class: 'analysis-step-state', text: STEP_LABELS[state] || state }),
        detail ? el('span', { class: 'analysis-step-detail', text: detail }) : null,
      ]),
    );
  }
}

function renderCoverage(coverage, retrieval, subreddits) {
  const body = $('coverage-body');
  clear(body);

  body.appendChild(
    el('span', {
      class: 'verdict',
      'data-verdict': coverage.verdict,
      text: coverage.verdict === 'unknown' ? 'not determined' : coverage.verdict,
    }),
  );
  body.appendChild(el('p', { class: 'coverage-explanation', text: coverage.explanation }));

  // Nothing was measured, so there are no figures to print.
  if (coverage.verdict === 'unknown') return;

  // Headline numbers are about verified customer statements, not item counts.
  const figures = el('div', { class: 'source-counts' }, [
    el('div', { class: 'source-count' }, [
      el('div', { class: 'name' }, ['Customer statements']),
      el('div', { class: 'count', text: coverage.statements ?? 0 }),
      el('div', { class: 'state', text: 'first-hand or directly reported' }),
    ]),
    el('div', { class: 'source-count' }, [
      el('div', { class: 'name' }, ['Distinct people']),
      el('div', { class: 'count', text: coverage.distinctVoices ?? 0 }),
      el('div', { class: 'state', text: 'one person counts once' }),
    ]),
    el('div', { class: 'source-count' }, [
      el('div', { class: 'name' }, ['Independent platforms']),
      el('div', { class: 'count', text: (coverage.platforms || []).length }),
      el('div', {
        class: 'state',
        text: (coverage.platforms || []).length > 0
          ? (coverage.platforms || []).map((p) => SOURCE_LABELS[p] || p).join(', ')
          : 'none',
      }),
    ]),
  ]);
  body.appendChild(figures);

  if (subreddits?.length) {
    body.appendChild(
      el('p', {
        class: 'thresholds',
        text:
          `Communities searched: ${subreddits.map((s) => `r/${s}`).join(', ')}. ` +
          'These are separate communities on one platform — they corroborate each ' +
          'other less than two different platforms would.',
      }),
    );
  }

  // What was retrieved, kept visibly separate from what qualified.
  if (retrieval) {
    const detail = el('details', { class: 'retrieval-detail' }, [
      el('summary', { text: `What was retrieved before filtering (${retrieval.totalInWindow} items)` }),
    ]);
    const grid = el('div', { class: 'source-counts' });
    for (const source of retrieval.perSource) {
      grid.appendChild(
        el('div', { class: 'source-count', 'data-degraded': String(source.degraded) }, [
          el('div', { class: 'name' }, [
            el('span', { class: 'dot', 'data-source': source.source }),
            source.label,
          ]),
          el('div', { class: 'count', text: source.itemsInWindow }),
          el('div', {
            class: 'state',
            text: source.degraded
              ? `${source.state} — count understates what exists${source.error ? `: ${source.error}` : ''}`
              : `${source.state} · ${source.itemsReturned} before filtering`,
          }),
        ]),
      );
    }
    detail.appendChild(grid);
    detail.appendChild(
      el('p', {
        class: 'thresholds',
        text:
          'Item count is not evidence of coverage. A market can return dozens of ' +
          'keyword matches and contain no customer describing a problem, which is ' +
          'why the verdict above is computed from verified statements instead.',
      }),
    );
    body.appendChild(detail);
  }

  // Audit view: what the classifier set aside, and why.
  const perCategory = coverage.perCategory || {};
  const labels = coverage.categoryLabels || {};
  if (Object.keys(perCategory).length > 0) {
    const audit = el('details', { class: 'retrieval-detail' }, [
      el('summary', { text: `How statements were classified (${coverage.setAsideCount ?? 0} set aside)` }),
    ]);
    const list = el('ul', { class: 'category-list' });
    for (const [category, count] of Object.entries(perCategory).sort((a, b) => b[1] - a[1])) {
      const counts = category === 'first_hand_problem' || category === 'reported_problem';
      list.appendChild(
        el('li', { 'data-counts': String(counts) }, [
          el('span', { class: 'category-count', text: count }),
          el('span', { text: labels[category] || category }),
          el('span', { class: 'category-note', text: counts ? 'counts as evidence' : 'set aside' }),
        ]),
      );
    }
    audit.appendChild(list);
    audit.appendChild(
      el('p', {
        class: 'thresholds',
        text:
          'Only first-hand and directly reported problems are ranked. Set-aside ' +
          'items are kept, not deleted, so over-filtering is visible here rather ' +
          'than hidden. Nothing is rejected merely for lacking first-person ' +
          'wording or for beginning with an instruction.',
      }),
    );
    body.appendChild(audit);
  }

  body.appendChild(
    el('p', {
      class: 'thresholds',
      text:
        `Thresholds used: under ${coverage.thresholds?.insufficientBelowStatements ?? 8} ` +
        `customer statements, under ${coverage.thresholds?.insufficientBelowVoices ?? 6} ` +
        `distinct people, or fewer than ${coverage.thresholds?.minPlatforms ?? 2} independent ` +
        'platforms stops the run. These are judgment calls, not science — the counts ' +
        'above are what matter.',
    }),
  );
}

/* ----------------------------------------------------------- opportunities */

function scoreOf(cluster, weights) {
  const c = cluster.components;
  return (
    c.frequency * weights.frequency +
    c.reach * weights.reach +
    c.recency * weights.recency +
    c.sourceDiversity * weights.sourceDiversity +
    c.severity * weights.severity
  );
}

function evidenceById(id) {
  return state.report.evidence.find((item) => item.id === id);
}

function renderQuote(member) {
  const item = evidenceById(member.evidenceId);
  const meta = el('div', { class: 'quote-meta' }, [
    el('span', { class: 'severity', 'data-level': member.severity, text: member.severity }),
    el('span', { text: SOURCE_LABELS[member.source] || member.source }),
    item?.container ? el('span', { text: item.container }) : null,
    el('span', { text: member.publishedAt || 'undated' }),
    item?.engagementText ? el('span', { class: 'engagement', text: item.engagementText }) : null,
    item?.url
      ? el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', text: 'View source ↗' })
      : null,
  ]);

  return el('li', { class: 'quote' }, [
    el('blockquote', { text: `“${member.quote}”` }),
    meta,
  ]);
}

function renderBreakdown(cluster, weights, total) {
  const rows = Object.keys(COMPONENT_LABELS).map((key) => {
    const value = cluster.components[key];
    const weight = weights[key];
    return el('tr', {}, [
      el('td', {}, [
        el('div', { text: COMPONENT_LABELS[key] }),
        el('div', { class: 'ai-flag', text: key === 'severity' ? 'AI-derived' : '' }),
        el('div', { style: 'font-size:12px;color:var(--ink-faint)', text: COMPONENT_MEANING[key] }),
      ]),
      el('td', { class: 'num', text: value.toFixed(3) }),
      el('td', { class: 'num', text: `× ${weight.toFixed(2)}` }),
      el('td', { class: 'num', text: (value * weight).toFixed(3) }),
    ]);
  });

  const table = el('table', { class: 'components' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Component' }),
        el('th', { class: 'num', text: 'Value' }),
        el('th', { class: 'num', text: 'Weight' }),
        el('th', { class: 'num', text: 'Contribution' }),
      ]),
    ]),
    el('tbody', {}, rows),
    el('tfoot', {}, [
      el('tr', {}, [
        el('td', { text: 'Evidence Strength' }),
        el('td', { class: 'num', text: '' }),
        el('td', { class: 'num', text: '' }),
        el('td', { class: 'num', text: total.toFixed(3) }),
      ]),
    ]),
  ]);

  return el('details', { class: 'breakdown' }, [
    el('summary', { text: 'How this score was computed' }),
    el('div', { class: 'table-scroll' }, [table]),
  ]);
}

function renderOpportunity(cluster, index, weights) {
  const total = scoreOf(cluster, weights);
  const opportunity = cluster.opportunity;

  const head = el('div', { class: 'opportunity-head' }, [
    el('div', { class: 'rank', text: `#${index + 1}` }),
    el('div', { class: 'opportunity-title' }, [
      el('h3', { text: opportunity?.name || cluster.label }),
      opportunity?.customer ? el('p', { class: 'customer', text: opportunity.customer }) : null,
    ]),
    el('div', { class: 'score-block' }, [
      el('div', { class: 'score-value', text: total.toFixed(2) }),
      el('div', { class: 'score-label', text: 'Evidence strength' }),
      el('div', { class: 'score-bar' }, [
        el('span', { style: `width:${Math.round(total * 100)}%` }),
      ]),
    ]),
  ]);

  const badges = el('div', { class: 'badges' }, [
    el('span', { class: 'badge', 'data-kind': 'voices', text: `${cluster.distinctVoices} distinct voices` }),
    el('span', { class: 'badge', text: cluster.sourceTypes.map((s) => SOURCE_LABELS[s] || s).join(' + ') }),
    cluster.rankSensitive
      ? el('span', {
          class: 'badge',
          'data-kind': 'sensitive',
          text: `Rank-sensitive — placed ${cluster.rankRange[0]}–${cluster.rankRange[1]} depending on weighting`,
        })
      : null,
  ]);

  const body = el('div', { class: 'opportunity-body' });

  if (opportunity) {
    const inferred = el('div', { class: 'inferred' }, [
      el('div', { class: 'inferred-tag', text: '◆ AI inference — written from the quotes below' }),
      el('p', { text: opportunity.problem }),
      opportunity.whyNow ? el('p', { text: opportunity.whyNow }) : null,
      opportunity.evidenceGaps
        ? el('dl', {}, [
            el('dt', { text: 'What this evidence does not establish' }),
            el('dd', { text: opportunity.evidenceGaps }),
          ])
        : null,
    ]);
    body.appendChild(inferred);
    body.appendChild(
      el('p', {
        class: 'inference-hidden-note',
        text: 'AI interpretation hidden. The verbatim evidence below is unchanged.',
      }),
    );
  }

  if (cluster.mergedFrom?.length > 1) {
    body.appendChild(
      el('details', { class: 'merge-note' }, [
        el('summary', { text: `Grouped from ${cluster.mergedFrom.length} separately-worded problems` }),
        el('ul', {}, cluster.mergedFrom.map((label) => el('li', { text: label }))),
        el('p', {
          text:
            'These were extracted independently and judged to describe the same ' +
            'problem. Each kept its own verified quote and source link.',
        }),
      ]),
    );
  }

  body.appendChild(
    el('h4', { style: 'margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint)', text: `Evidence — ${cluster.members.length} verified quotes` }),
  );
  body.appendChild(el('ul', { class: 'quotes' }, cluster.members.map(renderQuote)));
  body.appendChild(renderBreakdown(cluster, weights, total));

  return el('article', { class: 'opportunity' }, [head, badges, body]);
}

function renderOpportunities() {
  const section = $('opportunities-section');
  const container = $('opportunities');
  clear(container);

  const clusters = state.report.opportunities || [];
  if (clusters.length === 0) {
    section.hidden = state.report.halted;
    if (!state.report.halted) {
      // "Adequate coverage, nothing ranked" needs a reason, or it reads as a
      // bug. Say how close the strongest group actually got.
      const weak = state.report.weakSignals || [];
      const best = weak.reduce(
        (a, b) => (b.distinctVoices > (a?.distinctVoices ?? -1) ? b : a),
        null,
      );
      const floor = state.report.floor || {};
      const detail = best
        ? `The strongest group, "${best.label}", had ${best.distinctVoices} ` +
          `${best.distinctVoices === 1 ? 'person' : 'people'} on ` +
          `${best.sourceTypes.length} ${best.sourceTypes.length === 1 ? 'platform' : 'platforms'} ` +
          `(${best.sourceTypes.map((p) => SOURCE_LABELS[p] || p).join(', ')}). ` +
          `Ranking requires ${floor.minDistinctVoices} people on ` +
          `${floor.minSourceTypes} independent platforms.`
        : '';
      const analysis = state.report.analysis;
      const trustworthy = !analysis || analysis.state === 'complete';

      container.appendChild(
        el('p', { class: 'empty', text: trustworthy
          ? 'Real customer problems were found, but none was raised by enough different ' +
            'people on enough different platforms to rank. ' + detail + ' ' +
            'Often this means each platform is discussing a different problem, so nothing ' +
            'corroborates. Everything found is listed below.'
          : 'No opportunity is shown, but this run did not complete cleanly, so that ' +
            'is not a conclusion about the market — see the notice above. ' + detail + ' ' +
            'Re-running may give a different answer.' }),
      );
    }
    return;
  }

  section.hidden = false;
  const ranked = [...clusters].sort((a, b) => scoreOf(b, state.weights) - scoreOf(a, state.weights));
  ranked.forEach((cluster, index) => {
    container.appendChild(renderOpportunity(cluster, index, state.weights));
  });
}

function renderWeakSignals() {
  const section = $('weak-section');
  const container = $('weak-signals');
  clear(container);

  const weak = state.report.weakSignals || [];
  if (weak.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  $('weak-summary').textContent =
    `Show ${weak.length} weak signal${weak.length === 1 ? '' : 's'}`;
  $('floor-text').textContent =
    `${state.report.floor.minDistinctVoices} distinct voices across ` +
    `${state.report.floor.minSourceTypes} different sources`;

  for (const cluster of weak) {
    const reasons = [];
    if (cluster.distinctVoices < state.report.floor.minDistinctVoices) {
      reasons.push(`only ${cluster.distinctVoices} distinct ${cluster.distinctVoices === 1 ? 'voice' : 'voices'}`);
    }
    if (cluster.sourceTypes.length < state.report.floor.minSourceTypes) {
      reasons.push(`found on ${cluster.sourceTypes.length} source only`);
    }
    container.appendChild(
      el('div', { class: 'weak-item' }, [
        el('div', { class: 'label', text: cluster.label }),
        el('div', { class: 'why', text: `Not ranked: ${reasons.join(', ')}. Not scored, not framed as an opportunity.` }),
      ]),
    );
  }
}

/* -------------------------------------------------------------- evidence */

const PAGE = 15;

function renderEvidence() {
  const container = $('evidence-list');
  const filters = $('evidence-filters');
  clear(container);
  clear(filters);

  const all = state.report.evidence || [];
  const canonical = all.filter((item) => !item.duplicateOf);
  const duplicatesFor = new Map();
  for (const item of all) {
    if (!item.duplicateOf) continue;
    if (!duplicatesFor.has(item.duplicateOf)) duplicatesFor.set(item.duplicateOf, []);
    duplicatesFor.get(item.duplicateOf).push(item);
  }

  $('evidence-summary').textContent =
    `${canonical.length} unique items collected, ` +
    `${all.length - canonical.length} duplicates collapsed. Duplicates are kept and ` +
    'shown under the item they repeat — they never count toward a score.';

  const sources = ['all', ...new Set(canonical.map((item) => item.source))];
  for (const source of sources) {
    const button = el('button', {
      class: 'filter',
      type: 'button',
      'aria-pressed': String(state.evidenceFilter === source),
      text: source === 'all'
        ? `All (${canonical.length})`
        : `${SOURCE_LABELS[source] || source} (${canonical.filter((i) => i.source === source).length})`,
    });
    button.addEventListener('click', () => {
      state.evidenceFilter = source;
      renderEvidence();
    });
    filters.appendChild(button);
  }

  const matching = canonical
    .filter((item) => state.evidenceFilter === 'all' || item.source === state.evidenceFilter)
    .sort((a, b) => (a.publishedAt || '') < (b.publishedAt || '') ? 1 : -1);

  if (matching.length === 0) {
    container.appendChild(el('p', { class: 'empty', text: 'No items from this source.' }));
    return;
  }

  // Rendering every item made the page ~10,000px tall and buried the actual
  // findings under the raw corpus. All of it stays reachable, just not by
  // default.
  const visible = state.evidenceExpanded ? matching : matching.slice(0, PAGE);

  for (const item of visible) {
    const duplicates = duplicatesFor.get(item.id) || [];
    const node = el('div', { class: 'evidence-item' }, [
      el('div', { class: 'evidence-head' }, [
        el('span', { class: 'title', text: tidyPreview(item.title) || '(no title)' }),
        el('span', { class: 'date', text: item.publishedAt || 'undated' }),
      ]),
      item.body
        ? (() => {
            const preview = tidyPreview(item.body);
            return preview
              ? el('p', {
                  class: 'evidence-body',
                  text: `${preview.slice(0, 220)}${preview.length > 220 ? '…' : ''}`,
                })
              : null;
          })()
        : null,
      el('div', { class: 'evidence-foot' }, [
        el('span', { class: 'dot', 'data-source': item.source }),
        el('span', { text: SOURCE_LABELS[item.source] || item.source }),
        item.container ? el('span', { text: item.container }) : null,
        el('span', { class: 'engagement', text: item.engagementText }),
        item.dateConfidence !== 'high' ? el('span', { text: `date confidence: ${item.dateConfidence}` }) : null,
        el('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open ↗' }),
      ]),
    ]);

    if (duplicates.length > 0) {
      node.appendChild(
        el('details', { class: 'duplicates' }, [
          el('summary', { text: `${duplicates.length} duplicate${duplicates.length === 1 ? '' : 's'} collapsed here` }),
          ...duplicates.map((duplicate) =>
            el('div', { class: 'duplicate-item' }, [
              el('div', { text: duplicate.title || duplicate.body.slice(0, 90) }),
              el('div', { class: 'reason', text: duplicate.dedupeReason }),
            ]),
          ),
        ]),
      );
    }

    container.appendChild(node);
  }

  if (matching.length > visible.length) {
    const more = el('button', {
      type: 'button',
      class: 'filter show-more',
      text: `Show all ${matching.length} items`,
    });
    more.addEventListener('click', () => {
      state.evidenceExpanded = true;
      renderEvidence();
    });
    container.appendChild(more);
  } else if (state.evidenceExpanded && matching.length > PAGE) {
    const less = el('button', { type: 'button', class: 'filter show-more', text: 'Show fewer' });
    less.addEventListener('click', () => {
      state.evidenceExpanded = false;
      renderEvidence();
    });
    container.appendChild(less);
  }
}

/* --------------------------------------------------------------- weights */

function renderWeightSliders() {
  const container = $('weight-sliders');
  clear(container);

  for (const key of Object.keys(COMPONENT_LABELS)) {
    const row = el('div', { class: 'weight-row' });
    const value = el('span', { class: 'value', text: state.weights[key].toFixed(2) });
    const slider = el('input', {
      type: 'range', min: '0', max: '1', step: '0.05',
      value: String(state.weights[key]),
      id: `weight-${key}`,
      'aria-label': `${COMPONENT_LABELS[key]} weight`,
    });

    slider.addEventListener('input', () => {
      state.weights[key] = Number(slider.value);
      value.textContent = state.weights[key].toFixed(2);
      renderOpportunities();
    });

    row.appendChild(el('label', { for: `weight-${key}`, text: COMPONENT_LABELS[key] }));
    row.appendChild(value);
    row.appendChild(slider);
    container.appendChild(row);
  }
}

/* ----------------------------------------------------------------- render */

/**
 * One "Refresh analysis" control above a rendered report. Explicit and
 * separate from the initial "Request analysis" prompt (promptForAnalysis):
 * refreshing is the same POST /api/analyses call, just against a market that
 * already has a report — the old report stays visible the whole time (see
 * lib/store.js's getReport, which never returns an in-flight run).
 */
function renderRefreshControl(market) {
  let refresh = document.getElementById('refresh-analysis');
  if (!refresh) {
    refresh = el('button', { type: 'button', id: 'refresh-analysis', class: 'link-button' });
    $('results').insertAdjacentElement('beforebegin', refresh);
  }
  refresh.textContent = 'Refresh analysis';
  refresh.onclick = () => runResearch(market);
}

function renderReport(report) {
  state.report = report;
  state.weights = { ...report.weights };
  state.evidenceFilter = 'all';
  state.evidenceExpanded = false;

  $('results').hidden = false;
  renderRefreshControl(report.market);
  renderAnalysis(report.analysis);
  renderCoverage(report.coverage, report.retrieval, report.subreddits);

  const halted = report.halted;
  $('controls').hidden = halted;
  $('opportunities-section').hidden = halted;
  $('weak-section').hidden = halted;

  if (!halted) {
    renderWeightSliders();
    renderOpportunities();
    renderWeakSignals();
  }
  renderEvidence();
}

/* -------------------------------------------------------------------- run */

/**
 * Reads a fetch() response as Server-Sent Events (`event: X\ndata: Y\n\n`
 * framing, same as streamRun() on the server) and dispatches to `handlers`.
 * EventSource can only do GET; analysis is POST because it creates state and
 * spends real LLM calls, so the stream is consumed by hand instead.
 */
async function consumeSSE(response, handlers) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = raw.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue; // heartbeat comment, etc.
      handlers[eventLine.slice('event: '.length)]?.(JSON.parse(dataLine.slice('data: '.length)));
    }
  }
}

function runResearch(market) {
  const button = $('run-button');
  const errorBox = $('error');
  const events = [];

  button.disabled = true;
  button.textContent = 'Researching…';
  errorBox.hidden = true;
  $('status').hidden = true;
  $('results').hidden = true;
  startElapsedClock();

  const finish = () => {
    stopElapsedClock();
    button.disabled = false;
    button.textContent = 'Research';
  };

  fetch('/api/analyses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ market }),
  })
    .then(async (response) => {
      if (response.status === 409) {
        errorBox.textContent = 'This market is already being analyzed — try again shortly.';
        errorBox.hidden = false;
        return finish();
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        errorBox.textContent = body.error || `Request failed (${response.status}).`;
        errorBox.hidden = false;
        return finish();
      }

      await consumeSSE(response, {
        progress: (event) => {
          events.push(event);
          renderProgress(events);
        },
        report: (report) => {
          renderReport(report);
          finish();
        },
        failed: (data) => {
          errorBox.textContent = `Run failed: ${data.message}`;
          errorBox.hidden = false;
          finish();
        },
      });
    })
    .catch(() => {
      errorBox.textContent = 'Lost connection to the server. Is it still running?';
      errorBox.hidden = false;
      finish();
    });
}

/** Shown when a search finds no existing analysis — the user must explicitly
 * ask for one rather than a search silently spending Claude calls. */
function promptForAnalysis(market) {
  const status = $('status');
  clear(status);
  status.hidden = false;
  status.appendChild(text('This market has not been analyzed yet. '));

  const button = el('button', { type: 'button', text: 'Request analysis' });
  button.addEventListener('click', () => runResearch(market), { once: true });
  status.appendChild(button);
}

/**
 * `?run=<slug>` renders a cached run instead of starting a new one. Revisiting
 * previous research is the obvious use, and it also makes the browser tests
 * deterministic — they assert against a fixed report rather than live sources.
 */
async function loadCachedRun(slug) {
  const errorBox = $('error');
  try {
    const response = await fetch(
      slug === 'fixture' ? '/api/fixture' : `/api/runs/${encodeURIComponent(slug)}`,
    );
    if (!response.ok) throw new Error('No cached run for that market.');
    const report = await response.json();
    renderReport(report);
    $('market').value = report.market;
    $('status').hidden = true;
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

$('search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const market = $('market').value.trim();
  if (market.length < 3) return;

  $('error').hidden = true;
  $('status').hidden = true;
  $('results').hidden = true;

  // Zero-Claude path: an already-analyzed market renders straight from Neon.
  // Only an explicit "Request analysis" click (see promptForAnalysis) spends
  // an LLM call.
  const response = await fetch(`/api/runs/${encodeURIComponent(market)}`);
  if (response.ok) {
    renderReport(await response.json());
    return;
  }
  promptForAnalysis(market);
});

$('hide-inference').addEventListener('change', (event) => {
  document.body.classList.toggle('hide-inference', event.target.checked);
});

$('reset-weights').addEventListener('click', () => {
  state.weights = { ...state.report.weights };
  renderWeightSliders();
  renderOpportunities();
});

/** null when signed out — /get-session returns 200 with a null body, not 401. */
async function getSession() {
  const response = await fetch('/api/auth/get-session');
  return (await response.json().catch(() => null)) || null;
}

function showApp(session) {
  $('auth-form').hidden = true;
  $('search-panel').hidden = false;
  $('main').hidden = false;
  $('account-bar').hidden = false;
  $('account-email').textContent = session.user.email;
}

function showAuthForm() {
  $('auth-form').hidden = false;
  $('search-panel').hidden = true;
  $('main').hidden = true;
  $('account-bar').hidden = true;
  $('auth-form').reset();
  setAuthMode('signin');
}

async function submitAuth(path, body) {
  const errorBox = $('auth-error');
  errorBox.hidden = true;
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message || 'That did not work — check your details.');
    }
    showApp(await getSession());
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
}

let authMode = 'signin';

function setAuthMode(mode) {
  authMode = mode;
  const isSignUp = mode === 'signup';
  $('auth-name').hidden = !isSignUp;
  $('auth-name').required = isSignUp;
  $('auth-password').autocomplete = isSignUp ? 'new-password' : 'current-password';
  $('sign-in-button').textContent = isSignUp ? 'Create account' : 'Sign in';
  $('sign-up-button').textContent = isSignUp ? 'Sign in instead' : 'Create an account instead';
}

$('auth-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  if (authMode === 'signup') {
    submitAuth('/api/auth/sign-up/email', { email, password, name: $('auth-name').value.trim() });
  } else {
    submitAuth('/api/auth/sign-in/email', { email, password });
  }
});

$('sign-up-button').addEventListener('click', () => {
  setAuthMode(authMode === 'signup' ? 'signin' : 'signup');
});

$('sign-out-button').addEventListener('click', async () => {
  await fetch('/api/auth/sign-out', { method: 'POST' });
  showAuthForm();
});

const session = await getSession();
if (session) {
  showApp(session);
  const cachedRun = new URLSearchParams(location.search).get('run');
  if (cachedRun) loadCachedRun(cachedRun);
} else {
  showAuthForm();
}
