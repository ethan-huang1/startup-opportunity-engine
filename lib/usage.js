/**
 * The free-search allowance for visitors who are not signed in.
 *
 * Reading saved research is free and unmetered — that is the product. This
 * module meters the one thing that spends real money: starting a new
 * analysis. Admins (lib/access.js) bypass it entirely.
 *
 * Nothing here trusts the client with a number. The cookie carries an
 * opaque id and nothing else; every count lives in Neon, so clearing site
 * data, reloading, or calling the API directly with curl cannot reset it.
 *
 * ponytail: a cookie plus a per-IP/day backstop, not identity. Someone
 * determined can still cycle cookies across networks. The upgrade path is
 * requiring an account for generation — which the auth already installed
 * here would give for free — not a fingerprinting stack.
 */

import { randomUUID, createHash } from 'node:crypto';
import { sql } from './db.js';

/** What a visitor gets. Also the number the UI quotes back to them. */
export const FREE_SEARCH_LIMIT = 3;

/**
 * The backstop, per network per day. Deliberately well above
 * FREE_SEARCH_LIMIT: it is there to stop a cookie-clearing loop, not to
 * punish an office or a campus where several people share an address.
 */
export const IP_DAILY_LIMIT = 10;

const VISITOR_COOKIE = 'soe_visitor';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * The visitor's id, minted on first sight and set as a long-lived cookie.
 *
 * The shape is validated before it is used, because this value comes from
 * the client and becomes a primary key: a client that sends anything but a
 * UUID is simply treated as new. That is also why the id is opaque and
 * carries no count — there is nothing in it worth forging.
 */
export function visitorFrom(request, response) {
  const existing = readCookie(request.headers.cookie, VISITOR_COOKIE);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(existing || '')) {
    return existing;
  }

  const id = randomUUID();
  // HttpOnly: no script needs to read it, and it is not a client-side
  // counter. SameSite=Lax so it survives ordinary navigation to a shared
  // link. Secure only where there is TLS to require, or local http drops it.
  const attributes = [
    `${VISITOR_COOKIE}=${id}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(process.env.VERCEL ? ['Secure'] : []),
  ];
  // setHeader rather than a writeHead argument: the callers below write
  // their own headers (and streamRun writes an SSE header block), and Node
  // merges what was set here into whichever writeHead runs next.
  if (!response.headersSent) response.setHeader('Set-Cookie', attributes.join('; '));
  return id;
}

/**
 * A per-network, per-day counter key. Hashed, so the table holds no
 * addresses — the counter needs to tell two networks apart, not know who
 * either of them is.
 *
 * Vercel sets `x-vercel-forwarded-for` itself and a client cannot forge it;
 * plain `x-forwarded-for` is client-appendable, so it is the last resort
 * before the socket. Behind no proxy at all, the socket address is the truth.
 */
export function networkKey(request) {
  const address =
    request.headers['x-vercel-forwarded-for'] ||
    request.headers['x-real-ip'] ||
    (request.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    request.socket?.remoteAddress ||
    'unknown';
  const hash = createHash('sha256').update(address).digest('hex').slice(0, 32);
  return `ip:${hash}:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Increments a counter only while it is below `limit`, in one statement.
 *
 * The limit is in the `WHERE` of the upsert, not in a read-then-write, so
 * two requests racing on the last remaining search cannot both win: the
 * loser's UPDATE matches no row and it returns nothing. This is the actual
 * enforcement point for the whole feature.
 */
async function spend(id, limit) {
  const rows = await sql`
    INSERT INTO usage_counters (id, used) VALUES (${id}, 1)
    ON CONFLICT (id) DO UPDATE SET used = usage_counters.used + 1, updated_at = now()
    WHERE usage_counters.used < ${limit}
    RETURNING used
  `;
  return rows.length > 0;
}

async function giveBack(id) {
  await sql`
    UPDATE usage_counters SET used = greatest(used - 1, 0), updated_at = now()
    WHERE id = ${id}
  `;
}

/** What this visitor has left. A pure read — it never spends anything. */
export async function getUsage(visitorId) {
  const [row] = await sql`SELECT used FROM usage_counters WHERE id = ${`v:${visitorId}`}`;
  const used = Math.min(row?.used ?? 0, FREE_SEARCH_LIMIT);
  return { limit: FREE_SEARCH_LIMIT, used, remaining: FREE_SEARCH_LIMIT - used };
}

/**
 * Spends one search, or explains why it cannot. Call this only once every
 * cheaper refusal has passed, so a request that was never going to start a
 * run does not cost the visitor anything.
 *
 * Returns `{ ok: true }`, or `{ ok: false, reason: 'quota' | 'ip-quota' }`.
 */
export async function consumeSearch(visitorId, request) {
  const visitorKey = `v:${visitorId}`;
  if (!(await spend(visitorKey, FREE_SEARCH_LIMIT))) return { ok: false, reason: 'quota' };
  if (!(await spend(networkKey(request), IP_DAILY_LIMIT))) {
    // The visitor's own allowance is intact; it was the shared network that
    // ran out. Charging them for a run that never started would be wrong.
    await giveBack(visitorKey);
    return { ok: false, reason: 'ip-quota' };
  }
  return { ok: true };
}

/**
 * Undoes a consumeSearch() for a run that turned out not to start — the
 * only such case is losing the race for a market someone else just claimed.
 * A run that starts and then *fails* is not refunded: it has already spent
 * real quota downstream, and refund-on-failure is an obvious way to get
 * unlimited attempts by making them fail.
 */
export async function refundSearch(visitorId, request) {
  await giveBack(`v:${visitorId}`);
  await giveBack(networkKey(request));
}
