/**
 * Local server. Built on node:http with no dependencies.
 *
 * Two jobs: serve the single page, and stream a research run to it. Runs take
 * a couple of minutes, almost all of it waiting on the AI stages, so progress
 * is pushed over Server-Sent Events rather than leaving the page blank.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runPipeline } from './lib/pipeline.js';
import { auth } from './lib/auth.js';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { beginRun, failRun, saveRunResult, getReport, listMarkets, anyRunInProgress } from './lib/store.js';
import { isAdminEmail, isAdminRoute, GENERATION_ENABLED, checkRateLimit } from './lib/access.js';
import { isClaudeAvailable } from './lib/claude.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const RUNS_DIR = join(ROOT, 'runs');
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
async function streamRun(market, slug, runId, request, response) {
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
    // The run is finished and paid for either way, so cache it even if the
    // client left — reopening the market should be instant rather than
    // re-run. Local-only: Vercel's bundle filesystem is read-only, and Neon
    // (below) is the only persistence that exists there.
    if (!process.env.VERCEL) {
      await mkdir(RUNS_DIR, { recursive: true });
      await writeFile(join(RUNS_DIR, `${slug}.json`), JSON.stringify(report, null, 2));
    }
    try {
      await saveRunResult(runId, report);
    } catch (dbError) {
      // The file cache above still has the result; don't fail the response
      // over it, but the market must not stay stuck "analyzing" forever.
      console.error(`[neon save failed] ${market}: ${dbError.message}`);
      await failRun(runId, `Saved to disk but not to Neon: ${dbError.message}`);
    }
    send('report', report);
  } catch (error) {
    console.error(`[run failed] ${market}: ${error.message}`);
    await failRun(runId, error.message);
    send('failed', { message: error.message });
  } finally {
    clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
  }
}

/**
 * The whole request-routing logic, exported so tests can call it directly
 * (with a real ephemeral-port server, or fake request/response objects)
 * without going through `node server.js`'s module-level `listen()`.
 */
export async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname.startsWith('/api/auth/')) {
    await toNodeHandler(auth)(request, response);
    return;
  }

  // Every other API route needs a signed-in user; the page itself and its
  // static assets stay reachable so the login form can render.
  let session = null;
  if (url.pathname.startsWith('/api/')) {
    session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) {
      sendJson(response, 401, { error: 'Sign in required.' });
      return;
    }

    // Research/generation and run-history are admin-only for now
    // (SECURITY_AUDIT.md, Findings 1 and 4). /api/fixture stays open to any
    // signed-in account — it's static sample data, not live research.
    if (isAdminRoute(url.pathname) && !isAdminEmail(session.user.email)) {
      sendJson(response, 403, { error: 'Admin access required.' });
      return;
    }
  }

  // POST because this creates state and spends real LLM calls — unlike every
  // other route here, it is not safe to repeat or to trigger from a plain
  // link. Also the one route for an explicit refresh: a market that's
  // already analyzed just calls this again, and the read routes below never
  // see the new run until it finishes (see lib/store.js's getReport).
  if (request.method === 'POST' && url.pathname === '/api/analyses') {
    // Fail-closed kill switch: checked before anything that scrapes or makes
    // an outbound request, not just before the LLM call.
    if (!GENERATION_ENABLED) {
      sendJson(response, 503, { error: 'Report generation is currently disabled.' });
      return;
    }
    if (!(await isClaudeAvailable())) {
      sendJson(response, 503, { error: 'Claude is unavailable in this environment.' });
      return;
    }
    if (!checkRateLimit(session.user.email)) {
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

    const slug = slugify(market);
    const claim = await beginRun(slug, market);
    if (claim.status === 'already_analyzing') {
      sendJson(response, 409, { error: 'already_analyzing', slug, runId: claim.runId });
      return;
    }

    await streamRun(market, slug, claim.runId, request, response);
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

// Gated so importing this module (e.g. tests importing handleRequest) never
// has the side effect of binding a real port. Both local `node server.js`
// and Vercel's Node builder run this file as the main script — same as
// running it directly — so the guard is true in both of those, and only
// false when something else `import`s this module as a library.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Startup Opportunity Engine → http://localhost:${PORT}`);
  });
}
