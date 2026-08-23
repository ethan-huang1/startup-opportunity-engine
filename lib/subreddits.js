/**
 * Picks which communities to search for a market.
 *
 * The plugin's Reddit search is undirected: asked about "trucking" it returned
 * r/pics, r/whatisit and r/gayselfie — viral pickup-truck content — and exactly
 * one post from r/Truckers. Its category map is hardcoded in the plugin with,
 * in its own words, "no user-editable override surface", so steering it is not
 * available to us.
 *
 * The model is asked only WHERE TO LOOK. It never sees evidence, never names a
 * problem, and nothing it says is trusted: every suggestion is probed against
 * the live archive and dropped unless that community actually exists and
 * actually posted inside the window. Choosing a search target is not the same
 * kind of act as making a claim about a customer.
 */

import { askForJson } from './claude.js';
import { MODELS } from './config.js';

const MAX_PROPOSED = 10;
const MAX_VALIDATED = 6;

function buildPrompt(market) {
  return `Name the Reddit communities where people who work in or buy from this market talk to each other: "${market}".

Prefer communities where practitioners and customers discuss their own day-to-day problems. Avoid general news, meme, or picture subreddits, and avoid subreddits about the topic as a spectacle rather than as work.

For "trucking" a good answer is Truckers, FreightBrokers, CDL, Trucking — not pics or mildlyinfuriating.

Reply with raw JSON only: an array of up to ${MAX_PROPOSED} subreddit names, without the "r/" prefix, most relevant first. If you genuinely do not know of any, reply with [].`;
}

/**
 * @param {string} market
 * @param {(name: string) => Promise<number>} probe returns how many in-window
 *   items a subreddit actually yielded; used to validate every suggestion
 * @returns {{subreddits: string[], stats: object}}
 */
export async function resolveSubreddits(market, probe, { onProgress } = {}) {
  const stats = { proposed: 0, validated: 0, rejected: [], failed: false };

  let proposed = [];
  try {
    const response = await askForJson(buildPrompt(market), { model: MODELS.extract });
    proposed = Array.isArray(response) ? response : response?.subreddits || [];
  } catch {
    stats.failed = true;
    return { subreddits: [], stats };
  }

  const cleaned = [...new Set(
    proposed
      .map((name) => String(name || '').trim().replace(/^\/?r\//i, ''))
      .filter((name) => /^[A-Za-z0-9_]{2,21}$/.test(name)),
  )].slice(0, MAX_PROPOSED);

  stats.proposed = cleaned.length;

  const validated = [];
  for (const name of cleaned) {
    if (validated.length >= MAX_VALIDATED) break;
    onProgress?.({ probing: name });
    let count = 0;
    try {
      count = await probe(name);
    } catch {
      count = 0;
    }
    if (count > 0) {
      validated.push(name);
      stats.validated += 1;
    } else {
      // Kept so a run can show which suggestions did not survive contact.
      stats.rejected.push(name);
    }
  }

  return { subreddits: validated, stats };
}
