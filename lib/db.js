/**
 * Neon connection for app runtime queries (report storage). Uses the HTTP
 * driver, not a pooled TCP/WebSocket connection: every query in lib/store.js
 * is a single statement against the simplified markets/analysis_runs
 * schema, so there's nothing that needs a held connection — and a stateless
 * HTTP request per query is the right shape for Vercel's per-invocation
 * serverless model, where a pg.Pool would otherwise leak or exhaust Neon's
 * connection limit across cold starts.
 *
 * better-auth (lib/auth.js) and the local-only migration runner
 * (lib/migrate.js) each keep their own separate `pg` connection — this file
 * is only for lib/store.js's report queries.
 */

import { neon } from '@neondatabase/serverless';

// Said here rather than letting the driver's own "Perhaps an environment
// variable has not been set?" surface at import time — this is the single
// most likely thing to be wrong on a fresh clone, and the fix is one file.
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and fill it in, ' +
    'then run `npm run migrate`.',
  );
}

export const sql = neon(process.env.DATABASE_URL);
