import { describe, it, expect, vi } from 'vitest';
import { createMetrics } from '../metrics.js';

// Empty redisUrl forces the in-memory backend (hermetic — no Redis needed).
const mem = () => createMetrics({ redisUrl: '' });

describe('metrics (in-memory)', () => {
  it('records upload counts (uploads + files received)', async () => {
    const m = mem();
    await m.recordUpload({ fileCount: 3 });
    await m.recordUpload({ fileCount: 2 });
    const s = await m.snapshot();
    expect(s.totals.uploads).toBe(2);
    expect(s.totals.files).toBe(5);
  });

  it('records a successful file with format, outcome, extract method and cost', async () => {
    const m = mem();
    await m.recordFile({
      format: 'pdf', status: 'done', outcome: 'ok', durationMs: 4000,
      agent: { extractMethod: 'pdftotext', costUsd: 0.0021, agentDurationMs: 3000 },
    });
    const s = await m.snapshot();
    expect(s.totals.filesDone).toBe(1);
    expect(s.totals.ok).toBe(1);
    expect(s.formats).toContainEqual({ name: 'pdf', count: 1 });
    expect(s.outcomes).toContainEqual({ name: 'ok', count: 1 });
    expect(s.extract).toContainEqual({ name: 'pdftotext', count: 1 });
    expect(s.totals.costUsd).toBeCloseTo(0.0021, 6);
    expect(s.totals.costRuns).toBe(1);
    expect(s.totals.agentRuns).toBe(1);
    expect(s.totals.avgAgentMs).toBe(3000);
  });

  it('computes derived totals over a mixed batch', async () => {
    const m = mem();
    await m.recordUpload({ fileCount: 4 });
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'ok', durationMs: 1000, agent: { extractMethod: 'pdftotext', costUsd: 1, agentDurationMs: 1000, numTurns: 6 } });
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'tool_unavailable', durationMs: 1000, agent: { extractMethod: 'pdftotext', costUsd: 1, agentDurationMs: 3000, numTurns: 12 } });
    await m.recordFile({ format: 'jpg', status: 'done', outcome: 'ok', durationMs: 2000, agent: { extractMethod: 'ocr', costUsd: null, agentDurationMs: 2000, numTurns: 3 } });
    await m.recordFile({ format: 'xls', status: 'error', outcome: 'timeout', durationMs: 5000, agent: null });

    const s = await m.snapshot();
    expect(s.totals.files).toBe(4);
    expect(s.totals.ok).toBe(2);
    expect(s.totals.successRatePct).toBe(50);          // 2 ok / 4 received
    expect(s.totals.filesDone).toBe(3);
    expect(s.totals.filesError).toBe(1);
    // cost is averaged only over runs that actually reported a number (2 of 3 runs)
    expect(s.totals.costUsd).toBeCloseTo(2, 6);
    expect(s.totals.costRuns).toBe(2);
    expect(s.totals.avgCostUsd).toBeCloseTo(1, 6);
    // agent_runs counts every run with agent meta (the error file had agent=null)
    expect(s.totals.agentRuns).toBe(3);
    expect(s.totals.avgAgentMs).toBe(2000);            // (1000+3000+2000)/3
    expect(s.totals.avgAgentTurns).toBe(7);            // (6+12+3)/3 — среднее ходов (#222)
    expect(s.totals.avgFileMs).toBe(2250);             // (1000+1000+2000+5000)/4
  });

  it('returns breakdown arrays sorted by count desc', async () => {
    const m = mem();
    for (let i = 0; i < 3; i++) await m.recordFile({ format: 'pdf', status: 'done', outcome: 'ok', durationMs: 1, agent: null });
    await m.recordFile({ format: 'jpg', status: 'done', outcome: 'ok', durationMs: 1, agent: null });
    const s = await m.snapshot();
    expect(s.formats[0]).toEqual({ name: 'pdf', count: 3 });
    expect(s.formats[1]).toEqual({ name: 'jpg', count: 1 });
  });

  it('buckets files by UTC day', async () => {
    const m = mem();
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'ok', durationMs: 1, agent: null });
    const s = await m.snapshot();
    const today = new Date().toISOString().slice(0, 10);
    expect(s.daily).toContainEqual({ date: today, files: 1 });
  });

  it('sanitizes malformed / unbounded labels (cardinality guard)', async () => {
    const m = mem();
    await m.recordFile({ format: 'PDF!!', status: 'done', outcome: 'x'.repeat(80), durationMs: 0, agent: null });
    const s = await m.snapshot();
    expect(s.formats).toContainEqual({ name: 'unknown', count: 1 });   // 'PDF!!' invalid → unknown
    expect(s.outcomes.find((o) => o.name === 'unknown')).toBeTruthy(); // 80-char outcome → unknown
  });

  it('keeps known agent outcomes but buckets unknown ones as "other"', async () => {
    const m = mem();
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'supplier_not_found', durationMs: 0, agent: null }); // prompts/main.md (#71)
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'contract_not_found', durationMs: 0, agent: null }); // prompts/main.md (#71)
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'foreign_supplier', durationMs: 0, agent: null }); // prompts/main.md (#97)
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'totally_made_up_code', durationMs: 0, agent: null }); // valid shape, not whitelisted
    const s = await m.snapshot();
    expect(s.outcomes).toContainEqual({ name: 'supplier_not_found', count: 1 });
    expect(s.outcomes).toContainEqual({ name: 'contract_not_found', count: 1 });
    expect(s.outcomes).toContainEqual({ name: 'foreign_supplier', count: 1 });        // #97: именованный код, не 'other'
    expect(s.outcomes).toContainEqual({ name: 'other', count: 1 });                  // unknown code → capped
    expect(s.outcomes.find((o) => o.name === 'totally_made_up_code')).toBeFalsy();   // never stored verbatim
  });

  it('issue #207: распределение скорости — считает валидные бакеты, мусор/null пропускает', async () => {
    const m = mem();
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'ok', durationMs: 10, speed: 'fast' });
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'ok', durationMs: 20, speed: 'fast' });
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'ok', durationMs: 60000, speed: 'normal' });
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'ok', durationMs: 99000, speed: 'slow' });
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'ok', durationMs: 0, speed: null });        // не считаем
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'ok', durationMs: 0, speed: 'turbo' });      // мусор → не считаем
    const s = await m.snapshot();
    expect(s.speed).toContainEqual({ name: 'fast', count: 2 });
    expect(s.speed).toContainEqual({ name: 'normal', count: 1 });
    expect(s.speed).toContainEqual({ name: 'slow', count: 1 });
    expect(s.speed.find((x) => x.name === 'turbo')).toBeFalsy();
    expect(s.speed.reduce((n, x) => n + x.count, 0)).toBe(4); // null/мусор не попали
  });

  it('is best-effort: never throws on missing/garbage input', async () => {
    const m = mem();
    await expect(m.recordUpload({})).resolves.toBeUndefined();
    await expect(m.recordUpload({ fileCount: 'nope' })).resolves.toBeUndefined();
    await expect(m.recordFile({})).resolves.toBeUndefined();
    await expect(
      m.recordFile({ status: 'done', durationMs: NaN, agent: { costUsd: 'oops', agentDurationMs: 'x' } }),
    ).resolves.toBeUndefined();
    const s = await m.snapshot();
    expect(Number.isFinite(s.totals.avgFileMs)).toBe(true);
    expect(Number.isFinite(s.totals.costUsd)).toBe(true);
  });

  it('snapshot of an empty store is well-formed (no NaN)', async () => {
    const s = await mem().snapshot();
    expect(s.totals).toMatchObject({ uploads: 0, files: 0, ok: 0, successRatePct: 0, costUsd: 0, avgAgentMs: 0, avgAgentTurns: 0, avgFileMs: 0 });
    expect(s.outcomes).toEqual([]);
    expect(s.formats).toEqual([]);
    expect(s.daily).toEqual([]);
  });
});

