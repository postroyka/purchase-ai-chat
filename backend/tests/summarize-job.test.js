import { describe, it, expect } from 'vitest';
import { summarizeJob } from '../index.js';

// #44 (P2): структурная сводка задания для JSON-лога завершения.
describe('summarizeJob', () => {
  it('считает файлы по статусам и суммирует durationMs', () => {
    const job = {
      jobId: 'j1',
      status: 'done',
      files: [
        { status: 'done', durationMs: 1000 },
        { status: 'done', durationMs: 2000 },
        { status: 'error', durationMs: 500 },
      ],
    };
    expect(summarizeJob(job)).toEqual({
      jobId: 'j1',
      status: 'done',
      files: 3,
      byStatus: { done: 2, error: 1 },
      totalMs: 3500,
    });
  });

  it('устойчива к отсутствию полей (пустой/битый job)', () => {
    expect(summarizeJob({})).toEqual({ jobId: null, status: null, files: 0, byStatus: {}, totalMs: 0 });
    expect(summarizeJob(null)).toEqual({ jobId: null, status: null, files: 0, byStatus: {}, totalMs: 0 });
    expect(summarizeJob({ jobId: 'x', status: 'cancelled', files: [{ status: 'cancelled' }] }))
      .toEqual({ jobId: 'x', status: 'cancelled', files: 1, byStatus: { cancelled: 1 }, totalMs: 0 });
  });

  it('файл без статуса попадает в bucket unknown, нефинитный durationMs игнорируется', () => {
    const s = summarizeJob({ jobId: 'j', status: 'done', files: [{ durationMs: NaN }, {}] });
    expect(s.byStatus).toEqual({ unknown: 2 });
    expect(s.totalMs).toBe(0);
  });
});
