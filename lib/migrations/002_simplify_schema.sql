-- Replace the normalized 6-table report schema with markets + analysis_runs.
-- The app fetches one whole report per read and filters/sorts client-side —
-- confirmed by reading public/app.js — so there is no query that needs
-- evidence/mentions/clusters as separate rows. The report is stored whole,
-- as jsonb, versioned by run. See plan-zero-claude-normal-wiggly-puddle.md
-- section 3 for the reasoning; 001_init.sql is left as history, not edited.

DROP TABLE IF EXISTS cluster_members;
DROP TABLE IF EXISTS clusters;
DROP TABLE IF EXISTS mentions;
DROP TABLE IF EXISTS evidence;
-- CASCADE: the old schema has markets.current_run_id -> runs.id, so dropping
-- runs first must also drop that FK constraint (not the markets table
-- itself — CASCADE on DROP TABLE only cascades to dependent objects).
DROP TABLE IF EXISTS runs CASCADE;
DROP TABLE IF EXISTS markets;

CREATE TABLE markets (
  slug text PRIMARY KEY,
  query text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analysis_runs (
  id bigserial PRIMARY KEY,
  market_slug text NOT NULL REFERENCES markets (slug),
  query text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'complete', 'degraded', 'failed')),
  report jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX analysis_runs_market_created_idx ON analysis_runs (market_slug, created_at DESC);

-- The atomicity guarantee for beginRun(): the database itself refuses a
-- second concurrent in-flight run for one market. No application-level lock.
CREATE UNIQUE INDEX analysis_runs_one_running_per_market
  ON analysis_runs (market_slug) WHERE status = 'running';
