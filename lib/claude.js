/**
 * Thin wrapper around the local `claude` CLI in headless mode.
 *
 * Using the installed CLI rather than the Anthropic API keeps this project free
 * of API keys and secrets on disk. The tradeoff is that each invocation carries
 * the CLI's own system prompt (~20k tokens), so the pipeline batches
 * aggressively: fewer, larger calls cost far less than many small ones. Keeping
 * the prompt prefix stable across calls also lets them hit the prompt cache.
 */

import { spawn } from 'node:child_process';

export class ClaudeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/** Models sometimes wrap JSON in fences or add a sentence before it. */
function extractJson(text) {
  if (!text) throw new ClaudeError('empty response');

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost bracketed span.
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
    if (start === -1 || end <= start) {
      throw new ClaudeError(`no JSON found in response: ${candidate.slice(0, 200)}`);
    }
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

function invoke(prompt, model, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--output-format', 'json',
        '--model', model,
        '--max-turns', '1',
        // This is a pure text transformation; the model has no reason to touch
        // the filesystem or network, and blocking that keeps runs predictable.
        '--disallowed-tools', 'Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ClaudeError(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ClaudeError(`could not run claude CLI: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new ClaudeError(`claude exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) {
          reject(new ClaudeError(`claude reported an error: ${envelope.result}`));
          return;
        }
        resolve(envelope.result);
      } catch (error) {
        reject(new ClaudeError(`could not parse claude envelope: ${error.message}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Sends a prompt and returns parsed JSON. Retries once with a stricter
 * instruction when the first response is not valid JSON.
 */
export async function askForJson(prompt, { model, timeoutMs = 180000 } = {}) {
  const raw = await invoke(prompt, model, timeoutMs);
  try {
    return extractJson(raw);
  } catch {
    const retry = await invoke(
      `${prompt}\n\nYour previous reply was not valid JSON. Reply with raw JSON only — no prose, no code fences.`,
      model,
      timeoutMs,
    );
    return extractJson(retry);
  }
}