describe('metrics — agent signals & feedback (#182)', () => {
  it('records agent warning codes, caps unknowns to "other", counts repeats', async () => {
    const m = mem();
    await m.recordWarnings(['no_items_matched', 'articles_not_in_catalog', 'no_items_matched', 'totally_made_up']);
    const s = await m.snapshot();
    expect(s.warnings).toContainEqual({ name: 'no_items_matched', count: 2 });
    expect(s.warnings).toContainEqual({ name: 'articles_not_in_catalog', count: 1 });
    expect(s.warnings).toContainEqual({ name: 'other', count: 1 });               // unknown code → capped
    expect(s.warnings.find((w) => w.name === 'totally_made_up')).toBeFalsy();      // never stored verbatim
  });

  it('is best-effort on warnings: ignores non-array / non-string entries', async () => {
    const m = mem();
    await expect(m.recordWarnings('nope')).resolves.toBeUndefined();
    await expect(m.recordWarnings([1, null, {}, 'no_items_matched'])).resolves.toBeUndefined();
    const s = await m.snapshot();
    expect(s.warnings).toContainEqual({ name: 'no_items_matched', count: 1 });     // only the valid string counted
  });

  it('caps the per-call warnings list at 20 (anti-cardinality-DoS)', async () => {
    const m = mem();
    const many = Array.from({ length: 50 }, () => 'no_items_matched');
    await m.recordWarnings(many);
    const s = await m.snapshot();
    expect(s.warnings).toContainEqual({ name: 'no_items_matched', count: 20 }); // only the first 20 counted
  });

  it('splits feedback counts by source (user vs agent) and kind', async () => {
    const m = mem();
    await m.recordFeedback({ source: 'user', kind: 'problem' });
    await m.recordFeedback({ source: 'user', kind: 'positive' });
    await m.recordFeedback({ source: 'agent', kind: 'suggestion' });
    await m.recordFeedback({ source: 'agent', kind: 'weird_kind' }); // unknown → other
    const s = await m.snapshot();
    expect(s.feedback.user).toContainEqual({ name: 'problem', count: 1 });
    expect(s.feedback.user).toContainEqual({ name: 'positive', count: 1 });
    expect(s.feedback.agent).toContainEqual({ name: 'suggestion', count: 1 });
    expect(s.feedback.agent).toContainEqual({ name: 'other', count: 1 });
    expect(s.feedback.user.find((f) => f.name === 'suggestion')).toBeFalsy();      // sources don't bleed
  });

  it('records the supplier УНП when supplier matching failed (channel «MCP»)', async () => {
    const m = mem();
    await m.recordMatching({ result: { error: 'supplier_not_found', unp: '100345678' } });
    await m.recordMatching({ result: { error: 'supplier_not_found', unp: '100345678' } });
    await m.recordMatching({ result: { error: 'supplier_not_found', unp: '222333444' } });
    const s = await m.snapshot();
    expect(s.matching.suppliers[0]).toEqual({ name: '100345678', count: 2 }); // sorted desc
    expect(s.matching.suppliers).toContainEqual({ name: '222333444', count: 1 });
  });

  it('coerces a numeric УНП to its digit-string key (model may emit raw JSON number)', async () => {
    const m = mem();
    await m.recordMatching({ result: { error: 'supplier_not_found', unp: 100345678 } });
    const s = await m.snapshot();
    expect(s.matching.suppliers).toContainEqual({ name: '100345678', count: 1 });
  });

  it('records matching only for supplier_not_found with a numeric УНП (ignores other/junk)', async () => {
    const m = mem();
    await m.recordMatching({ result: { deal: { dealId: '5' } } });                  // success
    await m.recordMatching({ result: { error: 'contract_not_found' } });             // other matching failure
    await m.recordMatching({ result: { error: 'supplier_not_found' } });             // no unp
    await m.recordMatching({ result: { error: 'supplier_not_found', unp: 'x' } });   // not numeric
    await m.recordMatching({ result: { error: 'supplier_not_found', unp: '<inject> доктекст' } }); // junk → no digits
    await m.recordMatching({});                                                       // no result
    const s = await m.snapshot();
    expect(s.matching.suppliers).toEqual([]);
  });

  it('caps distinct supplier keys, folding overflow into __other__ (cardinality guard)', async () => {
    const m = mem();
    for (let i = 0; i < 300; i++) await m.recordMatching({ result: { error: 'supplier_not_found', unp: String(100000 + i) } });
    for (let i = 0; i < 4; i++) await m.recordMatching({ result: { error: 'supplier_not_found', unp: String(900000 + i) } }); // NEW → fold
    await m.recordMatching({ result: { error: 'supplier_not_found', unp: '100000' } }); // known → still increments past cap
    const s = await m.snapshot();
    expect(s.matching.suppliers.find((x) => x.name === '__other__')).toEqual({ name: '__other__', count: 4 });
    expect(s.matching.suppliers.find((x) => x.name === '100000')).toEqual({ name: '100000', count: 2 });
  });

  it('issue #195: телеметрия v2 — мультиматчи по шагам + несопоставленные артикулы (санитизация/дедуп)', async () => {
    const m = mem();
    // мультиматч: product дважды, supplier один раз; bogus_step — не из набора → отброшен
    await m.recordMatching({ result: { matching: { multiMatches: ['supplier', 'product'], unmatchedArticles: ['ART-1', 'art-1', ''] } } });
    await m.recordMatching({ result: { matching: { multiMatches: ['product', 'bogus_step'], unmatchedArticles: ['ART-2'] } } });
    const s = await m.snapshot();
    expect(s.matching.multi).toContainEqual({ name: 'product', count: 2 });
    expect(s.matching.multi).toContainEqual({ name: 'supplier', count: 1 });
    expect(s.matching.multi.find((x) => x.name === 'bogus_step')).toBeFalsy(); // не из набора шагов
    // 'ART-1' и 'art-1' → один 'ART-1' (верхний регистр + дедуп в рамках файла); '' отброшен
    expect(s.matching.articles).toContainEqual({ name: 'ART-1', count: 1 });
    expect(s.matching.articles).toContainEqual({ name: 'ART-2', count: 1 });
  });

  it('issue #195: матчинг-телеметрия v2 сосуществует с v1 (supplier_not_found)', async () => {
    const m = mem();
    // результат с supplier_not_found И структурой matching — учитываются обе ветки
    await m.recordMatching({ result: { error: 'supplier_not_found', unp: '100345678', matching: { multiMatches: ['contract'], unmatchedArticles: ['Z-9'] } } });
    const s = await m.snapshot();
    expect(s.matching.suppliers).toContainEqual({ name: '100345678', count: 1 });
    expect(s.matching.multi).toContainEqual({ name: 'contract', count: 1 });
    expect(s.matching.articles).toContainEqual({ name: 'Z-9', count: 1 });
  });

  it('issue #195: кап различных артикулов (>300 → __other__), известный — инкремент', async () => {
    const m = mem();
    let k = 0;
    for (let call = 0; call < 6; call++) { // 6×50 = 300 различных артикулов (лимит 50 на вызов)
      const arts = [];
      for (let i = 0; i < 50; i++) arts.push('ART-' + (k++));
      await m.recordMatching({ result: { matching: { unmatchedArticles: arts } } });
    }
    // 5 НОВЫХ сверх капа → все в __other__; ART-0 известен → инкремент (счётчик до 2)
    await m.recordMatching({ result: { matching: { unmatchedArticles: ['NEW-1', 'NEW-2', 'NEW-3', 'NEW-4', 'NEW-5', 'ART-0'] } } });
    const s = await m.snapshot();
    expect(s.matching.articles.find((x) => x.name === '__other__')).toEqual({ name: '__other__', count: 5 });
    expect(s.matching.articles.find((x) => x.name === 'ART-0')).toEqual({ name: 'ART-0', count: 2 });
    expect(s.matching.articles.find((x) => x.name === 'NEW-1')).toBeFalsy(); // новые сверх капа не заводятся
  });

  it('issue #195: мультиматчи дедупятся в рамках файла (product зовётся по позиции)', async () => {
    const m = mem();
    // product дважды в одном результате (две позиции мультиматчнулись) → шаг считается ОДИН раз
    await m.recordMatching({ result: { matching: { multiMatches: ['product', 'product', 'supplier'] } } });
    const s = await m.snapshot();
    expect(s.matching.multi).toContainEqual({ name: 'product', count: 1 });   // не 2 — дедуп по файлу
    expect(s.matching.multi).toContainEqual({ name: 'supplier', count: 1 });
  });

  it('empty snapshot exposes well-formed warnings + feedback + matching', async () => {
    const s = await mem().snapshot();
    expect(s.warnings).toEqual([]);
    expect(s.feedback).toEqual({ user: [], agent: [] });
    expect(s.matching).toEqual({ suppliers: [], multi: [], articles: [] });
  });
});

