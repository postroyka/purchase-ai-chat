import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFeedbackOutbox } from '../feedback-outbox.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {}); // drop-logging is intentional; keep test output clean

// A createIssue double whose behaviour is switchable: deliver, fail-retryable, or fail-permanent.
function makeCreateIssue() {
  let mode = 'ok'; // 'ok' | 'retryable' | 'permanent'
  const fn = vi.fn(async (issue) => {
    if (mode === 'ok') return { url: 'https://github.com/o/r/issues/1', number: 1 };
    const err = new Error('boom');
    err.retryable = mode === 'retryable';
    throw err;
  });
  fn.calls = fn.mock.calls;
  fn.setMode = (m) => { mode = m; };
  return fn;
}

// Minimal in-memory ioredis double covering only the list ops the outbox uses.
function fakeRedis() {
  const store = new Map();
  const arr = (k) => { if (!store.has(k)) store.set(k, []); return store.get(k); };
  return {
    async rpush(k, ...vals) { const a = arr(k); a.push(...vals); return a.length; },
    async lpop(k) { const a = arr(k); return a.length ? a.shift() : null; },
    async llen(k) { return arr(k).length; },
    async ltrim(k, start, stop) {
      const a = arr(k); const n = a.length;
      const s = start < 0 ? Math.max(n + start, 0) : start;
      const e = stop < 0 ? n + stop : stop;
      store.set(k, a.slice(s, e + 1));
      return 'OK';
    },
  };
}

const issue = (over = {}) => ({ repo: 'o/r', title: 't', body: 'b', labels: ['user-feedback'], ...over });

describe.each([
  ['in-memory', () => null],
  ['redis-backed', () => fakeRedis()],
])('feedback outbox (%s)', (_label, makeRedis) => {
  let createIssue; let clock; let outbox;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
    createIssue = makeCreateIssue();
    outbox = createFeedbackOutbox({
      redisClient: makeRedis(), createIssue, now,
      baseBackoffMs: 1000, maxBackoffMs: 8000, maxAttempts: 3, maxItems: 5,
    });
  });

  it('delivers a queued issue and clears it', async () => {
    await outbox.enqueue(issue());
    expect(await outbox.size()).toBe(1);
    const s = await outbox.drainOnce();
    expect(s).toMatchObject({ delivered: 1, pending: 0 });
    expect(createIssue).toHaveBeenCalledWith({ repo: 'o/r', title: 't', body: 'b', labels: ['user-feedback'] });
    expect(await outbox.size()).toBe(0);
  });

  it('re-queues a retryable failure with backoff and retries only when due', async () => {
    createIssue.setMode('retryable');
    await outbox.enqueue(issue());

    const s1 = await outbox.drainOnce();
    expect(s1).toMatchObject({ delivered: 0, retried: 1, pending: 1 });
    expect(createIssue).toHaveBeenCalledTimes(1);

    clock += 999; // still before the 1000ms backoff
    await outbox.drainOnce();
    expect(createIssue).toHaveBeenCalledTimes(1); // not due → not attempted
    expect(await outbox.size()).toBe(1);

    clock += 1; // now due
    createIssue.setMode('ok');
    const s3 = await outbox.drainOnce();
    expect(s3).toMatchObject({ delivered: 1, pending: 0 });
    expect(createIssue).toHaveBeenCalledTimes(2);
  });

  it('drops a persistently failing issue after maxAttempts', async () => {
    createIssue.setMode('retryable');
    await outbox.enqueue(issue());

    let s = await outbox.drainOnce(); // attempt 1 → backoff 1000
    expect(s.retried).toBe(1);
    clock += 1000;
    s = await outbox.drainOnce(); // attempt 2 → backoff 2000
    expect(s).toMatchObject({ retried: 1, pending: 1 });
    clock += 2000;
    s = await outbox.drainOnce(); // attempt 3 === maxAttempts → drop
    expect(s).toMatchObject({ delivered: 0, retried: 0, dropped: 1, pending: 0 });
    expect(createIssue).toHaveBeenCalledTimes(3);
    expect(await outbox.size()).toBe(0);
  });

  it('drops a non-retryable failure immediately (no retry)', async () => {
    createIssue.setMode('permanent');
    await outbox.enqueue(issue());
    const s = await outbox.drainOnce();
    expect(s).toMatchObject({ delivered: 0, retried: 0, dropped: 1, pending: 0 });
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(await outbox.size()).toBe(0);
  });

  it('drops an entry that turns non-retryable on a LATER attempt', async () => {
    createIssue.setMode('retryable');
    await outbox.enqueue(issue());
    let s = await outbox.drainOnce(); // attempt 1: transient → requeued
    expect(s).toMatchObject({ retried: 1, pending: 1 });
    clock += 1000; // backoff elapsed → due
    createIssue.setMode('permanent'); // the SAME note now hits a permanent error (e.g. token revoked)
    s = await outbox.drainOnce();
    expect(s).toMatchObject({ delivered: 0, retried: 0, dropped: 1, pending: 0 });
    expect(await outbox.size()).toBe(0);
  });

  it('bounds the queue to maxItems, dropping the oldest', async () => {
    for (let i = 0; i < 8; i++) await outbox.enqueue(issue({ title: `t${i}` }));
    expect(await outbox.size()).toBe(5); // newest 5 survive (t3..t7)
    const s = await outbox.drainOnce();
    expect(s.delivered).toBe(5);
    expect(createIssue.mock.calls.map(c => c[0].title)).toEqual(['t3', 't4', 't5', 't6', 't7']);
  });

  it('a drain of an empty queue is a no-op', async () => {
    const s = await outbox.drainOnce();
    expect(s).toMatchObject({ delivered: 0, retried: 0, dropped: 0, pending: 0 });
    expect(createIssue).not.toHaveBeenCalled();
  });
});

