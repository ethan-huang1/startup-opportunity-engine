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

export const sql = neon(process.env.DATABASE_URL);
