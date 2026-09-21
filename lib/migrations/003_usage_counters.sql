-- Free-search accounting for visitors who are not signed in.
--
-- The whole reason this is a table and not a cookie value: clearing site
-- data, reloading, or calling POST /api/analyses straight from curl must
-- not hand anyone a fresh allowance. The cookie only says *who* is asking;
-- Postgres says how much they have spent.
--
-- Two kinds of key share one table because they are the same counter with
-- different subjects:
--   v:<uuid>           the visitor cookie — the quota the UI reports
--   ip:<hash>:<date>   a per-network, per-day backstop, so deleting the
--                      cookie in a loop does not mint unlimited quotas
-- The date is part of the IP key rather than a column so an honest shared
-- network (an office, a campus, CGNAT) recovers the next day on its own.
CREATE TABLE IF NOT EXISTS usage_counters (
  id text PRIMARY KEY,
  used int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
