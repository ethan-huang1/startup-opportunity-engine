-- Report storage: markets (current status) + append-only runs (history) +
-- evidence/mentions/clusters/cluster_members (one run's full pipeline output).
-- better-auth owns its own tables (user/session/account/verification) and is
-- untouched here.

CREATE TABLE IF NOT EXISTS markets (
  slug text PRIMARY KEY,
  query text NOT NULL,
  status text NOT NULL CHECK (status IN ('analyzing', 'complete', 'degraded', 'failed')),
  current_run_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id bigserial PRIMARY KEY,
  market_slug text NOT NULL REFERENCES markets (slug),
  query text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'complete', 'degraded', 'failed')),
  generated_at timestamptz,
  window_days int,
  weights jsonb,
  floor jsonb,
  halted boolean,
  halt_reason text,
  elapsed_ms int,
  retrieval jsonb,
  coverage jsonb,
  coverage_verdict text,
  extraction jsonb,
  analysis jsonb,
  theme_stats jsonb,
  dedupe_stats jsonb,
  engagement jsonb,
  subreddits text[],
  subreddit_stats jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE markets
  ADD CONSTRAINT markets_current_run_fk FOREIGN KEY (current_run_id) REFERENCES runs (id);

CREATE INDEX IF NOT EXISTS runs_market_generated_idx ON runs (market_slug, generated_at DESC);

-- Raw deduped items collected for one run. `data` holds the full item as the
-- pipeline produces it (title/body/url/engagement/etc); the promoted columns
-- exist only so common filters don't need to unpack jsonb.
CREATE TABLE IF NOT EXISTS evidence (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  evidence_key text NOT NULL,
  source text,
  published_at text,
  in_window boolean,
  position int NOT NULL,
  data jsonb NOT NULL,
  UNIQUE (run_id, evidence_key)
);

CREATE INDEX IF NOT EXISTS evidence_run_idx ON evidence (run_id);

-- Extraction output. Accepted and set-aside mentions are the same shape, so
-- one table with a status column replaces the two separate arrays in the
-- report JSON (`mentions` merged into clusters, and `setAside`).
CREATE TABLE IF NOT EXISTS mentions (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  evidence_id bigint NOT NULL REFERENCES evidence (id) ON DELETE CASCADE,
  pain text,
  quote text,
  category text,
  severity text,
  signals text[],
  status text NOT NULL CHECK (status IN ('accepted', 'set_aside')),
  position int NOT NULL
);

CREATE INDEX IF NOT EXISTS mentions_run_idx ON mentions (run_id);
CREATE INDEX IF NOT EXISTS mentions_evidence_idx ON mentions (evidence_id);

-- One row per cluster. `opportunities[]` and `weakSignals[]` in the report
-- are both this shape (qualifies true/false), so one table replaces both.
CREATE TABLE IF NOT EXISTS clusters (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  cluster_key text NOT NULL,
  label text,
  themed boolean,
  merged_from text[],
  counted_mentions int,
  distinct_voices int,
  source_types text[],
  frequency numeric,
  reach numeric,
  recency numeric,
  source_diversity numeric,
  severity numeric,
  score numeric,
  qualifies boolean NOT NULL,
  rank int,
  rank_swing int,
  rank_sensitive boolean,
  rank_range int[],
  opportunity_name text,
  opportunity_customer text,
  opportunity_problem text,
  opportunity_why_now text,
  opportunity_evidence_gaps text,
  position int NOT NULL,
  UNIQUE (run_id, cluster_key)
);

CREATE INDEX IF NOT EXISTS clusters_run_idx ON clusters (run_id);

-- Pure join: which mentions belong to which cluster, and in what order.
-- `position` is the member's index in the original members[] array (joined_at
-- is a merge-round marker from theme grouping, not a reliable order key).
CREATE TABLE IF NOT EXISTS cluster_members (
  cluster_id bigint NOT NULL REFERENCES clusters (id) ON DELETE CASCADE,
  mention_id bigint NOT NULL REFERENCES mentions (id) ON DELETE CASCADE,
  joined_at int,
  position int NOT NULL,
  PRIMARY KEY (cluster_id, mention_id)
);

CREATE INDEX IF NOT EXISTS cluster_members_mention_idx ON cluster_members (mention_id);
