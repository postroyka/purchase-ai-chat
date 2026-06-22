// Durable outbox for feedback → GitHub issues (#190, part 3).
//
// Without this, a brief GitHub outage during POST /feedback (or a bot 👍/👎) is a 502 and the note is
// lost unless the user retries — the issue calls out that there is "no automatic retry/queue". This
// IS that queue: on a RETRYABLE failure (transport / 5xx / 429) the caller hands the already-built
// { title, body, labels } here, the request returns 202 ("queued"), and a background drainer retries
// with exponential backoff until the issue lands or a small attempt budget is exhausted.
//
// Storage prefers Redis (survives a restart; LPOP-based draining is multi-instance-safe — each tick
// pops distinct items, so N drainers never double-deliver) and falls back to an in-memory ring when no
// Redis is wired (dev/tests) — mirroring agent-feedback.js / app-store.js. The maxItems cap is
// best-effort under concurrent enqueues (rpush + a separate ltrim), which is fine: the cap exists only
// to bound a sustained outage, and dropping the oldest by a hair is acceptable.
//
// DELIVERY IS AT-MOST-ONCE. A drain does LPOP (remove) → await createIssue, so a crash/redeploy in
// that window loses the in-flight note. This is deliberate: the alternative (a processing list for
// at-least-once) would spawn a DUPLICATE GitHub issue on every crash, which is worse for low-value
// feedback telemetry than rarely losing one — and the issue asked for a *tiny* outbox, not a broker.
//
// Everything is BEST-EFFORT: enqueue and the drainer NEVER throw — a queue hiccup must not fail a
// request or crash the timer. The GitHub token is NEVER stored; only the issue payload is persisted,
// and the live token is read at drain time from the injected createIssue closure.

import { createHash } from 'node:crypto';

const KEY = 'fbk:outbox';

/**
 * @param {{
 *   redisClient?: object|null,
 *   createIssue: (issue: { repo: string, title: string, body: string, labels: string[] }) => Promise<{ url: string, number: number }>,
 *   now?: () => number,
 *   maxItems?: number,        // ring cap — oldest dropped past this (bounds a sustained outage)
 *   maxAttempts?: number,     // give up after this many QUEUED retries — ON TOP of the 1 online
 *                             //   attempt in createFeedbackIssue — then drop + log the note

 *   baseBackoffMs?: number,   // first retry delay; doubles each attempt up to maxBackoffMs
 *   maxBackoffMs?: number,
 * }} config
 */
