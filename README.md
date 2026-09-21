# Evidence-Backed Startup Opportunity Discovery Engine

Enter a market or customer group. This searches recent public discussions,
extracts the problems people actually describe, groups them, and ranks them by
how well the evidence supports them — with every conclusion traceable back to
the post it came from.

The thing it is built to *not* be: an AI idea generator that invents plausible
opportunities and staples citations on afterward.

## Running it

```bash
npm install
npm run migrate          # apply lib/migrations/*.sql to Neon (once)
npm start                # http://localhost:3000
npm test                 # the Node test suite (144 tests)
npm run test:browser     # browser checks against a running server
```

Playwright is the only dev dependency. See [Setup](#setup) for the
environment variables — the app will not start usefully without a
`DATABASE_URL`.

## Architecture

Research is expensive. Reading research is not. The system is built around
that asymmetry: a completed analysis is written once, to Postgres, and
every read after that is a database query with no model in the path.

```
Reading (anyone with the link — no account, local or in production)
  search a market -> Neon -> saved report -> filter, sort, re-rank
  zero LLM calls, zero subprocesses, zero outbound requests

Writing (anyone with the link, three times; admins without limit)
  request analysis -> pipeline -> local `claude` CLI -> Neon
  the same Neon that production reads, so a market analysed on a laptop
  is live on the deployed site with no redeploy
```

No sign-in is required for any of it. Reading costs nothing to serve, so
putting a signup form in front of it only stopped people looking. Writing
costs real money, so it is **metered rather than gated**: a visitor gets
three new analyses, counted in Postgres.

`GENERATION_ENABLED` remains the global kill switch, above everything else
including admin. It is the whole decision about whether this deployment
generates at all, in every environment, and it fails closed: unset or
anything but the literal `true` means no generation.

The gates on `POST /api/analyses`, in the order the server applies them:

1. **same-origin** — a cross-site POST is refused 403, so no third-party
   page can spend visitors' allowances or this deployment's budget. A
   request with no `Origin` at all (curl) is allowed through to the meter;
2. **`GENERATION_ENABLED`** — otherwise 503 `disabled`;
3. **the `claude` CLI exists** — otherwise 503 `no-claude`. This is the one
   a serverless runtime normally trips on: there is no CLI installed there,
   which is a real missing dependency rather than a policy;
4. **free searches remaining** — otherwise 429 `quota`. A read-only check,
   so the refusal is immediate;
5. rate limit (per network), then market validation, then the system-wide
   in-flight guard;
6. **the allowance is actually spent** — an atomic conditional `UPDATE`, so
   two requests racing on the last search cannot both win;
7. the atomic per-market claim.

Nothing above step 6 costs a visitor anything: a bad query, a flipped kill
switch or a busy server are all free refusals, and losing the race for a
market that someone else just claimed is refunded.

The UI asks `GET /api/session` what this visitor may do — including how
many searches are left — and hides controls it cannot use, so nobody is
offered a button that answers 429 or 503.

The database fills up organically: it holds the markets people actually
searched for, not a precomputed sweep of every industry.

### Who can do what

| | Visitor (no account) | Signed-in user | Admin |
| --- | --- | --- | --- |
| Read the landing page | yes | yes | yes |
| Browse existing analyses | yes | yes | yes |
| Open a saved report, filter, re-rank | yes | yes | yes |
| Run or refresh an analysis | **3 total** | **3 total** | unlimited |
| Create an account | yes | — | — |

An account is worth nothing on its own — it gets the same three searches an
anonymous visitor gets. Its only purpose is to be listed in `ADMIN_EMAILS`,
which lifts the meter so the maintainer can test. Admin is not a property
of an account: it is derived server-side, on every request, from the
environment variable. There is no role column and nothing a signup can send
that grants it.

### How the three free searches are counted

Not in the browser. The first response of any kind sets an `HttpOnly`
`soe_visitor` cookie holding an opaque UUID and nothing else — no count, so
there is nothing in it worth forging — and every increment is a row in
Postgres. Reloading, clearing the page's state, or calling `POST
/api/analyses` straight from curl all land on the same row.

Two counters back it up ([lib/usage.js](lib/usage.js)):

| Key | Limit | What it is for |
| --- | --- | --- |
| `v:<uuid>` | 3, lifetime | the visitor's allowance, and the number the UI reports |
| `ip:<hash>:<date>` | 10 per day | a backstop, so clearing the cookie in a loop does not mint unlimited quotas |

The address is hashed — the counter needs to tell two networks apart, not
know who either of them is — and the date is part of the key so an honest
shared network (an office, a campus, CGNAT) recovers the next day.

This is a cost brake, not identity. Someone determined can still cycle
cookies across networks. The upgrade path, if that ever matters, is
requiring an account to generate — which the Better Auth setup already here
would give almost for free — not a fingerprinting stack.

**Viewing costs nothing.** Opening a report, refreshing the page, following
a `?run=` link, and browsing the explore list are all plain database reads;
a visitor who only reads never gets a counter row at all.

### Refreshing without losing what you have

`analysis_runs` is append-only: one row per run, the report stored as
`jsonb`. Reads only ever select the newest row whose status is `complete`
or `degraded`, so a run that is still going, or that failed, is invisible
to them. The practical effect is that the previous report stays readable
throughout a refresh and survives a refresh that fails.

## How an opportunity is prevented from being invented

The LLM is never allowed to name an opportunity. It is used at four points
and boxed in at each:

| Stage | What the model may do | What stops it inventing |
| --- | --- | --- |
| **Community proposal** (`lib/subreddits.js`) | Name subreddits where this market might talk | It only chooses *where to look*. Every suggestion is probed against the live archive and dropped unless the community exists and posted inside the window. It never sees evidence and never makes a claim about a customer |
| **Extraction** (`lib/extract.js`) | Report a problem described in one document, and say what KIND of statement it is | It must return a quote that we verify appears **verbatim in that specific document's own title or body**. Failures are dropped and counted. Only `first_hand_problem` and `reported_problem` from someone actually in the market go on to ranking |
| **Theme grouping** (`lib/theme.js`) | Say which already-extracted phrases describe the same problem | It can only reference phrases extraction produced. Unknown or repeated indices are discarded; anything it ignores survives on its own |
| **Framing** (`lib/frame.js`) | Write prose for one cluster | It sees only that cluster's verified quotes — not other clusters, not the scores, not the corpus |

Everything between those stages — deduplication, clustering, engagement
normalization, scoring, ranking, and the evidence floor — is deterministic
code. The model never touches a score: ranking is computed before any prose
is written, so an opportunity is the *output* of evidence rather than a
hypothesis that went looking for some. Re-ranking with the weight sliders
happens entirely in the browser against the saved report, with no model
call and no server round trip.
There is no cross-cluster synthesis step anywhere, because that is exactly where
invention would creep in. Opportunities are 1:1 with clusters that cleared the
floor: no evidence, no opportunity.

## The three honesty constraints

**1. The sources are biased and do not fit every market.** Reddit, Hacker News,
and GitHub skew hard toward developers and early adopters. For HVAC contractors,
dental practices, or commercial bakeries they return almost nothing. The app
measures that — it never asks a model whether a market is "traditional" — and
refuses to continue below the floor rather than squeezing opportunities out of
four tangential posts. A source-bias disclosure is shown on **every** run, not
only failures.

**2. The score is not a prediction of startup success.** It is called Evidence
Strength and measures exactly one thing: how well supported a problem is by the
sources searched. It knows nothing about market size, willingness to pay,
competition, feasibility, regulation, timing, or founder fit. The weights are an
editorial judgment, not a validated model — so the app also sweeps a range of
defensible weightings and flags any opportunity whose rank moves, showing the
range ("placed 1–2 depending on weighting") instead of presenting one ordering
as fact.

**3. Engagement is not comparable across platforms.** A Reddit upvote, an HN
point, and a GitHub reaction are different units on different scales. They are
never summed. Each item is ranked within its **own source's** distribution for
that run, and the native count is always shown beside the percentile. Where a
platform publishes no counter at all — HN hides comment points — the item is
excluded from the distribution and labelled, rather than being scored as a zero
that would imply unpopularity.

## Anti-inflation

Deduplication alone does not stop repeated discussion from inflating evidence,
so there are two layers:

- **Four dedup passes** (`lib/dedupe.js`): canonical URL, native identity, near-
  identical text (0.75 similarity), and crosspost/syndication (same author across
  containers, or a shared 25-word verbatim run). Duplicates are **kept** in the
  record with a reason, shown collapsed, and contribute zero to scoring.
- **Distinct-voice counting** (`lib/score.js`): one person complaining five times
  is one voice. A per-thread cap of three stops a single viral thread from
  manufacturing an opportunity, and a per-container cap of four stops one
  repository or subreddit doing it — every GitHub issue is its own thread, so the
  thread cap alone never engaged when one hobby repo supplied 10 of 45 items.

Fuzzy matching is deliberately confined to comparisons *across* threads — people
inside one thread quote each other, and treating that as copying once deleted
eight genuinely different complaints from a single Reddit thread.

## Sources

| Source | Access | Notes |
| --- | --- | --- |
| Hacker News | `hn.algolia.com/api/v1`, free | Stories and comments. Comment points are not published |
| GitHub | `api.github.com/search/issues`, free | Search API allows 10 req/min unauthenticated; one run makes one request |
| Reddit search | via the `last30days` plugin | Undirected search across all of Reddit |
| Reddit communities | `arctic-shift.photon-reddit.com`, free | Subreddit-targeted archive. This is what reaches trade communities — r/Truckers, r/HVAC, r/CDL. Archive scores are captured at ingest and are always `1`, so engagement from this source is marked unavailable rather than reported as zero |

**Two Reddit collectors, one platform.** Corroboration is only meaningful across
genuinely separate places, so `sourceDiversity` counts *platforms*. Two
subreddits are two corners of one site, not two sources.

Which subreddits get searched is proposed by one model call and then **probed
against the live archive** — a suggestion that does not exist, or has posted
nothing in the window, is dropped. The model chooses only where to look; it
never sees evidence.

Optional: `GITHUB_TOKEN` raises GitHub to 30 req/min. The AI stages shell out
to the locally installed `claude` CLI — no API key for that.

## Setup

The analyses, the free-search counters, and the (optional) accounts all
live in the same Postgres; accounts are handled by
[Better Auth](https://better-auth.com). Copy [.env.example](.env.example)
to `.env` and fill it in.

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | local + Vercel | [Neon](https://neon.tech) Postgres. Holds saved analyses, free-search counters, and accounts. Point local and production at the same database — that is what makes a locally generated report appear in production. |
| `BETTER_AUTH_SECRET` | local + Vercel | Signs session cookies. `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | local | Where the app is reachable, e.g. `http://localhost:3000`. On Vercel it is derived from `VERCEL_PROJECT_PRODUCTION_URL`; leave it unset there. |
| `ADMIN_EMAILS` | local + Vercel | Comma-separated accounts exempt from the three-search meter. Unset means everyone is metered, which is a safe default. Signing up never puts you on this list. |
| `GENERATION_ENABLED` | local + Vercel | Global kill switch, fail-closed: only the literal `true` enables generation, for anyone, admin included. |
| `LAST30DAYS_SCRIPT` | local, optional | Path to the last30days plugin's `last30days.py`. Auto-detected from `~/.claude/plugins/cache/` when unset. |
| `GITHUB_TOKEN` | local, optional | Raises the GitHub Search API ceiling from 10 to 30 req/min. |

Two schemas have to exist. Better Auth owns its own tables:

```bash
npx @better-auth/cli migrate --config lib/auth.js   # accounts, sessions
npm run migrate                                      # markets, analysis_runs
```

`npm run migrate` applies [lib/migrations/](lib/migrations/) in filename
order, once each, tracked in `schema_migrations`.

### Generating an analysis

Generation needs the local `claude` CLI on `PATH` (no API key — the AI
stages shell out to it), `python3` for the last30days plugin, and:

```bash
ADMIN_EMAILS=you@example.com GENERATION_ENABLED=true npm start
```

Search a market and click **Analyze this market**. That works without an
account — it just spends one of three. Sign in as the `ADMIN_EMAILS`
address to generate without a limit. The finished report is written to Neon and is immediately
readable everywhere, including production. `runs/*.json` is a frozen
archive of pre-Neon runs kept as test fixtures; nothing writes to it.

## Provenance in the interface

Every string on screen is one of three things, and looks like it:

- **observed** — a verbatim quote, in serif with a green rule, carrying author,
  date, native engagement, and an outbound link
- **derived** — a computed number, in monospace, with a panel showing the exact
  arithmetic
- **inferred** — model prose, on a tinted panel with a dashed rule and an
  explicit tag

A "Hide AI inference" toggle collapses every inferred element at once, leaving a
pure evidence view.

## What counts as evidence

The verbatim gate proves a quote is authentic. It does not prove the speaker is
a customer or that the sentence describes a problem — a trucking run once turned
the real headline fragment *"So Is a Truck"* into a customer pain point, and a
developer's own acceptance criteria (*"Add client-side anti-spam controls"*)
into a complaint.

So every extracted statement is also classified:

| Category | Counts? |
| --- | --- |
| `first_hand_problem` — someone in the market describing a problem they hit | **Yes** |
| `reported_problem` — someone relaying a problem people in the market hit | **Yes** |
| `proposed_solution` — a feature request, spec, or acceptance criterion | No |
| `promotional` — a launch, tool submission, or announcement | No |
| `incidental` — anything else, including a real problem that is simply not about this market | No |

Nothing is rejected for lacking first-person wording or for beginning with an
instruction — *"Fix your billing page, it charged me twice"* is a first-hand
complaint. Mechanical cues (imperative openings, commit-message titles, an issue
author who owns the repo) are recorded as **signals shown to the classifier and
displayed in the audit view**, never as deletion rules.

Set-aside statements are kept with their reason and counted per category in the
UI, so over-filtering is visible rather than something you have to trust.

## When a run does not complete

Failing to look is not the same as looking and finding nothing, and the two
never render alike. A run once collected 115 discussions, failed all twelve
attempts to read them, and reported "insufficient customer evidence" — a claim
about the market it had not earned.

`lib/analysis.js` tracks whether the analysis ran, separately from what it
found, and keeps three failures distinguishable:

| Failure | What is shown |
| --- | --- |
| A source could not be reached | Marked degraded; counts stated to understate what exists |
| Every extraction batch failed | **Analysis failed.** Verdict `unknown`, no figures printed, and copy saying discussions were collected but could not be analysed |
| Some extraction batches failed | Analysis incomplete, with the failed-batch count |
| Theme grouping failed | Analysis degraded. Grouping falls back to the deterministic lexical clusters, and a zero result is explicitly not presented as a conclusion about the market |

`unknown` and `insufficient` are different verdicts: one is the absence of a
measurement, the other is a finding.

## Known limitations

- **Whether anything clears the floor varies between runs.** The floor is three
  distinct voices across two independent *platforms*. Empty results are common,
  and often correct: a trucking run found 54 genuine customer statements from 45
  people, but each platform was discussing a different problem, so nothing
  corroborated. The UI now says how close the strongest group got rather than
  leaving that unexplained.
- **Coverage is measured after classification, so a run costs money before it can
  say "insufficient".** A cheap retrieval check halts genuinely empty markets
  first, but a market that returns plenty of irrelevant text still pays for
  extraction before the honest verdict is available.
- **Runs take longer than before** — roughly 5–11 minutes — because subreddit
  resolution adds a model call and the archive adds substantially more evidence
  to read.
- **Theme grouping is AI-assisted, not deterministic.** Purely lexical clustering
  was measured against a real 65-phrase run and could not work: "Cannot access
  notes across devices" and "Org mode lacks device syncing" share one word after
  stemming, and any threshold loose enough to merge them also merged genuinely
  different problems. The model only regroups existing phrases and its output is
  validated, but this is a real deviation from a fully deterministic pipeline.
- **Reddit post authors are often missing** from the keyless lanes, so those posts
  fall back to per-item voice identity. Comments do carry authors.
- **Reddit comment bodies are excerpts**, so a problem stated only in the
  truncated remainder of a long comment is missed.
- **A run takes 1–5 minutes** and costs roughly $0.10–0.30 in LLM usage, almost
  all of it in extraction. Finished runs are saved to Neon.
- **`slugify` can collide**: "AI agents" and "AI-agents" map to the same slug,
  so the later run becomes the current report for both. The report always
  displays the market string it was actually run for.
- **Generation needs the `claude` CLI on the machine running the server.**
  Nothing stops you enabling it in production, but a serverless runtime has
  no CLI to run, so it answers 503 `no-claude` — and a run takes minutes,
  well past a serverless function's execution limit. In practice new markets
  appear when the maintainer runs one locally. See
  [Future direction](#future-direction).
- **Relevance filtering is a blunt instrument.** It requires two of the query's
  meaningful words within ~200 characters of each other. This removed a lot of
  genuine noise, but it will also drop posts that discuss the market without
  using its words.

## Layout

```
server.js              node:http, routing, SSE progress, static files
lib/
  auth.js              Better Auth: optional signup, sign-in, sessions
  access.js            admin allowlist, generation kill switch, rate limit
  usage.js             visitor cookie + the three-free-searches meter
  db.js                Neon HTTP client for runtime queries
  store.js             markets + append-only analysis_runs
  migrate.js           applies lib/migrations/*.sql once each
  claude.js            the only place a model is called
  collectors/          hackernews.js, github.js (ours) · reddit.js (delegated)
  coverage.js          the honest stop
  dedupe.js            four dedup passes
  extract.js           pain points + the verbatim quote gate
  theme.js             AI theme grouping, validated
  cluster.js           deterministic lexical grouping
  engagement.js        per-source percentile normalization
  score.js             Evidence Strength + rank sensitivity
  frame.js             cluster-scoped opportunity framing
  pipeline.js          the stages, in order
public/                vanilla HTML/CSS/JS, no framework
tests/                 unit tests, browser checks, fixture builder
runs/                  frozen pre-Neon run archive, used as test fixtures
scripts/               one-off admin scripts (runs/*.json -> Neon backfill)
verification/          screenshots + verification-log.md
```

## Future direction

The missing piece is hosted generation: a signed-in user asking for a market
nobody has analysed yet, and getting it. That needs the pipeline to run
somewhere other than a laptop — and it is the one thing the public
deployment still cannot do. Everything else works for a visitor with the
link: the three-search meter is enforced there, but a serverless runtime
has no `claude` CLI, so generation answers 503 `no-claude` until this
exists. In production the app browses and reads; new analyses are still
generated from a laptop against the same Neon.

The seam for it already exists. [lib/claude.js](lib/claude.js) is the only
module in the project that calls a model: all four AI stages go through its
`askForJson`, and none of them knows how the answer was produced. (The one
other subprocess in the codebase is `python3` for the Reddit collector,
which fetches data and calls no model.) Swapping the local CLI for a hosted
agent means reimplementing that one function; scoring, storage, evidence
verification, and the UI do not change. The second change is in
[lib/access.js](lib/access.js) only if the executor needs its own switch —
`generationAvailability()` is already environment-agnostic, so a hosted
executor that satisfies `isClaudeAvailable()`'s role would need no change
there at all.

Deliberately not built yet, because building it against an executor that
does not exist would be guessing at its interface.