describe('metrics economics (#75)', () => {
  const econMem = () => createMetrics({ redisUrl: '', hourlyRateByn: 18, minutesPerPosition: 2, usdBynRate: 3 });

  it('estimates savings from positions and flags missing-article loss', async () => {
    const m = econMem();
    await m.recordFile({
      format: 'pdf', status: 'done', outcome: 'ok', durationMs: 1000,
      agent: { extractMethod: 'pdftotext', costUsd: 0.10, agentDurationMs: 1000 },
      positions: 10, positionsNoArticle: 4,
    });
    const e = (await m.snapshot()).economics;
    expect(e.enabled).toBe(true);
    expect(e.positions).toBe(10);
    expect(e.positionsNoArticle).toBe(4);
    expect(e.positionsNoArticlePct).toBe(40);
    expect(e.grossSavedByn).toBeCloseTo(6, 2);       // 10 × 2/60 × 18
    expect(e.modelCostByn).toBeCloseTo(0.3, 2);       // 0.10 USD × 3
    expect(e.netSavedByn).toBeCloseTo(5.7, 2);
    expect(e.lostNoArticleByn).toBeCloseTo(2.4, 2);   // 4 × 2/60 × 18
  });

  it('clamps positionsNoArticle to positions and disables savings when rate is 0', async () => {
    const m = createMetrics({ redisUrl: '', hourlyRateByn: 0 });
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'ok', durationMs: 0, agent: null, positions: 3, positionsNoArticle: 99 });
    const e = (await m.snapshot()).economics;
    expect(e.enabled).toBe(false);
    expect(e.positionsNoArticle).toBe(3); // clamped to positions
    expect(e.grossSavedByn).toBe(0);
  });
});