export function createFeedbackOutbox({
  redisClient = null,
  createIssue,
  now = () => Date.now(),
  maxItems = 100,
  maxAttempts = 8,
  baseBackoffMs = 60_000,
  maxBackoffMs = 60 * 60_000,
} = {}) {
  const mem = []; // in-memory fallback: array of entry objects (oldest first)

  // attempts=1 → base, 2 → 2×base, … capped. (attempts is the count INCLUDING the just-failed try.)
  function backoffFor(attempts) {
    return Math.min(baseBackoffMs * 2 ** Math.max(0, attempts - 1), maxBackoffMs);
  }

  function makeEntry(issue, channel) {
    const t = now();
    return {
      id: createHash('sha256').update(`${t}|${Math.random()}|${issue.title ?? ''}`).digest('hex').slice(0, 16),
      repo: issue.repo ?? '',
      title: issue.title ?? '',
      body: issue.body ?? '',
      labels: Array.isArray(issue.labels) ? issue.labels : [],
      channel: channel ?? 'user',
      attempts: 0,
      firstQueuedAt: t,
      nextAttemptAt: t, // eligible on the next drain pass
    };
  }

  /** Persist one pending issue. Returns { queued } — never throws (a Redis error → queued:false). */
  async function enqueue(issue, channel) {
    const entry = makeEntry(issue, channel);
    try {
      if (redisClient) {
        await redisClient.rpush(KEY, JSON.stringify(entry));
        await redisClient.ltrim(KEY, -maxItems, -1); // keep only the newest maxItems
      } else {
        mem.push(entry);
        while (mem.length > maxItems) mem.shift();
      }
      return { queued: true, id: entry.id };
    } catch {
      return { queued: false };
    }
  }

  /** Pending count (for diagnostics / health). Never throws. */
  async function size() {
    try {
      if (redisClient) return await redisClient.llen(KEY);
      return mem.length;
    } catch {
      return 0;
    }
  }

  // Try one entry if it is due. Returns the per-entry outcome and whether to keep it in the queue.
  async function attempt(entry, t) {
    if (entry.nextAttemptAt > t) return { keep: true, entry, delivered: 0, retried: 0, dropped: 0 };
    try {
      await createIssue({ repo: entry.repo, title: entry.title, body: entry.body, labels: entry.labels });
      return { keep: false, delivered: 1, retried: 0, dropped: 0 };
    } catch (e) {
      const attempts = entry.attempts + 1;
      if (e?.retryable && attempts < maxAttempts) {
        return { keep: true, entry: { ...entry, attempts, nextAttemptAt: t + backoffFor(attempts) }, delivered: 0, retried: 1, dropped: 0 };
      }
      // Permanent failure, or the attempt budget is spent → give up on this note. Log id/channel/
      // attempts (NEVER the title/body — they can carry client context) so an operator can see WHICH
      // note was lost and why, instead of only the aggregate count in the drain summary.
      const reason = e?.retryable ? 'attempt budget exhausted' : 'permanent failure';
      console.warn(`[feedback-outbox] dropping feedback id=${entry.id} channel=${entry.channel} after ${attempts} attempt(s): ${reason}`);
      return { keep: false, delivered: 0, retried: 0, dropped: 1 };
    }
  }

  /**
   * One drain pass over everything currently queued: deliver what's due, re-queue what still needs a
   * later retry, drop the permanent/exhausted. NEVER throws. Returns a summary for logging.
   *
   * Redis path pops each item with LPOP (atomic) and RPUSHes survivors back to the tail, bounded by
   * the LLEN snapshot so re-queued items aren't reprocessed in the same pass (and concurrent enqueues
   * land beyond the budget → next pass). This keeps a single drainer safe without a transaction.
   *
   * Cost is O(pending) round-trips per pass (one LPOP, plus an RPUSH for each not-yet-delivered item).
   * That's fine at maxItems≈100 / a 60s tick; revisit (peek-before-pop) only if the cap grows by orders
   * of magnitude. NB the at-most-once window noted in the file header: an item is OUT of Redis between
   * its LPOP and a successful createIssue / re-RPUSH.
   */
  async function drainOnce() {
    const t = now();
    let delivered = 0; let retried = 0; let dropped = 0;

    if (redisClient) {
      let budget = 0;
      try { budget = await redisClient.llen(KEY); } catch { return { delivered, retried, dropped, pending: 0 }; }
      for (let i = 0; i < budget; i++) {
        let raw;
        try { raw = await redisClient.lpop(KEY); } catch { break; }
        if (raw == null) break;
        let entry;
        try { entry = JSON.parse(raw); } catch { continue; } // drop an unparseable record
        const out = await attempt(entry, t);
        if (out.keep) { try { await redisClient.rpush(KEY, JSON.stringify(out.entry)); } catch { /* lost on Redis error */ } }
        delivered += out.delivered; retried += out.retried; dropped += out.dropped;
      }
      let pending = 0;
      try { pending = await redisClient.llen(KEY); } catch { /* ignore */ }
      return { delivered, retried, dropped, pending };
    }

    // In-memory: snapshot-and-rebuild so survivors keep their order and re-queues aren't reprocessed.
    const batch = mem.splice(0, mem.length);
    for (const entry of batch) {
      const out = await attempt(entry, t);
      if (out.keep) mem.push(out.entry);
      delivered += out.delivered; retried += out.retried; dropped += out.dropped;
    }
    return { delivered, retried, dropped, pending: mem.length };
  }

  let timer = null;
  /** Start the periodic drainer. Idempotent; the timer is unref'd so it never blocks process exit. */
  function start({ intervalMs = baseBackoffMs } = {}) {
    if (timer) return;
    timer = setInterval(() => {
      drainOnce()
        .then((s) => {
          if (s.delivered || s.dropped) {
            console.log(`[feedback-outbox] drain: +${s.delivered} delivered, ${s.dropped} dropped, ${s.pending} pending`);
          }
        })
        .catch(() => {});
    }, intervalMs);
    timer.unref?.();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { enqueue, drainOnce, size, start, stop };
}
