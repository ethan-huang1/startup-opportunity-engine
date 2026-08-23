# Evidence-Backed Startup Opportunity Discovery Engine

Enter a market or customer group. This searches recent public discussions,
extracts the problems people actually describe, groups them, and ranks them by
how well the evidence supports them — with every conclusion traceable back to
the post it came from.

The thing it is built to *not* be: an AI idea generator that invents plausible
opportunities and staples citations on afterward.

## Running it

```bash
node server.js           # http://localhost:3000
npm test                 # 83 unit tests
node tests/browser.mjs   # 27 browser checks (needs a fixture)
```

Nothing to install for normal use. Playwright is the only dev dependency.

## How an opportunity is prevented from being invented

The LLM is never allowed to name an opportunity. It is used at three points and
boxed in at each:

| Stage | What the model may do | What stops it inventing |
| --- | --- | --- |
| **Extraction** (`lib/extract.js`) | Report a problem described in one document, and say what KIND of statement it is | It must return a quote that we verify appears **verbatim in that specific document's own title or body**. Failures are dropped and counted. Only `first_hand_problem` and `reported_problem` from someone actually in the market go on to ranking |
| **Theme grouping** (`lib/theme.js`) | Say which already-extracted phrases describe the same problem | It can only reference phrases extraction produced. Unknown or repeated indices are discarded; anything it ignores survives on its own |
| **Framing** (`lib/frame.js`) | Write prose for one cluster | It sees only that cluster's verified quotes — not other clusters, not the scores, not the corpus |

Everything between those stages — deduplication, clustering, engagement
normalization, scoring, ranking, and the evidence floor — is deterministic code.
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

The app requires accounts (Postgres-backed, via [Better Auth](https://better-auth.com))
before it will run a search. Two environment variables are required:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Connection string for a [Neon](https://neon.tech) Postgres database. |
| `BETTER_AUTH_SECRET` | Random string used to sign session cookies. |

Before first use, apply Better Auth's schema to the database:

```bash
DATABASE_URL=... BETTER_AUTH_SECRET=... npx @better-auth/cli migrate --config lib/auth.js
```

Run history in `runs/` is unaffected — only accounts and sessions live in Postgres.

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
  all of it in extraction. Runs are cached to `runs/<slug>.json`.
- **`slugify` can collide**: "AI agents" and "AI-agents" map to the same cache
  file, so one overwrites the other. The report always displays the market string
  it was actually run for.
- **Relevance filtering is a blunt instrument.** It requires two of the query's
  meaningful words within ~200 characters of each other. This removed a lot of
  genuine noise, but it will also drop posts that discuss the market without
  using its words.

## Layout

```
server.js              node:http, SSE progress, static files
lib/
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
verification/          screenshots + verification-log.md
```
