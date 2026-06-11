import { describe, it, expect, vi } from 'vitest';
import { createNbrbRate } from '../nbrb-rate.js';

vi.spyOn(console, 'warn').mockImplementation(() => {});

// Fake fetch Response carrying an NBRB-shaped JSON body. The module reads res.text() and
// res.headers.get('content-length'), so the fake mirrors that surface.
const ok = (body, headers = {}) => ({
  ok: true,
  status: 200,
  headers: { get: (k) => headers[k] ?? null },
  text: async () => JSON.stringify(body),
});
const USD = { Cur_ID: 431, Date: '2026-06-11T00:00:00', Cur_Abbreviation: 'USD', Cur_Scale: 1, Cur_OfficialRate: 2.7727 };

describe('createNbrbRate', () => {
  it('parses the NBRB payload: rate = OfficialRate / Scale, date trimmed to a day', async () => {
    const fetchImpl = vi.fn(async () => ok(USD));
    const r = await createNbrbRate({ fetchImpl, fallbackRate: 3.3 }).get();
    expect(r).toEqual({ rate: 2.7727, date: '2026-06-11', source: 'nbrb' });
  });

  it('divides by Cur_Scale when scale > 1', async () => {
    const fetchImpl = vi.fn(async () => ok({ ...USD, Cur_Scale: 100, Cur_OfficialRate: 31.5 }));
    const r = await createNbrbRate({ fetchImpl }).get();
    expect(r.rate).toBeCloseTo(0.315, 6);
  });

  it('passes redirect:error and an abort signal to fetch', async () => {
    const fetchImpl = vi.fn(async () => ok(USD));
    await createNbrbRate({ fetchImpl }).get();
    const opts = fetchImpl.mock.calls[0][1];
    expect(opts.redirect).toBe('error');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('caches the rate within the TTL (one fetch for repeated gets)', async () => {
    const fetchImpl = vi.fn(async () => ok(USD));
    const rate = createNbrbRate({ fetchImpl, ttlMs: 60_000 });
    await rate.get();
    await rate.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refetches once the success TTL has expired (clock injected via nowFn)', async () => {
    let t = 1000;
    const fetchImpl = vi.fn(async () => ok(USD));
    const rate = createNbrbRate({ fetchImpl, ttlMs: 100, nowFn: () => t });
    await rate.get(); // fetch #1 @ t=1000
    t = 1050;
    await rate.get(); // within TTL → cached
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t = 1201;
    await rate.get(); // past TTL → refetch
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to the static rate when fetch fails, and negative-caches it', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network'); });
    const rate = createNbrbRate({ fetchImpl, fallbackRate: 3.3, errorTtlMs: 60_000 });
    const r1 = await rate.get();
    expect(r1).toEqual({ rate: 3.3, date: null, source: 'env' });
    await rate.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // negative-cached — not retried every poll
  });

  it('retries once the negative-cache TTL has expired', async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => { throw new Error('down'); });
    const rate = createNbrbRate({ fetchImpl, errorTtlMs: 100, fallbackRate: 3.3, nowFn: () => t });
    await rate.get(); // fetch #1 fails @ t=0
    t = 50;
    await rate.get(); // within error-TTL → no retry
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t = 101;
    await rate.get(); // past error-TTL → retry
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('serves the last good rate (stale) when a later refresh fails', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      if (call++ === 0) return ok(USD);
      throw new Error('nbrb down');
    });
    const rate = createNbrbRate({ fetchImpl, ttlMs: 0, fallbackRate: 3.3 }); // ttl 0 forces refresh
    expect((await rate.get()).source).toBe('nbrb');
    const r2 = await rate.get();
    expect(r2).toEqual({ rate: 2.7727, date: '2026-06-11', source: 'nbrb-stale' });
  });

  it('aborts and falls back when the request exceeds the timeout', async () => {
    // fetchImpl never resolves on its own; it rejects only when the abort signal fires.
    const fetchImpl = vi.fn((_url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const r = await createNbrbRate({ fetchImpl, timeoutMs: 10, fallbackRate: 3.3 }).get();
    expect(r.source).toBe('env');
  });

  it('dedupes concurrent get() calls into a single fetch', async () => {
    let resolveFetch;
    const fetchImpl = vi.fn(() => new Promise((res) => { resolveFetch = () => res(ok(USD)); }));
    const rate = createNbrbRate({ fetchImpl });
    const p1 = rate.get();
    const p2 = rate.get();
    resolveFetch();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it('uses the fallback when no fetch implementation is available (e.g. Node < 18)', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = undefined; // neither config.fetchImpl nor global fetch → guard trips
    try {
      const r = await createNbrbRate({ fallbackRate: 3.3 }).get();
      expect(r).toEqual({ rate: 3.3, date: null, source: 'env' });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('rejects a malformed payload (missing rate) and uses the fallback', async () => {
    const fetchImpl = vi.fn(async () => ok({ Cur_Scale: 1 })); // no Cur_OfficialRate
    const r = await createNbrbRate({ fetchImpl, fallbackRate: 3.3 }).get();
    expect(r.source).toBe('env');
    expect(r.rate).toBe(3.3);
  });

  it('rejects a non-positive Cur_Scale', async () => {
    const fetchImpl = vi.fn(async () => ok({ ...USD, Cur_Scale: 0 }));
    const r = await createNbrbRate({ fetchImpl, fallbackRate: 3.3 }).get();
    expect(r.source).toBe('env');
  });

  it('rejects an oversized response (content-length over the cap)', async () => {
    const fetchImpl = vi.fn(async () => ok(USD, { 'content-length': String(128 * 1024) }));
    const r = await createNbrbRate({ fetchImpl, fallbackRate: 3.3 }).get();
    expect(r.source).toBe('env');
  });

  it('treats a non-2xx response as a failure', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, headers: { get: () => null }, text: async () => '' }));
    const r = await createNbrbRate({ fetchImpl, fallbackRate: 3.3 }).get();
    expect(r.source).toBe('env');
  });
});
