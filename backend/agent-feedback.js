// Agent-feedback channel (issue #182, channel «агент»).
//
// The headless agent (backend/agent-runner.js) may emit, in its result JSON, a `feedback[]` array of
// "what hinders me / how to improve" notes about our MCP tools or the prompt. This module turns each
// such note into a GitHub issue in the SAME private repo as the user channel (reusing the vetted
// backend/feedback.js client + sanitizers), but with two guards the user channel doesn't need because
// the agent runs unattended on a stream of documents:
//
//   - DEDUP: the same friction (kind + tool + normalised note) opens ONE issue per TTL window, not
//     one per processed file — otherwise a recurring rough edge would bury the tracker in duplicates.
//   - HOURLY CAP: a hard ceiling on issues/hour as a backstop against a burst of distinct friction
//     (e.g. right after a prompt change) or a prompt-injected document trying to spam the repo.
//
// Both guards prefer Redis (multi-instance-safe, survives restart) and fall back to in-memory when no
// Redis is wired (dev/tests). Everything here is BEST-EFFORT: report() never throws — a telemetry
// hiccup must never fail or delay a real job beyond the bounded GitHub call.

import { createHash } from 'node:crypto';
import { createGithubIssue, buildAgentFeedbackIssue, GithubFeedbackError, safeToolName } from './feedback.js';

const DAY_SEC = 86400;

/**
 * @param {{
 *   token?: string, repo?: string, redisClient?: object|null,
 *   dedupTtlSec?: number, hourlyCap?: number, fetchImpl?: typeof fetch, now?: () => number,
 * }} [config]
 */
export function createAgentFeedbackReporter({
  token = '',
  repo = '',
  redisClient = null,
  dedupTtlSec = 14 * DAY_SEC,
  hourlyCap = 10,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const enabled = Boolean(token);
  const memSeen = new Map(); // dedup hash -> expiresAt (ms) — in-memory fallback
  const memHour = new Map(); // hour bucket -> count           — in-memory fallback

  // Dedup on the SAME normalised tool the issue actually renders (safeToolName) — otherwise an
  // injected document could vary a junk `tool` (`a!`, `b!`, …) to defeat dedup while every issue
  // still shows the same blank tool. note is normalised + capped inside normalizeNote.
  const hashOf = (kind, tool, note) =>
    createHash('sha256').update(`${kind}|${safeToolName(tool)}|${normalizeNote(note)}`).digest('hex').slice(0, 32);

  // Has this exact friction been issued within the TTL window? (No marking — see markSeen.)
  async function isDuplicate(hash) {
    if (redisClient) {
      try { return (await redisClient.exists(`fbk:agent:dedup:${hash}`)) === 1; }
      catch { return false; } // best-effort: a Redis error must not SUPPRESS feedback
    }
    const exp = memSeen.get(hash);
    return Boolean(exp && exp > now());
  }

  // Mark a friction as issued — only AFTER a successful issue, so a capped/failed attempt can retry.
  async function markSeen(hash) {
    if (redisClient) {
      try { await redisClient.set(`fbk:agent:dedup:${hash}`, '1', 'EX', dedupTtlSec); } catch { /* ignore */ }
      return;
    }
    memSeen.set(hash, now() + dedupTtlSec * 1000);
    if (memSeen.size > 5000) for (const [k, e] of memSeen) if (e <= now()) memSeen.delete(k);
  }

  // Consume one slot of the hourly cap; returns true while under the ceiling. NB: this counts
  // ATTEMPTS that got past dedup, not issues actually created — a GitHub outage burning the budget
  // is acceptable (it self-resets next hour; the metrics counters are unaffected).
  async function underHourlyCap() {
    const bucket = Math.floor(now() / 3600000);
    if (redisClient) {
      try {
        const key = `fbk:agent:cap:${bucket}`;
        const n = await redisClient.incr(key);
        if (n === 1) await redisClient.expire(key, 3600);
        return n <= hourlyCap;
      } catch { return true; } // best-effort: a Redis error must not BLOCK feedback
    }
    const n = (memHour.get(bucket) || 0) + 1;
    memHour.set(bucket, n);
    for (const k of memHour.keys()) if (k < bucket - 1) memHour.delete(k);
    return n <= hourlyCap;
  }

  /**
   * Best-effort: open (or dedup/skip) an issue for one agent-feedback note. NEVER throws.
   * @returns {Promise<{ created: boolean, reason?: string, url?: string, number?: number }>}
   */
  async function report({ kind, tool, note, context } = {}) {
    if (!enabled) return { created: false, reason: 'disabled' };
    // Treat a note with no letters/digits (empty, whitespace, or emoji/punctuation only) as empty:
    // normalizeNote collapses all of them to '' and they'd otherwise share one dedup bucket and
    // render as "(без описания)".
    if (normalizeNote(note) === '') return { created: false, reason: 'empty' };
    try {
      const k = kind || 'problem';
      const hash = hashOf(k, tool, note);
      if (await isDuplicate(hash)) return { created: false, reason: 'duplicate' };
      if (!(await underHourlyCap())) return { created: false, reason: 'rate_capped' };
      const issue = buildAgentFeedbackIssue({ kind: k, tool, note, context });
      const res = await createGithubIssue({
        repo, token, title: issue.title, body: issue.body, labels: issue.labels, fetchImpl,
      });
      await markSeen(hash);
      return { created: true, url: res.url, number: res.number };
    } catch (e) {
      // Same discipline as the user channel: log ONLY the stable code, never the (leak-free) message.
      const code = e instanceof GithubFeedbackError ? e.code : 'UNKNOWN';
      console.error(`[agent-feedback] could not create issue (code: ${code})`);
      return { created: false, reason: 'error' };
    }
  }

  return { report, enabled };
}

// Collapse a note to a stable dedup signature: lowercase, whitespace-normalised, punctuation-stripped,
// capped — so "Find_contract is ambiguous!" and "find contract is ambiguous" dedup together.
function normalizeNote(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
    .slice(0, 200);
}
