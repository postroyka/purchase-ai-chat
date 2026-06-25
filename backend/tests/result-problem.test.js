import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp, problemMessage, PROBLEM_MESSAGES } from '../index.js';

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

// Mock spawn returning a different result per call (one per file in a batch).
function spawnSequence(results) {
  let i = 0;
  return () => spawnEmitting(results[i++] ?? {})();
}

// Mock spawn that fails (non-zero exit) → runAgent rejects → processJob's catch → status 'error'.
function failingSpawn() {
  return vi.fn(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    proc.kill = vi.fn();
    setImmediate(() => { proc.stderr.emit('data', 'agent boom'); proc.emit('close', 1); });
    return proc;
  });
}

// Upload `count` files through processJob with the given spawn, return the final /job/:id/status body.
async function runWith(spawnFn, count = 1) {
  const app = createApp({
    token: TOKEN, uploadDir: UPLOAD_DIR, rateLimitMax: 0,
    agentConfig: { spawnFn, extractFn: async () => null },
  });
  let req = request(app).post('/upload').set('Authorization', `Bearer ${TOKEN}`);
  for (let i = 0; i < count; i++) req = req.attach('files[]', validPdf(), { filename: `doc${i}.pdf` });
  const up = await req;
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

const runJob = (resultObj) => runWith(spawnEmitting(resultObj));

describe('problemMessage — code mapping (#192)', () => {
  it.each(Object.keys(PROBLEM_MESSAGES))('maps business code "%s" to its exact fixed message', (code) => {
    expect(problemMessage({ error: code })).toBe(PROBLEM_MESSAGES[code]);
  });

  it('unknown error code → generic "Не удалось обработать", distinct from the no-error line', () => {
    expect(problemMessage({ error: 'some_unknown_code' })).toBe('Не удалось обработать документ — сделка не создана.');
    expect(problemMessage({ error: 'some_unknown_code' })).not.toBe(problemMessage({}));
  });

  it('no error and no deal → generic "Сделка не создана…"', () => {
    expect(problemMessage({})).toMatch(/^Сделка не создана/);
  });

  it('does NOT echo the agent message (untrusted document text) — returns the fixed constant', () => {
    expect(problemMessage({ error: 'foreign_supplier', message: '<inject> ARBITRARY доктекст' }))
      .toBe(PROBLEM_MESSAGES.foreign_supplier);
    // prototype-chain key confusion is rejected → falls to the no-error/no-deal generic
    expect(problemMessage({ error: 'constructor' })).toBe('Не удалось обработать документ — сделка не создана.');
  });
});

describe('result surfacing — file without a deal (#192)', () => {
  it('business error → status done, file.problem = the exact mapped reason, no deal', async () => {
    const f = (await runJob({ error: 'supplier_not_found', message: 'нет', filePath: '/x' })).files[0];
    expect(f.status).toBe('done'); // processed, not an infra error
    expect(f.problem).toBe(PROBLEM_MESSAGES.supplier_not_found);
  });

  it('foreign supplier → exact mapped reason, agent message NOT echoed', async () => {
    const f = (await runJob({ error: 'foreign_supplier', message: '<inject> из документа' })).files[0];
    expect(f.problem).toBe(PROBLEM_MESSAGES.foreign_supplier);
    expect(f.problem).not.toContain('inject'); // agent/document message is NOT echoed
  });

  it('success (result carries a deal) → problem is null', async () => {
    const f = (await runJob({ supplier: { unp: '123456789' }, items: [], deal: { dealId: '777', url: null } })).files[0];
    expect(f.status).toBe('done');
    expect(f.problem == null).toBe(true);
    expect(f.result.deal.dealId).toBe('777');
  });

  it('a created deal WINS over an error code → problem is null', async () => {
    const f = (await runJob({ error: 'tool_unavailable', deal: { dealId: '9' } })).files[0];
    expect(f.problem == null).toBe(true);
  });

  it('done but NO deal and NO error → generic "Сделка не создана" (the screenshot case)', async () => {
    const f = (await runJob({ supplier: {}, items: [] })).files[0];
    expect(f.status).toBe('done');
    expect(f.problem).toBe('Сделка не создана — проверьте, что это счёт/спецификация (PDF или изображение).');
  });

  it('a large SUCCESS keeps the deal through truncation → no problem, deal still resolvable', async () => {
    // Build a result > MAX_RESULT_BYTES (100KB) that DID create a deal.
    const big = {
      deal: { dealId: '55', url: null },
      items: Array.from({ length: 6000 }, (_, i) => ({ name: `позиция ${'x'.repeat(20)} ${i}`, vendorCode: String(i) })),
    };
    const f = (await runJob(big)).files[0];
    expect(f.result.truncated).toBe(true);    // payload WAS truncated…
    expect(f.result.deal.dealId).toBe('55');  // …but the deal pointer survived (no #192 regression)
    expect(f.problem == null).toBe(true);
  });

  it('infra / thrown error → status error, fileEntry.error set, problem stays null', async () => {
    const f = (await runWith(failingSpawn())).files[0];
    expect(f.status).toBe('error');
    expect(f.error).toBeTruthy();
    expect(f.problem == null).toBe(true); // the business-`problem` path is not touched on a throw
  });

  it('mixed batch: per-file problem/null, job stays done, both deals + reasons surfaced', async () => {
    const body = await runWith(spawnSequence([
      { supplier: {}, deal: { dealId: '7' } }, // success
      { error: 'unsupported_currency' },        // no deal (терминальная ошибка; supplier_not_found теперь не блокирует)
    ]), 2);
    expect(body.status).toBe('done');
    const [a, b] = body.files;
    expect(a.problem == null).toBe(true);
    expect(a.result.deal.dealId).toBe('7');
    expect(b.problem).toBe(PROBLEM_MESSAGES.unsupported_currency);
  });

  it('the /job/:id/status route exposes the problem field', async () => {
    const f = (await runJob({ error: 'unsupported_currency' })).files[0];
    expect(f).toHaveProperty('problem');
    expect(f.problem).toBe(PROBLEM_MESSAGES.unsupported_currency);
  });
});
