import { describe, it, expect, vi } from 'vitest';
import { createNbrbRate } from '../nbrb-rate.js';

vi.spyOn(console, 'warn').mockImplementation(() => {});

// Fake fetch Response carrying an NBRB-shaped JSON body.
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
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

  it('caches the rate within the TTL (one fetch for repeated gets)', async () => {
    const fetchImpl = vi.fn(async () => ok(USD));
    const rate = createNbrbRate({ fetchImpl, ttlMs: 60_000 });
    await rate.get();
    await rate.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the static rate when fetch fails, and negative-caches it', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network'); });
    const rate = createNbrbRate({ fetchImpl, fallbackRate: 3.3, errorTtlMs: 60_000 });
    const r1 = await rate.get();
    expect(r1).toEqual({ rate: 3.3, date: null, source: 'env' });
    await rate.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // negative-cached — not retried every poll
  });

  it('serves the last good rate (stale) when a later refresh fails', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      if (call++ === 0) return ok(USD);
      throw new Error('nbrb down');
    });
    // ttlMs 0 forces the second get() to refresh (and hit the failure path).
    const rate = createNbrbRate({ fetchImpl, ttlMs: 0, fallbackRate: 3.3 });
    expect((await rate.get()).source).toBe('nbrb');
    const r2 = await rate.get();
    expect(r2).toEqual({ rate: 2.7727, date: '2026-06-11', source: 'nbrb-stale' });
  });

  it('rejects a malformed payload (missing/zero rate) and uses the fallback', async () => {
    const fetchImpl = vi.fn(async () => ok({ Cur_Scale: 1 })); // no Cur_OfficialRate
    const r = await createNbrbRate({ fetchImpl, fallbackRate: 3.3 }).get();
    expect(r.source).toBe('env');
    expect(r.rate).toBe(3.3);
  });

  it('treats a non-2xx response as a failure', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    const r = await createNbrbRate({ fetchImpl, fallbackRate: 3.3 }).get();
    expect(r.source).toBe('env');
  });
});
