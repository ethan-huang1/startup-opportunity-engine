/**
 * Better Auth instance, backed by the Neon Postgres database. Mounted onto
 * the server in server.js via `toNodeHandler`; also used there to check
 * sessions before letting a request reach the API.
 *
 * Signing in is entirely optional: reading saved analyses and spending the
 * three free searches both work anonymously. An account exists for one
 * reason — being on the ADMIN_EMAILS list, which lifts the search meter.
 * Signing up can never grant that: admin is derived only from the env var,
 * server-side, on every request (see lib/access.js). There is no role
 * column an account could set on itself.
 */

import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

/**
 * Better Auth infers its own base URL from the request when this is unset,
 * which SECURITY_AUDIT.md Finding 8 flagged: on Vercel that left the
 * Origin check weaker than it is locally. VERCEL_PROJECT_PRODUCTION_URL is
 * injected by Vercel and is the stable production hostname.
 */
const baseURL =
  process.env.BETTER_AUTH_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : undefined);

// Each Vercel deployment also gets its own immutable URL, which is what you
// actually land on from `vercel ls` or a preview link. Without it here, the
// origin check rejects sign-in on every URL except the production alias.
const trustedOrigins = [process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`].filter(
  Boolean,
);

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
  }),
  ...(baseURL ? { baseURL } : {}),
  ...(trustedOrigins.length ? { trustedOrigins } : {}),
  emailAndPassword: {
    enabled: true,
    // Open self-signup, deliberately. An account confers nothing an
    // anonymous visitor does not already have — the same three metered
    // searches, the same free reads — unless its address is in
    // ADMIN_EMAILS. So a signup cannot cost anything beyond its own row.
    disableSignUp: false,
    minPasswordLength: 8,
    // No email verification: there is no outbound email infrastructure for
    // this project, and requiring a confirmation nobody can receive would
    // just break signup. Future hardening, once email exists.
    requireEmailVerification: false,
  },
});
