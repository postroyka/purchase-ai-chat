// Live USD→BYN official rate from the National Bank of the Republic of Belarus (api.nbrb.by).
// Used by the savings estimate (#75) to convert model cost (USD) → BYN. Best-effort: a 12h
// cache (the NB publishes once per business day) plus a static fallback so a NB outage never
// breaks /metrics. On failure we serve the last good rate if we have one, otherwise the
// configured fallback, and negative-cache briefly so a 30s dashboard poll can't hammer the API.
//
// Reference impl: https://github.com/bx-shef/currency-converter (rate = Cur_OfficialRate / Cur_Scale).

const NBRB_URL = 'https://api.nbrb.by/exrates/rates/USD?parammode=2';
const TTL_MS = 12 * 60 * 60 * 1000;       // success cache — NB updates once a day
const ERROR_TTL_MS = 5 * 60 * 1000;       // negative cache — don't retry a down API every poll
const TIMEOUT_MS = 4000;

/**
 * @param {{ fallbackRate?: number, url?: string, ttlMs?: number, errorTtlMs?: number,
 *           timeoutMs?: number, fetchImpl?: typeof fetch }} [config]
 * @returns {{ get: () => Promise<{ rate: number, date: string|null, source: 'nbrb'|'nbrb-stale'|'env' }> }}
 */
export function createNbrbRate(config = {}) {
  const fallbackRate = Number(config.fallbackRate) > 0 ? Number(config.fallbackRate) : 3.3;
  const url = config.url ?? NBRB_URL;
  const ttlMs = config.ttlMs ?? TTL_MS;
  const errorTtlMs = config.errorTtlMs ?? ERROR_TTL_MS;
  const timeoutMs = config.timeoutMs ?? TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  let cache = null; // { rate, date, source, at, ok }

  const strip = (c) => ({ rate: c.rate, date: c.date, source: c.source });
  const fresh = () => cache && (Date.now() - cache.at) < (cache.ok ? ttlMs : errorTtlMs);

  async function get() {
    if (fresh()) return strip(cache);
    try {
      if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let data;
      try {
        const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      } finally {
        clearTimeout(timer);
      }
      const scale = Number(data?.Cur_Scale) || 1;
      const official = Number(data?.Cur_OfficialRate);
      if (!Number.isFinite(official) || official <= 0) throw new Error('bad payload');
      const rate = Math.round((official / scale) * 10000) / 10000;
      const date = typeof data?.Date === 'string' ? data.Date.slice(0, 10) : null;
      cache = { rate, date, source: 'nbrb', at: Date.now(), ok: true };
      return strip(cache);
    } catch (e) {
      console.warn(`[nbrb] rate fetch failed: ${e?.message ?? e} — using ${cache?.ok ? 'last good' : 'fallback'}`);
      // Prefer the last good rate (marked stale); else the static fallback. Negative-cache either.
      const prevOk = cache?.ok ? cache : null;
      cache = {
        rate: prevOk ? prevOk.rate : fallbackRate,
        date: prevOk ? prevOk.date : null,
        source: prevOk ? 'nbrb-stale' : 'env',
        at: Date.now(),
        ok: false,
      };
      return strip(cache);
    }
  }

  return { get };
}
