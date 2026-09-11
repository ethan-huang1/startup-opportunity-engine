/**
 * Better Auth instance, backed by the Neon Postgres database. Mounted onto
 * the server in server.js via `toNodeHandler`; also used there to check
 * sessions before letting a request reach the pipeline API.
 */

import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
  }),
  emailAndPassword: {
    enabled: true,
    // Public self-signup is disabled (SECURITY_AUDIT.md, Finding 2). Sign-in
    // still works for any account that already exists; new accounts must be
    // created directly against the database until this is revisited.
    disableSignUp: true,
  },
});
