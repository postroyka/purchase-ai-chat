import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../index.js';

// issue #192 — a file that finished WITHOUT a created deal (business error or unrecognised document)
// must carry a human-readable `problem` so the result page shows the reason, not a bare green "Готово".

vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const TOKEN = 'result-problem-token';
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'procure-resultprob-'));

// Mock `claude` spawn that emits a chosen agent result object as the CLI's JSON output.
function spawnEmitting(resultObj) {
  return vi.fn(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    proc.kill = vi.fn();
    setImmediate(() => {
      proc.stdout.emit('data', JSON.stringify({ is_error: false, result: JSON.stringify(resultObj) }));
      proc.emit('close', 0);
    });
    return proc;
  });
}

function validPdf() {
  const header = '%PDF-1.4\n';
  const obj = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const xref = 'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n';
  const trailer = `trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${header.length}\n%%EOF\n`;
  return Buffer.from(header + obj + xref + trailer);
}

// Upload one file, drive it through processJob, and return the final /job/:id/status body.
async function runJob(resultObj) {
  const app = createApp({
    token: TOKEN, uploadDir: UPLOAD_DIR, rateLimitMax: 0,
    agentConfig: { spawnFn: spawnEmitting(resultObj), extractFn: async () => null },
  });
  const up = await request(app).post('/upload').set('Authorization', `Bearer ${TOKEN}`)
    .attach('files[]', validPdf(), { filename: 'doc.pdf' });
  expect(up.status).toBe(201);
  const jobId = up.body.jobId;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = await request(app).get(`/job/${jobId}/status`).set('Authorization', `Bearer ${TOKEN}`);
    if (r.body.status === 'done' || r.body.status === 'error') return r.body;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('job did not finish');
}

describe('result surfacing — file without a deal (#192)', () => {
  it('business error → status done, file.problem = mapped RU reason, no deal', async () => {
    const f = (await runJob({ error: 'supplier_not_found', message: 'нет', filePath: '/x' })).files[0];
    expect(f.status).toBe('done'); // processed, not an infra error
    expect(f.problem).toMatch(/Поставщик не найден/);
  });

  it('foreign supplier → problem explains РФ реквизиты (mapped, not echoed agent message)', async () => {
    const f = (await runJob({ error: 'foreign_supplier', message: '<inject> из документа' })).files[0];
    expect(f.problem).toMatch(/не из РБ/);
    expect(f.problem).not.toContain('inject'); // agent/document message is NOT echoed
  });

  it('success (result carries a deal) → problem is null', async () => {
    const f = (await runJob({ supplier: { unp: '123456789' }, items: [], deal: { dealId: '777', url: null } })).files[0];
    expect(f.status).toBe('done');
    expect(f.problem == null).toBe(true);
    expect(f.result.deal.dealId).toBe('777');
  });

  it('done but NO deal and NO error → generic "сделка не создана" problem', async () => {
    const f = (await runJob({ supplier: {}, items: [] })).files[0]; // e.g. a screenshot the agent couldn't turn into a deal
    expect(f.status).toBe('done');
    expect(f.problem).toMatch(/Сделка не создана/);
  });

  it('the /job/:id/status route exposes the problem field', async () => {
    const f = (await runJob({ error: 'unsupported_currency' })).files[0];
    expect(f).toHaveProperty('problem');
    expect(f.problem).toMatch(/BYN/);
  });
});
