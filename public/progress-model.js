/**
 * The progress model: which stages exist, what to say about each, and how long
 * a run has been going.
 *
 * Kept free of DOM so the rules can be tested directly instead of only through
 * a live run — and a live run is exactly what we must not require, since one
 * costs several minutes and real model usage.
 *
 * There is deliberately no percentage and no ETA anywhere in this file. Stage
 * durations vary by more than an order of magnitude depending on how much
 * evidence comes back and how the model responds. "Stage 5 of 8, running for
 * 2:14" is true; "62%, about 40 seconds left" would be invented.
 */

export const STAGES = [
  ['communities', 'Finding communities'],
  ['collect', 'Collecting evidence'],
  ['dedupe', 'Removing duplicates'],
  ['coverage', 'Checking coverage'],
  ['extract', 'Reading for problems'],
  ['cluster', 'Grouping problems'],
  ['score', 'Scoring evidence'],
  ['frame', 'Describing findings'],
];

export const STAGE_LABELS = Object.fromEntries(STAGES);

export const PROGRESS_NOTE =
  'Runs usually take a few minutes. Stage lengths vary a lot, so no completion estimate is shown.';

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Reduces the event stream to one current event per stage, plus which stage is
 * currently in front and whether the run stopped early.
 */
export function progressState(events) {
  const latest = new Map();
  for (const event of events) latest.set(event.stage, event);

  const halted = latest.has('halted');
  const reached = STAGES.map(([id]) => id).filter((id) => latest.has(id));
  const currentIndex = reached.length > 0
    ? STAGES.findIndex(([id]) => id === reached[reached.length - 1])
    : 0;

  const steps = STAGES.map(([id, label], index) => {
    const event = latest.get(id);
    let state = 'pending';
    if (event?.status === 'done') state = 'done';
    else if (event) state = 'active';
    else if (halted && index <= currentIndex) state = 'skipped';
    return { id, label, state, event: event || null };
  });

  return {
    halted,
    currentIndex,
    steps,
    heading: halted
      ? 'Stopped'
      : `Stage ${currentIndex + 1} of ${STAGES.length} · ${STAGES[currentIndex][1]}`,
  };
}

const SOURCE_LABELS = {
  reddit: 'Reddit search',
  'reddit-archive': 'Reddit communities',
  hackernews: 'Hacker News',
  github: 'GitHub',
};

/** One short line describing what a stage is doing or what it found. */
export function describeStage(event) {
  if (!event) return '';

  if (event.stage === 'collect' && event.status === 'source') {
    const label = SOURCE_LABELS[event.source] || event.source;
    // A source that failed is not a source that found nothing.
    const failed = !['ok', 'no-results'].includes(event.state);
    return failed
      ? `${label}: ${event.state}${event.error ? ` — ${event.error}` : ''} (not searched successfully)`
      : `${label}: ${event.count} items (${event.state})`;
  }
  if (event.stage === 'communities' && event.status === 'progress') {
    return `checking r/${event.probing}`;
  }
  if (event.stage === 'extract' && event.status === 'progress') {
    return `batch ${event.batch} of ${event.of}`;
  }
  if (event.stage === 'frame' && event.status === 'progress') {
    return `${event.done} of ${event.of}`;
  }
  if (event.stage === 'coverage' && event.status === 'qualified') {
    return `${event.coverage.statements} customer statements — ${event.coverage.verdict}`;
  }

  if (event.status === 'done') {
    switch (event.stage) {
      case 'communities':
        return event.subreddits?.length
          ? event.subreddits.map((name) => `r/${name}`).join(', ')
          : 'no matching communities found';
      case 'collect': return `${event.count} items retrieved`;
      case 'dedupe': return `${event.unique} unique, ${event.duplicates} duplicates collapsed`;
      case 'coverage': return `${event.retrieval.totalInWindow} in-window items retrieved`;
      case 'extract':
        return `${event.accepted} customer statements verified, ` +
          `${event.setAside} set aside, ${event.rejectedUnverifiedQuote} quotes rejected`;
      case 'cluster': return `${event.count} groups`;
      case 'score': return `${event.qualifying} ranked, ${event.weak} weak signals`;
      case 'frame': return `${event.count} described`;
      default: return '';
    }
  }
  return event.message || 'working…';
}
