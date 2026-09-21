# Security & Cost-Abuse Audit — startup-opportunity-engine on Vercel

Audited: live deployment at `https://startup-opportunity-engine.vercel.app`, commit `c7b066c` (the code actually deployed — see **Note on uncommitted local changes** at the bottom; a separate, undeployed body of work exists in the working tree and was *not* the audit target, but is relevant to remediation).

Method: read every server-reachable code path with line citations below, then verified each claim against the live deployment (curl + `vercel logs`), not just by reading code. Nothing was modified or deployed.

## Bottom line

> **Can a public, unauthenticated person spend your money right now?**

| Resource | At risk today? | Why |
|---|---|---|
| **Anthropic / Claude** | **No** — confirmed live | The `claude` CLI binary doesn't exist on Vercel. Every attempt fails with `spawn ... ENOENT` before any tokens are billed. **This is an accident of a missing binary, not a security control.** The moment anyone wires in a real Anthropic API key (the stated near-term plan), the exact same open door below becomes a direct dollar drain with zero additional attacker effort. |
| **GitHub / Hacker News APIs** | **Yes — confirmed live** | A signed-in session (trivial to obtain — see Finding 1) triggers real calls to GitHub's Search API and HN's Algolia API. GitHub's API is unauthenticated (no `GITHUB_TOKEN` set), sharing a 10 req/min quota across *every* visitor. |
| **Vercel compute** | **Yes, at small scale today** | Each `/api/run` attempt takes ~2s and always ends in a crash (Finding 6) before doing much work. Nothing stops volume — an attacker can still script thousands of invocations. |
| **Neon / Postgres** | **Yes, slow-burn** | Unlimited, unverified self-signup writes real rows to `user`/`session`/`account` forever. No run data is written today (it crashes first), but that's Finding 6's doing, not a control. |

**The core problem in one sentence:** anyone with a throwaway email address can create an account in one HTTP call and then has 100% the same privileges as you — there is no admin concept anywhere in this codebase.

## Findings

### Finding 1 — CRITICAL: No authorization tier; any self-registered user can trigger the expensive pipeline endpoint

