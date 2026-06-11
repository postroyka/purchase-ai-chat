import { describe, it, expect } from 'vitest';
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
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'ok', durationMs: 1000, agent: { extractMethod: 'pdftotext', costUsd: 1, agentDurationMs: 1000 } });
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'tool_unavailable', durationMs: 1000, agent: { extractMethod: 'pdftotext', costUsd: 1, agentDurationMs: 3000 } });
    await m.recordFile({ format: 'jpg', status: 'done', outcome: 'ok', durationMs: 2000, agent: { extractMethod: 'ocr', costUsd: null, agentDurationMs: 2000 } });
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
    await m.recordFile({ format: 'pdf', status: 'done', outcome: 'totally_made_up_code', durationMs: 0, agent: null }); // valid shape, not whitelisted
    const s = await m.snapshot();
    expect(s.outcomes).toContainEqual({ name: 'supplier_not_found', count: 1 });
    expect(s.outcomes).toContainEqual({ name: 'contract_not_found', count: 1 });
    expect(s.outcomes).toContainEqual({ name: 'other', count: 1 });                  // unknown code → capped
    expect(s.outcomes.find((o) => o.name === 'totally_made_up_code')).toBeFalsy();   // never stored verbatim
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
    expect(s.totals).toMatchObject({ uploads: 0, files: 0, ok: 0, successRatePct: 0, costUsd: 0, avgAgentMs: 0, avgFileMs: 0 });
    expect(s.outcomes).toEqual([]);
    expect(s.formats).toEqual([]);
    expect(s.daily).toEqual([]);
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
