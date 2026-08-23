# AGENTS.md

This repository is the Startup Opportunity Discovery Engine: a deterministic evidence pipeline that surfaces startup opportunities only from observed customer pain points in public discussions, with the LLM constrained to narrow stages and each conclusion traceable back to a source quote.

## Primary project guidance

- Read [README.md](README.md) first for the product model, honesty rules, and source limitations.
- Treat the project as an evidence-first system, not an idea generator.
- Keep changes aligned with the "no invention" principle: the model is not allowed to synthesize opportunities beyond verified clusters and evidence.

## Core architecture

- [server.js](server.js): HTTP server and SSE progress stream.
- [lib/pipeline.js](lib/pipeline.js): orchestrates analysis stages in order.
- [lib/extract.js](lib/extract.js): extracts only quote-backed statements and enforces the verbatim gate.
- [lib/theme.js](lib/theme.js): AI-assisted grouping of extracted phrases, validated against existing evidence.
- [lib/frame.js](lib/frame.js): cluster-scoped opportunity framing from only verified cluster content.
- [lib/dedupe.js](lib/dedupe.js): multi-pass duplicate reduction.
- [lib/engagement.js](lib/engagement.js): per-source normalization.
- [lib/score.js](lib/score.js): evidence strength and rank sensitivity.
- [lib/analysis.js](lib/analysis.js): run state and failure classification.
- [public/](public/): vanilla HTML/CSS/JS UI; no framework.
- [tests/](tests/): unit tests and browser checks.
- [runs/](runs/): cached run results.

## Commands

Use these commands from the repository root:

```bash
npm test            # run the Node.js test suite
node server.js      # start the app locally at http://localhost:3000
node tests/browser.mjs  # browser checks; requires a fixture
```

Notes:

- Nothing special is required to install for normal use.
- Playwright is the only dev dependency.
- Many investigations and fixes are best validated with the relevant unit test, not by guesswork.

## Important conventions

### 1. Evidence and provenance are the product

- The system is designed to distinguish observed, derived, and inferred content.
- Do not quietly reclassify or "improve" a result without preserving the traceability chain.
- When adding features or UI text, keep the provenance model explicit.

### 2. The model is constrained

- LLMs are used only for narrow, bounded steps: extraction, theme grouping, and framing.
- Deterministic code handles deduplication, clustering, scoring, ranking, and evidence floors.
- Avoid adding new cross-cluster synthesis steps or any stage that invents opportunities.

### 3. Classification matters

- Keep first-hand and reported customer problems distinct from proposed solutions, promotional content, and incidental text.
- Do not make a run look more confident than the actual evidence allows.
- If a source or extraction batch fails, preserve the distinction between degraded, incomplete, and failed analysis states.

### 4. Source bias and coverage are part of the truth

- The app intentionally accounts for Reddit/HN/GitHub skew and source diversity.
- Empty or weak results can be correct; do not "force" a conclusion.
- If the floor is not reached, present the result honestly rather than squeezing a weak cluster into a conclusion.

### 5. Tests and change discipline

- Add or update tests for behavior changes.
- Prefer small, targeted edits over broad refactors.
- If a bug is related to quoting, classification, or dedupe logic, validate against the real evidence path rather than mocking away the edge case.

## When editing this project

- Preserve the project’s honesty constraints and the UI’s evidence-first framing.
- Keep deterministic logic deterministic; avoid introducing hidden AI synthesis.
- Prefer localized changes in the relevant stage file and follow existing patterns in the surrounding module.
- If changing ranking, scoring, or run failure reporting, inspect the adjacent tests and README guidance before altering logic.

## Relevant docs to read before big changes

- [README.md](README.md)
- [tests/](tests/)
- [lib/coverage.js](lib/coverage.js)
- [lib/dedupe.js](lib/dedupe.js)
- [lib/score.js](lib/score.js)
- [lib/analysis.js](lib/analysis.js)

## Suggested workflow for AI agents

1. Read the relevant docs and the module closest to the change.
2. Identify whether the change belongs in extraction, grouping, scoring, UI, or analysis-state handling.
3. Add a failing or focused test that captures the behavior you want to preserve or fix.
4. Make the smallest root-cause fix.
5. Re-run the relevant test command and confirm the output matches the intended evidence behavior.