- **Files/lines:** [server.js:130–138](server.js#L130-L138) (the only gate — "is there *any* session") and [server.js:140–152](server.js#L140-L152) (`/api/run`, unrestricted to any signed-in user).
- **Exploit path:** `POST /api/auth/sign-up/email` with any email/password → get a session cookie → `GET /api/run?market=<anything>`. No role check, no owner check, no allowlist. Verified live end-to-end (see Finding 3 for the actual trace).
- **Potential cost:** Today, bounded by Finding 6's incidental crash + missing `claude`/`python3` binaries. The instant either of those changes (real Anthropic key added, or the in-progress Postgres run-storage work is deployed — see bottom note), this becomes unlimited, self-service LLM spend for anyone on the internet.
- **Remediation (minimal):** Add an allowlist. Simplest fix that doesn't touch app architecture: an `ADMIN_EMAILS` env var (comma-separated), checked against `session.user.email` before entering the `/api/run` branch in server.js. A few lines, no new dependency.

### Finding 2 — HIGH: Public signup is fully open, unverified, uncapped

- **Files/lines:** [lib/auth.js:15–17](lib/auth.js#L15-L17) — `emailAndPassword: { enabled: true }`, no `disableSignUp`, no `requireEmailVerification`, no CAPTCHA/rate limit.
- **Exploit path:** `POST /api/auth/sign-up/email` — confirmed live, returns `200` with a usable session immediately, no email confirmation step. This is the front door to Finding 1.
- **Potential cost:** Every signup is a free, permanent row in Neon (`user`, `session`, `account`), and — combined with Finding 1 — a free ticket to trigger paid work. No practical limit on how many accounts one person can create.
- **Remediation (minimal):** If this is meant to stay single-owner/admin-use, set `emailAndPassword: { enabled: true, disableSignUp: true }` (Better Auth supports this natively — you'd create your own account via the CLI/DB once, then lock the door). If multi-user is intended, add `requireEmailVerification: true` at minimum.

### Finding 3 — HIGH: No rate limiting or concurrency control on `/api/run`; empirically confirmed to spend real third-party API quota per call

- **Files/lines:** [server.js:140–152](server.js#L140-L152), [server.js:73–120](server.js#L73-L120) (`streamRun`), [lib/pipeline.js:42–69](lib/pipeline.js#L42-L69) (collectors run unconditionally before any coverage gate).
- **Exploit path — live trace, authenticated as a freshly-created throwaway account:**
  ```
  event: progress  {"stage":"communities","status":"done","subreddits":[],"failed":true}
  event: progress  {"stage":"collect","source":"hackernews","state":"no-results","count":0}
  event: progress  {"stage":"collect","source":"github","state":"ok","count":11}
  event: progress  {"stage":"collect","source":"reddit","state":"unreachable","error":"...spawn python3 ENOENT"}
  event: failed    {"message":"EROFS: read-only file system, open '/var/task/runs/audit-test-market-xyz.json'"}
  ```
  The GitHub collector ([lib/collectors/github.js](lib/collectors/github.js)) and HN collector made **real outbound API calls and got real results** (`count:11`) before the request ultimately crashed on the filesystem write (Finding 6) — it does not fail fast, and every attempt costs real third-party quota regardless of outcome.
- **Potential cost:** GitHub's Search API allows 10 req/min *unauthenticated* (no `GITHUB_TOKEN` set — see Finding 5), shared across every visitor to the whole app. A handful of scripted `/api/run` calls exhausts it for everyone. No per-user or global concurrency limit, no daily cap, no idempotency key (two requests for the same market both run in full).
- **Remediation (minimal):** Gate behind Finding 1's allowlist first (removes the "anyone" part). Then add a simple per-user or global request counter (even an in-memory one per warm instance is better than nothing; a Postgres-backed one — the `markets`/`runs` tables already exist in the undeployed work — is the real fix) and reject concurrent/duplicate requests for the same market (the undeployed `beginRun()` in `lib/store.js` already does exactly this — see bottom note).

### Finding 4 — HIGH: No per-user ownership isolation on cached research data

- **Files/lines:** [server.js:167–189](server.js#L167-L189) (`/api/runs`) and [server.js:192–224](server.js#L192-L224) (`/api/runs/:slug`).
- **Exploit path — confirmed live:** signed up a brand-new account with zero history, immediately called `GET /api/runs`, got the full list of every pre-existing cached report (`ai-coding-assistants`, `hvac`, `trucking`, etc.) — data generated before that account ever existed. `/api/runs/:slug` will serve the full report body the same way.
- **Potential cost:** Not a spend risk directly, but a confidentiality one — any of the ~30-second-old accounts from Finding 2 can read every research report you've ever generated. If any of that is treated as proprietary business intelligence, it's currently shared with literally anyone who signs up.
- **Remediation (minimal):** Same allowlist as Finding 1 (simplest — this is clearly meant to be single-owner today), or add a `user_id` column if genuine multi-tenancy is the goal later.

### Finding 5 — MEDIUM: GitHub collector runs fully unauthenticated in production

- **Files/lines:** [lib/collectors/github.js:54–55](lib/collectors/github.js#L54-L55) — `if (process.env.GITHUB_TOKEN)` — confirmed via `vercel env ls` that `GITHUB_TOKEN` is **not set** in Vercel (only `DATABASE_URL` and `BETTER_AUTH_SECRET` are).
- **Potential cost:** Shares the tiny 10 req/min anonymous GitHub quota across every session on the whole app — trivially exhausted, degrading the product for legitimate use even without malice.
- **Remediation (minimal):** Set `GITHUB_TOKEN` in Vercel (raises the ceiling to 30 req/min) — but this is a mitigation, not a fix; it does nothing without Finding 1/3 also landing.

### Finding 6 — MEDIUM: Every `/api/run` call currently crashes with `EROFS` — an accidental, fragile circuit breaker, not a control

- **Files/lines:** [server.js:107–111](server.js#L107-L111) — `mkdir(RUNS_DIR)` / `writeFile(...)` against `runs/`, which is baked read-only into the Vercel function bundle (see `vercel.json`'s `includeFiles`).
- **Why it matters for this audit:** This crash is *currently* what caps the blast radius of Finding 1/3 (the request dies after ~2s instead of running to completion). But it is a bug, not a deployed security decision — and there is already **uncommitted, undeployed work** (`lib/store.js`, `lib/db.js`) sitting in the working tree that replaces this exact write with a real Neon insert, which would make the run *succeed end-to-end* instead of crashing. See the note at the bottom — **do not deploy that work before Finding 1 and Finding 3 are addressed**, or this accidental brake disappears entirely.
- **Secondary issue:** the raw error (`error.message`) is forwarded straight to the client over SSE ([server.js:113–115](server.js#L113-L115)), leaking the container's internal path (`/var/task/runs/...`). Low actionable value to an attacker, but unnecessary infrastructure disclosure — log server-side, send a generic message to the client instead.

### Finding 7 — LOW: Email enumeration on signup

- **Files/lines:** [lib/auth.js:15–17](lib/auth.js#L15-L17) (no `requireEmailVerification`).
- **Exploit path — confirmed live:** signing up with an email that already has an account returns `422 {"code":"USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"}` rather than a generic response, letting an attacker enumerate registered addresses one guess at a time.
- **Remediation:** Enable `requireEmailVerification: true`, which per Better Auth's own docs also activates its email-enumeration protection.

### Finding 8 — LOW / informational: Missing-`Origin` requests aren't rejected in production the way they are locally

- **Confirmed live:**
  - A forged cross-site `Origin: https://evil-attacker.example.com` on both `sign-in` and `sign-up` → correctly blocked, `403 INVALID_ORIGIN`. **Real browser-driven CSRF is not exploitable** — browsers always attach `Origin` on cross-origin requests, and that path is enforced correctly.
  - A request with **no** `Origin` header at all → passes through to credential checking (`401 invalid credentials`) in production, whereas local dev (which has `BETTER_AUTH_URL` explicitly set) rejects it with `403 Missing or null Origin`.
- **Why only informational:** exploiting a missing-Origin gap requires a client that can omit the header entirely, which real browsers won't do for a cross-origin request — so this is reachable by scripts/curl, not by tricking a victim's browser.
- **Remediation:** For defense-in-depth and to match local behavior, consider setting `BETTER_AUTH_URL` (or `trustedOrigins`) in production too. Prior guidance in this project skipped it to avoid breaking Preview-deployment origin inference — that tradeoff is still reasonable, just worth knowing about.

## Environment variables (names only — no values inspected or printed)

**Set in Vercel** (via `vercel env ls`, Production + Preview, both marked Sensitive):
- `DATABASE_URL`
- `BETTER_AUTH_SECRET`

**Read from `process.env` in the deployed code:**
- `PORT` — [server.js:22](server.js#L22) — harmless, Vercel-managed.
- `DATABASE_URL` — [lib/auth.js:12](lib/auth.js#L12) — set, as above.
- `GITHUB_TOKEN` — [lib/collectors/github.js:54–55](lib/collectors/github.js#L54-L55) — **optional, not set** (Finding 5).
- `BETTER_AUTH_URL` — inferred automatically by Better Auth when absent; deliberately not set in Vercel (Finding 8).

No secret *values* appeared in `vercel logs` output during testing — checked directly, not assumed.

## What already works correctly (worth stating plainly)

- Session checks happen **server-side** in `server.js`, not just hidden by frontend JS — every `/api/*` route except `/api/auth/*` is actually gated (verified with curl, no session cookie, all return `401`).
- CSRF against a real browser is enforced correctly (forged cross-origin `Origin` → `403`).
- SQL injection surface in the *deployed* app is effectively zero — all Postgres access goes through Better Auth's own internal (parameterized) adapter; there is no custom SQL in the deployed code at all.
- No admin/user-management plugin is installed on Better Auth, so there's no accidental user-enumeration or admin API exposed beyond what's covered above.

## Note on uncommitted local changes (found during this audit, not deployed, not audited in depth)

The working tree currently has unreviewed, uncommitted changes on top of what's deployed: `server.js`, `public/app.js`, and `package.json` are locally modified, and new files exist (`lib/store.js`, `lib/db.js`, `lib/migrate.js`, `lib/migrations/`, `scripts/`, `tests/store.test.js`) implementing Postgres-backed run storage with an atomic `beginRun()` claim (idempotency/concurrency control) in place of the flat-file cache. I did not write this and it wasn't part of this session's earlier work — it appears to be in-progress work from elsewhere. I did not deploy or modify it, per your instructions, and did not audit it to the same depth as the deployed code — a skim did not turn up SQL injection (all queries are parameterized), but **it does not add any authorization tier either** — the same "any authenticated user" gate from Finding 1 is untouched in the diff I reviewed. Deploying it as-is would remove Finding 6's accidental crash-based brake while leaving Findings 1–4 completely open, which is a strictly worse cost-abuse posture than today. Recommend fixing Finding 1 (and ideally 2–3) before that work ships.

## Priority order for remediation

1. **Finding 1** — add an admin/owner allowlist on `/api/run` (and arguably `/api/runs*`). Smallest possible diff, closes the actual exploit path.
2. **Finding 2** — decide: single-owner tool (`disableSignUp: true`) or genuine multi-user (`requireEmailVerification: true`). Either closes the open front door.
3. **Finding 4** — falls out for free once 1 is fixed, if this stays single-owner.
4. **Finding 3** — rate limiting / idempotency, ideally by finishing and reviewing the in-progress `lib/store.js` work rather than reinventing it.
5. **Finding 6** — fix the error message leak regardless of what else changes; treat the `EROFS` crash itself as something to *replace* (via 3/4's proper fix), not preserve.
6. Findings 5, 7, 8 — cheap, non-urgent hardening.

---

## Resolution (follow-up pass)

Recorded here rather than by editing the findings above — the audit is a
point-in-time document and rewriting it would destroy the record of what
was actually found.

| Finding | Status | What changed |
| --- | --- | --- |
| 1 — no authorization tier | **Fixed** | Generation is `POST /api/analyses`, admin-only, with admin derived server-side from `ADMIN_EMAILS` on every request. Covered by `tests/auth.test.js`. |
| 2 — open, unverified signup | **Fixed differently than recommended** | Signup is deliberately *open*, because the product is a public catalogue of saved research. What changed is what a signup is worth: read access to saved reports and nothing else. It cannot generate, refresh, modify, or delete. Email verification is still absent — see "remaining" below. |
| 3 — no rate limiting or concurrency control | **Fixed** | Per-account rate limit (`checkRateLimit`), a system-wide in-flight check (`anyRunInProgress`), and an atomic per-market claim backed by a partial unique index (`beginRun`). Generation is additionally refused outright in production. |
| 4 — no ownership isolation on cached data | **Accepted, by design** | Saved analyses are intentionally shared: a growing public catalogue is the product. Nothing user-specific is stored in them. |
| 5 — unauthenticated GitHub collector | **Mitigated** | `GITHUB_TOKEN` is honoured when set. It only matters during generation, which no longer runs in production at all, so the shared-quota exposure is gone. |
| 6 — `EROFS` crash as an accidental brake | **Fixed** | The runtime filesystem write is gone; Neon is the only persistence. The brake is now explicit (`generationAvailability()` returns `local-only` whenever `VERCEL` is set) rather than incidental. |
| 7 — email enumeration on signup | **Open, accepted** | Inherent to Better Auth's default responses. Low value to an attacker against a catalogue with no per-user data. |
| 8 — missing-`Origin` requests | **Fixed upstream** | Better Auth 1.7 rejects state-changing requests with no `Origin` (`MISSING_OR_NULL_ORIGIN`); both test clients had to be taught to send one. `baseURL` and `trustedOrigins` are now set explicitly on Vercel instead of inferred. |

Also addressed in the same pass: unhandled exceptions return a plain 500
instead of hanging the socket, and no stack trace, SQL fragment, or
filesystem path reaches a client.

### Remaining, accepted for now

- **No email verification.** There is no outbound email infrastructure for
  this project; requiring a confirmation nobody can receive would simply
  break signup. Account creation is throttled in production by Better
  Auth's built-in rate limiter. Revisit when email exists.
- **The rate limiter is in-memory**, so it resets on cold start and is not
  shared across instances. It guards an admin-only, local-only route, so
  the real bound is that there is exactly one admin machine.
- **`runs/*.json` and the two large session transcripts at the repository
  root** are historical artefacts, not live data. The runs are load-bearing
  test fixtures; the transcripts are not, and could be removed.

### Amendment: the production generation block was removed (deliberately)

Finding 6's remediation above described the brake as
`generationAvailability()` returning `local-only` whenever `VERCEL` was
set. That check was removed at the owner's request, because it made the
kill switch unreachable in production: setting `GENERATION_ENABLED=true`
on Vercel changed nothing, since the environment check ran first.

Generation in production is now gated by, in order: authentication,
`ADMIN_EMAILS`, `GENERATION_ENABLED` (fail-closed), the presence of the
`claude` CLI, a per-account rate limit, and the atomic per-market claim.
The admin check was not touched and generation is not publicly reachable —
`tests/production-generation.test.js` asserts the full matrix against the
real route with `VERCEL` set.

Net posture change: with `GENERATION_ENABLED` unset or `false` on Vercel —
the default, and the current configuration — production is exactly as
closed as before. With it set to `true`, one allowlisted admin account can
trigger a run there, which is the intended behaviour.

### Amendment: generation is now public but metered (deliberately)

Finding 1's remediation was an `ADMIN_EMAILS` allowlist on the generation
route, and Finding 2's was to consider closing signup. Both were built.
The product goal has since changed: the app is published so anyone with
the link can try it, which means the allowlist can no longer be the gate.

Authorization was replaced with **metering**, not removed:

- **Reads and the page are open to everyone, with no account.** They cost
  nothing to serve and call no model — that was already true, the signup
  wall in front of them bought nothing but friction.
- **Generation is capped at three runs per visitor**, counted in Postgres
  (`usage_counters`, [lib/usage.js](lib/usage.js)) against an `HttpOnly`
  cookie holding an opaque UUID, with a per-IP-per-day backstop of ten so
  that clearing the cookie in a loop does not mint unlimited allowances.
  The cookie carries no count, so there is nothing in it worth forging.
- **The enforcement point is an atomic conditional `UPDATE`**, not a
  read-then-write and not a client-side counter, so two requests racing on
  the last remaining search cannot both win, and `curl` is bound by exactly
  the same row the browser is.
- **`ADMIN_EMAILS` still exists**, now meaning one thing: exemption from
  the meter, so the maintainer can test.
- **`GENERATION_ENABLED` still outranks everything**, admin included, and
  still fails closed. It remains the immediate off switch.
- **A same-origin check was added to `POST /api/analyses`**, which matters
  now that the route is public: without it, any third-party page could
  spend its visitors' allowances and this deployment's budget on pageview.
  A request with no `Origin` (curl) is allowed through to the meter, which
  is the control that actually bounds it.

What is *not* claimed: this is a cost brake, not identity. Someone
determined can still cycle cookies across networks, and the honest bound on
that is the per-IP daily cap plus the system-wide in-flight guard. The
upgrade path, if it ever matters, is requiring an account to generate —
the Better Auth setup already here — not fingerprinting.

Finding 2 (open, unverified signup) stands as written, with its severity
reduced rather than resolved: an account now confers *nothing* an anonymous
visitor does not already have — the same three metered searches, the same
free reads — unless its address is in `ADMIN_EMAILS`. A signup still costs
a permanent row in Neon.

The live posture is unchanged in one important respect: Vercel still has no
`claude` CLI, so generation in production answers `503 no-claude` before
any billable work, whatever anyone's remaining allowance says.
`tests/quota.test.js` asserts the whole matrix against the real route.
