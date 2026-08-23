/**
 * Local server. Built on node:http with no dependencies.
 *
 * Two jobs: serve the single page, and stream a research run to it. Runs take
 * a couple of minutes, almost all of it waiting on the AI stages, so progress
 * is pushed over Server-Sent Events rather than leaving the page blank.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPipeline } from './lib/pipeline.js';
import { assessAnalysis } from './lib/analysis.js';
import { auth } from './lib/auth.js';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';

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

/** Streams a live run. Each pipeline stage emits an event the UI renders. */
async function streamRun(market, request, response) {
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
    // client left — reopening the market should be instant rather than re-run.
    await mkdir(RUNS_DIR, { recursive: true });
    await writeFile(
      join(RUNS_DIR, `${slugify(market)}.json`),
      JSON.stringify(report, null, 2),
    );
    send('report', report);
  } catch (error) {
    console.error(`[run failed] ${market}: ${error.message}`);
    send('failed', { message: error.message });
  } finally {
    clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname.startsWith('/api/auth/')) {
    await toNodeHandler(auth)(request, response);
    return;
  }

  // Every other API route needs a signed-in user; the page itself and its
  // static assets stay reachable so the login form can render.
  if (url.pathname.startsWith('/api/')) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) {
      sendJson(response, 401, { error: 'Sign in required.' });
      return;
    }
  }

  if (url.pathname === '/api/run') {
    const market = (url.searchParams.get('market') || '').trim();
    if (market.length < 3) {
      sendJson(response, 400, { error: 'Enter a market or customer group (at least 3 characters).' });
      return;
    }
    if (market.length > 200) {
      sendJson(response, 400, { error: 'That query is too long — try naming the market more directly.' });
      return;
    }
    await streamRun(market, request, response);
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

  if (url.pathname === '/api/runs') {
    try {
      const files = await readdir(RUNS_DIR);
      const runs = await Promise.all(
        files
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => {
            const report = JSON.parse(await readFile(join(RUNS_DIR, name), 'utf8'));
            return {
              slug: name.replace(/\.json$/, ''),
              market: report.market,
              generatedAt: report.generatedAt,
              verdict: report.coverage?.verdict,
              opportunities: report.opportunities?.length || 0,
            };
          }),
      );
      runs.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
      sendJson(response, 200, runs);
    } catch {
      sendJson(response, 200, []);
    }
    return;
  }

  if (url.pathname.startsWith('/api/runs/')) {
    const slug = slugify(decodeURIComponent(url.pathname.slice('/api/runs/'.length)));
    try {
      const report = JSON.parse(await readFile(join(RUNS_DIR, `${slug}.json`), 'utf8'));
      // Runs saved before analysis health was recorded still carry the stats it
      // is derived from. Deriving it here describes what already happened — it
      // changes no evidence — and stops an old failed run from rendering its
      // failure as a finding about the market.
      if (!report.analysis) {
        report.analysis = assessAnalysis({
          extraction: report.extraction ?? null,
          themeStats: report.themeStats ?? null,
          retrieval: report.retrieval ?? null,
        });

        // The stored verdict was computed on the assumption that zero verified
        // statements meant the market had none. When nothing was ever read, that
        // assumption was false, so the finding is withdrawn rather than shown.
        if (report.analysis.state === 'failed' && report.coverage) {
          report.coverage = {
            ...report.coverage,
            verdict: 'unknown',
            explanation: report.analysis.explanation,
          };
          report.haltReason = 'analysis-failed';
        }
      }
      sendJson(response, 200, report);
    } catch {
      sendJson(response, 404, { error: 'No cached run for that market.' });
    }
    return;
  }

  await serveStatic(url.pathname, response);
});

server.listen(PORT, () => {
  console.log(`Startup Opportunity Engine → http://localhost:${PORT}`);
});