describe('metrics — live USD→BYN rate provider (#75)', () => {
  // A failing provider logs a best-effort warning — silence it to keep CI output clean.
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const withCost = (m) => m.recordFile({
    format: 'pdf', status: 'done', outcome: 'ok', durationMs: 0,
    agent: { extractMethod: 'pdftotext', costUsd: 1, agentDurationMs: 1 },
  });

  it('uses the live rate from getUsdByn and surfaces its source + date', async () => {
    const m = createMetrics({
      redisUrl: '', hourlyRateByn: 18, usdBynRate: 3.3,
      getUsdByn: async () => ({ rate: 2.5, date: '2026-06-11', source: 'nbrb' }),
    });
    await withCost(m);
    const e = (await m.snapshot()).economics;
    expect(e.usdByn).toBe(2.5);
    expect(e.usdBynSource).toBe('nbrb');
    expect(e.usdBynDate).toBe('2026-06-11');
    expect(e.modelCostByn).toBeCloseTo(2.5, 2); // 1 USD × 2.5 (live), not the 3.3 fallback
  });

  it('falls back to the static env rate when the provider throws', async () => {
    const m = createMetrics({
      redisUrl: '', hourlyRateByn: 18, usdBynRate: 3.3,
      getUsdByn: async () => { throw new Error('nbrb down'); },
    });
    await withCost(m);
    const e = (await m.snapshot()).economics;
    expect(e.usdByn).toBe(3.3);
    expect(e.usdBynSource).toBe('env');
    expect(e.modelCostByn).toBeCloseTo(3.3, 2);
  });

  it('ignores an invalid live rate (≤ 0) and keeps the fallback for the cost calc', async () => {
    const m = createMetrics({
      redisUrl: '', hourlyRateByn: 18, usdBynRate: 3.3,
      getUsdByn: async () => ({ rate: 0, source: 'nbrb' }),
    });
    await withCost(m);
    const e = (await m.snapshot()).economics;
    expect(e.usdByn).toBe(3.3);
    expect(e.usdBynSource).toBe('env');
    expect(e.modelCostByn).toBeCloseTo(3.3, 2); // 1 USD × fallback 3.3, not the invalid 0
  });
});
