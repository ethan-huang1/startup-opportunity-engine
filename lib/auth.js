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
  },
});