// ── Resilience: best-effort contract (never throw) ──────────────────────────────
describe('feedback outbox — never throws', () => {
  it('enqueue returns { queued:false } when Redis throws', async () => {
    const throwingRedis = { rpush: async () => { throw new Error('redis down'); }, ltrim: async () => {}, llen: async () => 0, lpop: async () => null };
    const ob = createFeedbackOutbox({ redisClient: throwingRedis, createIssue: async () => ({ url: 'u', number: 1 }) });
    await expect(ob.enqueue(issue())).resolves.toMatchObject({ queued: false });
  });

  it('drainOnce never throws even if createIssue rejects with a non-Error', async () => {
    const ob = createFeedbackOutbox({ createIssue: async () => { throw 'oops-string'; } });
    await ob.enqueue(issue());
    await expect(ob.drainOnce()).resolves.toMatchObject({ dropped: 1 }); // no .retryable → permanent → dropped
  });

  it('size returns 0 when Redis throws', async () => {
    const ob = createFeedbackOutbox({ redisClient: { llen: async () => { throw new Error('x'); } }, createIssue: async () => ({}) });
    await expect(ob.size()).resolves.toBe(0);
  });
});

// ── Drain-pass invariants (Redis budget snapshot + backoff cap) ─────────────────
describe('feedback outbox — drain-pass invariants', () => {
  it('an enqueue DURING a drain lands in the NEXT pass, not the current one (budget snapshot)', async () => {
    let clock = 1000;
    let ob; // late-bound so createIssue can enqueue back into the same outbox mid-pass
    let injected = false;
    const createIssue = vi.fn(async () => {
      if (!injected) { injected = true; await ob.enqueue(issue({ title: 'late' })); }
      return { url: 'u', number: 1 };
    });
    ob = createFeedbackOutbox({ redisClient: fakeRedis(), createIssue, now: () => clock, baseBackoffMs: 1000, maxItems: 5 });
    await ob.enqueue(issue({ title: 'first' }));

    const s1 = await ob.drainOnce();
    expect(s1.delivered).toBe(1); // only 'first' — the budget was snapshotted at 1
    expect(await ob.size()).toBe(1); // 'late' enqueued mid-pass is still pending

    const s2 = await ob.drainOnce();
    expect(s2.delivered).toBe(1); // 'late' delivered on the following pass
    expect(await ob.size()).toBe(0);
  });

  it('caps the retry backoff at maxBackoffMs', async () => {
    let clock = 0;
    const ci = makeCreateIssue();
    ci.setMode('retryable');
    const ob = createFeedbackOutbox({ createIssue: ci, now: () => clock, baseBackoffMs: 100, maxBackoffMs: 200, maxAttempts: 20 });
    await ob.enqueue(issue());
    await ob.drainOnce(); // attempts=1 → next = 0 + 100
    clock = 100; await ob.drainOnce(); // attempts=2 → next = 100 + min(200,200) = 300
    clock = 300; await ob.drainOnce(); // attempts=3 → next = 300 + min(400,200) = 500 (CAPPED at 200, not 400)
    const calls = ci.mock.calls.length;

    clock = 499; await ob.drainOnce(); // still not due at +199
    expect(ci.mock.calls.length).toBe(calls);
    clock = 500; await ob.drainOnce(); // due exactly at +200 → proves backoff(3) was clamped to maxBackoffMs
    expect(ci.mock.calls.length).toBe(calls + 1);
  });
});

// ── Drainer timer lifecycle ─────────────────────────────────────────────────────
describe('feedback outbox — drainer timer', () => {
  it('start() is idempotent and stop() halts the drainer', async () => {
    vi.useFakeTimers();
    try {
      const ci = vi.fn(async () => ({ url: 'u', number: 1 }));
      const ob = createFeedbackOutbox({ createIssue: ci, baseBackoffMs: 1000 });
      await ob.enqueue(issue());
      ob.start({ intervalMs: 1000 });
      ob.start({ intervalMs: 1000 }); // idempotent — must not add a second interval
      await vi.advanceTimersByTimeAsync(1000);
      expect(ci).toHaveBeenCalledTimes(1);
      ob.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(ci).toHaveBeenCalledTimes(1); // no more drains after stop
    } finally {
      vi.useRealTimers();
    }
  });
});
