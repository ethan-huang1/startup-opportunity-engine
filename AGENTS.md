# AGENTS.md

This repository is the Startup Opportunity Discovery Engine: a deterministic evidence pipeline that surfaces startup opportunities only from observed customer pain points in public discussions, with the LLM constrained to narrow stages and each conclusion traceable back to a source quote.

## Primary project guidance

- Read [README.md](README.md) first for the product model, honesty rules, and source limitations.
- Treat the project as an evidence-first system, not an idea generator.
- Keep changes aligned with the "no invention" principle: the model is not allowed to synthesize opportunities beyond verified clusters and evidence.

## Core architecture

Read and write are deliberately asymmetric, and most changes belong on one
side or the other:

- **Read path** (anyone with the link — no account, local and production):
  search or click a market -> `GET /api/runs*` -> Neon -> saved report ->
  client-side filtering, sorting, and re-ranking. **No model call, no
  subprocess, no outbound request may ever appear on this path** —
  `tests/no-claude-on-read.test.js` asserts it by mocking `spawn` and
  `fetch` to throw. Reads are also never metered.
- **Write path** (anyone, three times; admins unmetered): `POST
  /api/analyses` -> `lib/pipeline.js` -> the `claude` CLI -> Neon. Metered
  rather than gated: `lib/usage.js` counts a visitor's searches in Postgres
  against an `HttpOnly` cookie, with a per-IP/day backstop, and
  `ADMIN_EMAILS` is now only an exemption from that meter.
  `GENERATION_ENABLED` is still the global kill switch above everything,
  fails closed, and applies in every environment. The environment itself is
  not a gate — that was a bug, because it made the switch unreachable in
  production. What actually stops a serverless deployment generating is
  that it has no `claude` CLI (503 `no-claude`).

- [server.js](server.js): HTTP routing, SSE progress stream, error boundary.
- [lib/auth.js](lib/auth.js): Better Auth. Sign-in is optional and grants nothing an anonymous visitor lacks; its only purpose is reaching an `ADMIN_EMAILS` address.
- [lib/access.js](lib/access.js): admin allowlist, generation kill switch, rate limit.
- [lib/usage.js](lib/usage.js): the visitor cookie and the three-free-searches meter. The enforcement point is an atomic conditional `UPDATE`, never a client-side count.
- [lib/store.js](lib/store.js): markets + append-only analysis_runs; reads only ever see the newest completed run.
- [lib/db.js](lib/db.js): Neon HTTP client for runtime queries.
- [lib/claude.js](lib/claude.js): the only module that calls a model. The swap point for hosted generation later.
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
- [runs/](runs/): frozen pre-Neon run archive, used as test fixtures. Nothing writes here.

## Commands

Use these commands from the repository root:

```bash
npm test              # the Node.js test suite (144 tests, none skipped)
npm start             # http://localhost:3000; loads .env
npm run migrate       # apply lib/migrations/*.sql to Neon
npm run test:browser  # browser checks; needs a running server and a fixture
```

Notes:

- `DATABASE_URL` must be set (see [.env.example](.env.example)) or most of
  the suite cannot run. Tests that need it are marked, and a skip is a
  failure of the run, not a pass.
- Playwright is the only dev dependency.
- Many investigations and fixes are best validated with the relevant unit test, not by guesswork.
- **Never let a test drive `POST /api/analyses` with generation enabled.**
  It spends real money. Mock `child_process.spawn` to *throw* rather than to
  return a fake, so an unexpected call fails loudly. `tests/quota.test.js`
  and `tests/production-generation.test.js` both send the deliberately
  invalid market `"ab"` so the route is exercised right up to validation and
  no further; read the SAFETY note at the top of either before editing them.
  Note that `mock.restoreAll()` disarms the `spawn` guard — re-arm it.

## Important conventions

### 1. Evidence and provenance are the product

- The system is designed to distinguish observed, derived, and inferred content.
- Do not quietly reclassify or "improve" a result without preserving the traceability chain.
- When adding features or UI text, keep the provenance model explicit.

### 2. The model is constrained

- LLMs are used only for four narrow, bounded steps: community proposal,
  extraction, theme grouping, and framing.
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

### 6. Honesty about failure states

- A missing report, an unauthenticated request, a forbidden one, and a
  server error are four different facts. Never collapse them into one
  message in the UI — only a real 404 may say a market has not been analysed.
- Never expose stack traces, SQL, filesystem paths, or secrets to a client.
  Log them server-side instead.

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
