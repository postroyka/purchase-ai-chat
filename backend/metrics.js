import Redis from 'ioredis';

/**
 * Lightweight, lifetime ("за всё время") usage metrics for the procurement pipeline.
 *
 * Design (issue #67, option A — thin):
 *  - Counters live in Redis hashes with NO TTL, so totals accumulate across restarts.
 *  - The signal is captured at the two pipeline chokepoints: POST /upload (recordUpload)
 *    and processJob per file (recordFile) — see backend/index.js.
 *  - Every method is BEST-EFFORT: a Redis hiccup must never fail a job, so errors are
 *    swallowed and logged. Falls back to an in-memory store when REDIS_URL is unset
 *    (dev/tests) — data is then lost on restart, which is fine for those contexts.
 *
 * @typedef {{
 *   recordUpload(arg: { fileCount?: number }): Promise<void>,
 *   recordFile(arg: {
 *     format?: string,
 *     status?: 'done'|'error',
 *     outcome?: string,
 *     durationMs?: number,
 *     agent?: { extractMethod?: string|null, costUsd?: number|null, agentDurationMs?: number|null }|null,
 *   }): Promise<void>,
 *   snapshot(): Promise<object>,
 *   ping(): Promise<void>,
 * }} Metrics
 */

const K = {
  totals: 'metrics:totals',
  outcomes: 'metrics:outcomes',
  formats: 'metrics:formats',
  extract: 'metrics:extract',
  daily: 'metrics:daily',
};

/** UTC day bucket key, e.g. "2026-06-10". */
function today() {
  return new Date().toISOString().slice(0, 10);
}

// Sanitize a metric label so a malformed agent error / odd extension can't create
// unbounded hash fields (cardinality DoS). Lowercase, [a-z0-9_], capped length.
function label(s, fallback = 'other') {
  if (typeof s !== 'string') return fallback;
  const v = s.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,39}$/.test(v) ? v : fallback;
}

function warn(ctx, e) {
  console.warn(`[metrics] ${ctx} failed: ${e?.message ?? e}`);
}

/**
 * @param {{ redisUrl?: string }} [config]
 * @returns {Metrics}
 */
export function createMetrics(config = {}) {
  const redisUrl = config.redisUrl ?? process.env.REDIS_URL ?? '';
  const backend = redisUrl ? redisBackend(redisUrl) : memoryBackend();
  return makeApi(backend);
}

function makeApi(b) {
  async function recordUpload({ fileCount = 0 } = {}) {
    try {
      await b.batch([
        ['hincrby', K.totals, 'uploads', 1],
        ['hincrby', K.totals, 'files', Math.max(0, Math.trunc(Number(fileCount) || 0))],
      ]);
    } catch (e) { warn('recordUpload', e); }
  }

  async function recordFile({ format, status, outcome, durationMs = 0, agent = null } = {}) {
    try {
      const ops = [
        ['hincrby', K.totals, status === 'done' ? 'files_done' : 'files_error', 1],
        ['hincrby', K.totals, 'file_ms', Math.max(0, Math.round(Number(durationMs) || 0))],
        ['hincrby', K.formats, label(format, 'unknown'), 1],
        ['hincrby', K.outcomes, label(outcome, 'unknown'), 1],
        ['hincrby', K.daily, today(), 1],
      ];
      if (outcome === 'ok') ops.push(['hincrby', K.totals, 'ok', 1]);
      if (agent) {
        ops.push(['hincrby', K.totals, 'agent_runs', 1]);
        ops.push(['hincrby', K.totals, 'agent_ms', Math.max(0, Math.round(Number(agent.agentDurationMs) || 0))]);
        if (typeof agent.extractMethod === 'string') {
          ops.push(['hincrby', K.extract, label(agent.extractMethod, 'unknown'), 1]);
        }
        if (typeof agent.costUsd === 'number' && Number.isFinite(agent.costUsd) && agent.costUsd >= 0) {
          ops.push(['hincrbyfloat', K.totals, 'cost_usd', agent.costUsd]);
          ops.push(['hincrby', K.totals, 'cost_runs', 1]);
        }
      }
      await b.batch(ops);
    } catch (e) { warn('recordFile', e); }
  }

  async function snapshot() {
    const [totals, outcomes, formats, extract, daily] = await Promise.all([
      b.hgetall(K.totals), b.hgetall(K.outcomes), b.hgetall(K.formats),
      b.hgetall(K.extract), b.hgetall(K.daily),
    ]);
    const t = numify(totals);
    const files = t.files || 0;
    const ok = t.ok || 0;
    const costRuns = t.cost_runs || 0;
    const agentRuns = t.agent_runs || 0;
    return {
      generatedAt: new Date().toISOString(),
      totals: {
        uploads: t.uploads || 0,
        files,
        filesDone: t.files_done || 0,
        filesError: t.files_error || 0,
        ok,
        successRatePct: files ? round1((ok / files) * 100) : 0,
        costUsd: round4(t.cost_usd || 0),
        costRuns,
        avgCostUsd: costRuns ? round4((t.cost_usd || 0) / costRuns) : 0,
        agentRuns,
        avgAgentMs: agentRuns ? Math.round((t.agent_ms || 0) / agentRuns) : 0,
        avgFileMs: files ? Math.round((t.file_ms || 0) / files) : 0,
      },
      outcomes: toSortedArray(outcomes),
      formats: toSortedArray(formats),
      extract: toSortedArray(extract),
      daily: Object.entries(numify(daily))
        .map(([date, n]) => ({ date, files: n }))
        .sort((a, b2) => (a.date < b2.date ? -1 : 1)),
    };
  }

  async function ping() { return b.ping(); }

  return { recordUpload, recordFile, snapshot, ping };
}

// ── helpers ────────────────────────────────────────────────────────────────

function numify(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = Number(v) || 0;
  return out;
}

/** Hash → [{ name, count }] sorted by count desc (for charts). */
function toSortedArray(obj) {
  return Object.entries(numify(obj))
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

const round1 = (x) => Math.round(x * 10) / 10;
const round4 = (x) => Math.round(x * 10000) / 10000;

// ── storage backends ─────────────────────────────────────────────────────────
// Both expose: batch(ops: [cmd, key, field, n][]) and hgetall(key).

function redisBackend(url) {
  const client = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, commandTimeout: 3000 });
  client.connect().catch((e) => console.error('[metrics] Redis connect error:', e.message));
  client.on('error', (e) => console.error('[metrics] Redis error:', e.message));
  return {
    async batch(ops) {
      const p = client.pipeline();
      for (const [cmd, ...args] of ops) p[cmd](...args);
      await p.exec();
    },
    async hgetall(key) { return client.hgetall(key); },
    async ping() { await client.ping(); },
  };
}

function memoryBackend() {
  const store = new Map(); // key -> Map(field -> number)
  const hash = (key) => {
    let m = store.get(key);
    if (!m) { m = new Map(); store.set(key, m); }
    return m;
  };
  return {
    async batch(ops) {
      for (const [, key, field, n] of ops) {
        const m = hash(key);
        m.set(field, (m.get(field) || 0) + Number(n));
      }
    },
    async hgetall(key) {
      const m = store.get(key);
      return m ? Object.fromEntries(m.entries()) : {};
    },
    async ping() { /* in-memory is always available */ },
  };
}
