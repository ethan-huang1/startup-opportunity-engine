/**
 * Local server. Built on node:http with no dependencies.
 *
 * Two jobs: serve the single page, and stream a research run to it. Runs take
 * a couple of minutes, almost all of it waiting on the AI stages, so progress
 * is pushed over Server-Sent Events rather than leaving the page blank.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runPipeline } from './lib/pipeline.js';
import { auth } from './lib/auth.js';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { beginRun, failRun, saveRunResult, getReport, listMarkets, anyRunInProgress } from './lib/store.js';
import {
  isAdminEmail,
  checkRateLimit,
  generationAvailability,
  GENERATION_UNAVAILABLE_MESSAGE,
} from './lib/access.js';
import {
  FREE_SEARCH_LIMIT,
  visitorFrom,
  networkKey,
  getUsage,
  consumeSearch,
  refundSearch,
} from './lib/usage.js';
import { isClaudeAvailable } from './lib/claude.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Filesystem-safe key for a market query. */
function slugify(market) {
  return market
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'run';
}

async function serveStatic(pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  // Normalize first so "../" cannot escape the public directory.
  const filePath = join(PUBLIC_DIR, normalize(relative).replace(/^(\.\.[/\\])+/, ''));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Whether an Origin header names this same deployment. Anything that will
 * not even parse — an opaque `null` origin from a sandboxed frame, junk —
 * is not this origin, so it fails closed rather than throwing.
 */
function isSameOrigin(origin, host) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/**
 * Streams a live run. Each pipeline stage emits an event the UI renders.
 * `runId` is the row beginRun() already created — this only fills it in.
 */
async function streamRun(market, slug, runId, request, response, { isAdmin = false } = {}) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // A run spawns Python and `claude` subprocesses and bills real LLM calls, so
  // a client that closes the tab must not leave it running and writing to a
  // dead socket. The pipeline itself is not cancellable mid-stage, but this
  // stops the writes and lets the finally block clean up.
  let clientGone = false;
  request.on('close', () => {
    clientGone = true;
  });

  const send = (event, data) => {
    if (clientGone || response.writableEnded) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Heartbeat: the extraction stage can run for minutes with nothing to say,
  // and proxies drop idle connections.
  const heartbeat = setInterval(() => {
    if (clientGone || response.writableEnded) return;
    response.write(': keep-alive\n\n');
  }, 15000);

  try {
    const report = await runPipeline(market, (event) => send('progress', event));
    // The run is finished and paid for either way, so save it even if the
    // client left — reopening the market should be instant rather than a
    // re-run. Neon is the only place a report is written: it is what Vercel
    // reads, so a market analyzed here is live there with no redeploy.
    // (runs/*.json is a frozen archive of pre-Neon runs kept as test
    // fixtures, not a write target.)
    try {
      await saveRunResult(runId, report);
    } catch (dbError) {
      console.error(`[neon save failed] ${market}: ${dbError.message}`);
      await failRun(runId, `Could not save to Neon: ${dbError.message}`);
      send('failed', { message: 'The analysis finished but could not be saved.' });
      return;
    }
    send('report', report);
  } catch (error) {
    console.error(`[run failed] ${market}:`, error);
    await failRun(runId, error.message);
    // The exception string is genuinely useful to the maintainer mid-run,
    // and it can also carry a filesystem path or a connection string — so
    // only an admin sees it. This route is public now; a visitor gets the
    // fact that the run stopped, and the full object stays in the log.
    send('failed', {
      message: isAdmin
        ? `The analysis stopped: ${error.message}`
        : 'The analysis stopped before it finished. Nothing was saved.',
    });
  } finally {
    clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
  }
}

/**
 * The whole request-routing logic, exported (via handleRequest) so tests can
 * call it directly — with a real ephemeral-port server, or fake
 * request/response objects — without going through `node server.js`'s
 * module-level `listen()`.
 */
async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname.startsWith('/api/auth/')) {
    await toNodeHandler(auth)(request, response);
    return;
  }

  // Everything below this line is reachable without signing in. Reading
  // saved research is the product and costs nothing to serve; making people
  // create an account to look at it only stopped them looking.
  //
  // A session is therefore optional and can only *add* privileges: an
  // address in ADMIN_EMAILS generates without a quota. Anonymous is the
  // normal case, not an error.
  let session = null;
  if (url.pathname.startsWith('/api/')) {
    session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  }
  const isAdmin = isAdminEmail(session?.user?.email);

  // Minted on the first response of any kind, the page included, so the
  // free-search allowance is attached to a browser rather than to nothing.
  // Deliberately after the Better Auth branch above: those routes manage
  // their own cookies and have no business carrying this one.
  const visitorId = visitorFrom(request, response);

  // POST because this creates state and spends real LLM calls — unlike every
  // other route here, it is not safe to repeat or to trigger from a plain
  // link. It is also the only route that is metered (see lib/usage.js). Also the one route for an explicit refresh: a market that's
  // already analyzed just calls this again, and the read routes below never
  // see the new run until it finishes (see lib/store.js's getReport).
  if (request.method === 'POST' && url.pathname === '/api/analyses') {
    // This route used to be reachable only by a signed-in admin, so a
    // cross-site POST could not do anything. It is public now, which makes
    // it worth something to a third-party page: one that quietly POSTs
    // here on every pageview burns its visitors' allowances and this
    // deployment's budget. A browser always sends Origin on a cross-site
    // POST, so refusing a foreign one closes that off. A *missing* Origin
    // is left alone on purpose — that is curl, which the meter below is
    // there to handle, not this check.
    const origin = request.headers.origin;
    if (origin && !isSameOrigin(origin, request.headers.host)) {
      sendJson(response, 403, { error: 'Cross-origin generation requests are not accepted.' });
      return;
    }

    // Fail-closed kill switch: checked before anything that scrapes or makes
    // an outbound request, not just before the LLM call. Applies in every
    // environment, production included — see generationAvailability().
    const availability = generationAvailability();
    if (!availability.available) {
      sendJson(response, 503, {
        error: GENERATION_UNAVAILABLE_MESSAGE[availability.reason],
        reason: availability.reason,
      });
      return;
    }
    // The last preflight before anything costs money or makes an outbound
    // request. This is what a serverless runtime trips on: generation shells
    // out to the `claude` CLI, which is not installed there. That is a real
    // missing dependency, reported plainly — the policy decision is the kill
    // switch above, not this.
    if (!(await isClaudeAvailable())) {
      sendJson(response, 503, {
        error:
          'Generation is enabled, but the `claude` CLI is not installed or not on PATH in ' +
          'this environment, so there is nothing to run the AI stages with.',
        reason: 'no-claude',
      });
      return;
    }
    // A cheap read-only look at the meter, so a visitor with nothing left
    // is told so immediately rather than after four more checks. This is
    // not the enforcement point — consumeSearch() below is, because only
    // an atomic conditional UPDATE is safe against two requests racing on
    // the last remaining search. A read here could be stale; that is fine,
    // it can only ever refuse early.
    if (!isAdmin && (await getUsage(visitorId)).remaining <= 0) {
      sendJson(response, 429, {
        error: `You've used your ${FREE_SEARCH_LIMIT} free searches.`,
        reason: 'quota',
      });
      return;
    }

    // Keyed by network for anonymous visitors, not by the visitor cookie:
    // the cookie is client-chosen, so keying on it would let one caller
    // mint a fresh bucket per request — and grow this Map without bound.
    if (!checkRateLimit(session?.user?.email || networkKey(request))) {
      sendJson(response, 429, { error: 'Too many analysis requests — try again in a minute.' });
      return;
    }

    const body = await readJsonBody(request).catch(() => null);
    const market = (body?.market || '').trim();
    if (market.length < 3) {
      sendJson(response, 400, { error: 'Enter a market or customer group (at least 3 characters).' });
      return;
    }
    if (market.length > 200) {
      sendJson(response, 400, { error: 'That query is too long — try naming the market more directly.' });
      return;
    }

    // Basic system-wide concurrency guard, on top of beginRun()'s atomic
    // per-market claim below (see anyRunInProgress()'s own doc comment).
    if (await anyRunInProgress()) {
      sendJson(response, 429, { error: 'Another analysis is already running — try again shortly.' });
      return;
    }

    // The allowance is actually spent here and nowhere earlier: every
    // refusal above is free, so a bad query, a flipped kill switch or a
    // busy server never costs a visitor one of their three. The count is
    // an atomic conditional UPDATE in Postgres (lib/usage.js), so this is
    // also what a direct curl against this route runs into — there is no
    // client-side counter anywhere in the decision.
    if (!isAdmin) {
      const spent = await consumeSearch(visitorId, request);
      if (!spent.ok) {
        sendJson(response, 429, {
          error:
            spent.reason === 'quota'
              ? `You've used your ${FREE_SEARCH_LIMIT} free searches.`
              : 'This network has used its free searches for today — try again tomorrow.',
          reason: spent.reason,
        });
        return;
      }
    }

    const slug = slugify(market);
    const claim = await beginRun(slug, market);
    if (claim.status === 'already_analyzing') {
      // Nothing new started — someone else already owns this market — so
      // the search that was just spent goes back.
      if (!isAdmin) await refundSearch(visitorId, request);
      sendJson(response, 409, { error: 'already_analyzing', slug, runId: claim.runId });
      return;
    }

    await streamRun(market, slug, claim.runId, request, response, { isAdmin });
    return;
  }

  // What this visitor may do. The UI asks at load and after every run, and
  // hides controls it cannot use, rather than offering a button that 429s
  // or 503s. Answering it is a pure read: asking never spends a search.
  if (url.pathname === '/api/session') {
    const availability = generationAvailability();
    sendJson(response, 200, {
      email: session?.user?.email ?? null,
      isAdmin,
      generation: {
        available: availability.available,
        reason: availability.reason,
        message: availability.reason ? GENERATION_UNAVAILABLE_MESSAGE[availability.reason] : null,
      },
      // Admins are unmetered so the maintainer can actually test the thing.
      quota: isAdmin ? { unlimited: true } : { unlimited: false, ...(await getUsage(visitorId)) },
    });
    return;
  }

  // Deterministic report used by the browser tests. Live runs vary too much to
  // assert against, and rarely exercise every UI state in one report.
  if (url.pathname === '/api/fixture') {
    try {
      const body = await readFile(join(ROOT, 'fixtures', 'sample-report.json'), 'utf8');
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(body);
    } catch {
      sendJson(response, 404, { error: 'No fixture built. Run: node tests/make-fixture.mjs' });
    }
    return;
  }

  // Free reads: no LLM cost, backed entirely by Neon.
  if (url.pathname === '/api/runs') {
    const markets = await listMarkets();
    sendJson(response, 200, markets);
    return;
  }

  if (url.pathname.startsWith('/api/runs/')) {
    const slug = slugify(decodeURIComponent(url.pathname.slice('/api/runs/'.length)));
    const report = await getReport(slug);
    if (!report) {
      sendJson(response, 404, { error: 'not_analyzed', slug });
      return;
    }
    sendJson(response, 200, report);
    return;
  }

  await serveStatic(url.pathname, response);
}

/**
 * Error boundary. Without this, a Neon outage rejects the handler's promise
 * and the socket hangs until the client times out — which the UI cannot
 * tell apart from "no such market". Every unexpected failure becomes a
 * plain 500 the UI can report honestly, with the detail kept server-side:
 * stack traces, SQL, and filesystem paths are not the user's business.
 */
export async function handleRequest(request, response) {
  try {
    await route(request, response);
  } catch (error) {
    console.error(`[unhandled] ${request.method} ${request.url}:`, error);
    if (!response.headersSent && !response.writableEnded) {
      sendJson(response, 500, { error: 'Something went wrong on our side. Try again shortly.' });
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}

/**
 * Vercel's Node builder imports this file and invokes its default export
 * per request. It only does that because the module has exports at all —
 * before handleRequest was exported for the tests, the same file was run as
 * a plain script, and adding the named export without this line broke every
 * production request with "the default export must be a function or
 * server". The guard below is false in that environment, so nothing binds a
 * port there.
 */
export default handleRequest;

// Gated so importing this module (the tests, and Vercel above) never has the
// side effect of binding a real port. True only when this file is the script
// Node was started with, i.e. local `node server.js` / `npm start`.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Startup Opportunity Engine → http://localhost:${PORT}`);
  });
}
