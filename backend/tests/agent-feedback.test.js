import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../index.js';
import { createAgentFeedbackReporter } from '../agent-feedback.js';

// Best-effort module logs only an error code on failure — silence it.
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

const GH = 'ghp_agent_feedback_secret';
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);

// GitHub-shaped fetch stub that records each call's parsed JSON body.
function ghFetch({ ok = true, status = 201, number = 11 } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok, status, json: async () => ({ html_url: `https://github.com/o/r/issues/${number}`, number }) };
  });
  fn.calls = calls;
  return fn;
}

// ── Module: createAgentFeedbackReporter ───────────────────────────────────────

describe('createAgentFeedbackReporter', () => {
  it('is disabled without a token and never calls GitHub', async () => {
    const fetchImpl = ghFetch();
    const r = createAgentFeedbackReporter({ token: '', repo: 'o/r', fetchImpl });
    expect(r.enabled).toBe(false);
    expect(await r.report({ kind: 'problem', note: 'x' })).toMatchObject({ created: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips an empty note', async () => {
    const fetchImpl = ghFetch();
    const r = createAgentFeedbackReporter({ token: GH, repo: 'o/r', fetchImpl });
    expect(await r.report({ kind: 'problem', note: '   ' })).toMatchObject({ created: false, reason: 'empty' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('opens an issue on first occurrence with agent-feedback labels + context', async () => {
    const fetchImpl = ghFetch({ number: 7 });
    const r = createAgentFeedbackReporter({ token: GH, repo: 'o/r', fetchImpl });
    const out = await r.report({
      kind: 'problem', tool: 'b24_pst_crm_find_product', note: 'unexpected response shape',
      context: { jobId: 'job-1', fileName: 'p.xlsx' },
    });
    expect(out).toMatchObject({ created: true, number: 7 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = fetchImpl.calls[0].body;
    expect(body.labels).toEqual(['agent-feedback', 'feedback:problem']);
    expect(body.title.startsWith('[Агент] ')).toBe(true);
    expect(body.body).toContain('job-1');
    expect(body.body).toContain('p.xlsx');
  });

  it('dedups the same friction within the TTL (one issue, not one per file)', async () => {
    const fetchImpl = ghFetch();
    const r = createAgentFeedbackReporter({ token: GH, repo: 'o/r', fetchImpl });
    const a = await r.report({ kind: 'problem', tool: 't', note: 'Find contract is ambiguous!' });
    const b = await r.report({ kind: 'problem', tool: 't', note: '  find   CONTRACT is ambiguous ' }); // normalises equal
    expect(a).toMatchObject({ created: true });
    expect(b).toMatchObject({ created: false, reason: 'duplicate' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces the hourly cap as a backstop against bursts of distinct friction', async () => {
    const fetchImpl = ghFetch();
    const r = createAgentFeedbackReporter({ token: GH, repo: 'o/r', fetchImpl, hourlyCap: 1 });
    const a = await r.report({ kind: 'problem', note: 'first distinct' });
    const b = await r.report({ kind: 'problem', note: 'second distinct' });
    expect(a).toMatchObject({ created: true });
    expect(b).toMatchObject({ created: false, reason: 'rate_capped' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('is best-effort: a GitHub error does not throw and is not dedup-suppressed (real retry)', async () => {
    const failing = ghFetch({ ok: false, status: 500 });
    const r = createAgentFeedbackReporter({ token: GH, repo: 'o/r', fetchImpl: failing });
    const a = await r.report({ kind: 'problem', note: 'retryable' });
    const b = await r.report({ kind: 'problem', note: 'retryable' });
    expect(a).toMatchObject({ created: false, reason: 'error' });
    expect(b).toMatchObject({ created: false, reason: 'error' });
    expect(failing).toHaveBeenCalledTimes(2); // failed attempt didn't mark the friction seen
  });

  it('hostile-strips / HTML-escapes the agent note before it reaches GitHub', async () => {
    const fetchImpl = ghFetch();
    const r = createAgentFeedbackReporter({ token: GH, repo: 'o/r', fetchImpl });
    await r.report({ kind: 'problem', note: `bad${RLO} <b>x</b>${ZWSP}` });
    const body = fetchImpl.calls[0].body;
    expect(body.body).not.toContain(RLO);
    expect(body.body).not.toContain(ZWSP);
    expect(body.body).not.toContain('<b>');
    expect(body.body).toContain('&lt;b&gt;');
  });
});

// ── Integration: processJob wires agent warnings + feedback (channel «агент») ──

const TOKEN = 'agentfb-upload-token';
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'procure-agentfb-test-'));

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

function fakeMetrics(overrides = {}) {
  return {
    recordUpload: vi.fn(async () => {}),
    recordFile: vi.fn(async () => {}),
    recordWarnings: vi.fn(async () => {}),
    recordFeedback: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({})),
    ping: vi.fn(async () => {}),
    ...overrides,
  };
}

function validPdf() {
  const header = '%PDF-1.4\n';
  const obj = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const xref = 'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n';
  const trailer = `trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${header.length}\n%%EOF\n`;
  return Buffer.from(header + obj + xref + trailer);
}

async function pollJob(app, jobId, maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = await request(app).get(`/job/${jobId}/status`).set('Authorization', `Bearer ${TOKEN}`);
    if (r.body.status === 'done' || r.body.status === 'error') return r.body;
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error(`Job ${jobId} did not finish in ${maxMs}ms`);
}

async function runOneFile(resultObj, { metrics, agentFeedback }) {
  const app = createApp({
    token: TOKEN,
    uploadDir: UPLOAD_DIR,
    rateLimitMax: 0,
    agentConfig: { spawnFn: spawnEmitting(resultObj), extractFn: async () => null },
    metrics,
    agentFeedback,
  });
  const up = await request(app).post('/upload').set('Authorization', `Bearer ${TOKEN}`)
    .attach('files[]', validPdf(), { filename: 'invoice.pdf' });
  expect(up.status).toBe(201);
  await pollJob(app, up.body.jobId);
}

describe('processJob — agent feedback channel (#182)', () => {
  it('records warnings + agent feedback and hands the note to the reporter', async () => {
    const metrics = fakeMetrics();
    const report = vi.fn(async () => ({ created: true }));
    await runOneFile({
      supplier: { unp: '123456789' }, items: [], deal: { dealId: '1' },
      warnings: ['no_items_matched', 'articles_not_in_catalog'],
      feedback: [{ tool: 'b24_pst_crm_find_contract', kind: 'suggestion', note: 'дайте выбор договора по сумме' }],
    }, { metrics, agentFeedback: { enabled: true, report } });

    expect(metrics.recordWarnings).toHaveBeenCalledWith(['no_items_matched', 'articles_not_in_catalog']);
    expect(metrics.recordFeedback).toHaveBeenCalledWith({ source: 'agent', kind: 'suggestion' });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({
      tool: 'b24_pst_crm_find_contract', kind: 'suggestion',
      note: expect.stringContaining('договор'),
      context: expect.objectContaining({ fileName: 'invoice.pdf' }),
    });
  });

  it('does nothing extra for a clean result (no warnings / no feedback)', async () => {
    const metrics = fakeMetrics();
    const report = vi.fn(async () => ({ created: false }));
    await runOneFile({
      supplier: { unp: '123456789' }, deal: { dealId: '2' },
      items: [{ name: 'болт', vendorCode: 'A1', priceExclVat: 1, quantity: 1 }],
    }, { metrics, agentFeedback: { enabled: true, report } });

    expect(metrics.recordWarnings).not.toHaveBeenCalled();
    expect(metrics.recordFeedback).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('caps feedback entries per file at 10 and skips empty notes (anti-spam vs prompt-injection)', async () => {
    const metrics = fakeMetrics();
    const report = vi.fn(async () => ({ created: false, reason: 'duplicate' }));
    // First entry is empty (within the processed window → skipped); 14 real follow.
    const feedback = [{ kind: 'problem', note: '   ' }];
    for (let i = 0; i < 14; i++) feedback.push({ kind: 'problem', note: `friction ${i}` });
    await runOneFile({
      supplier: { unp: '123456789' }, items: [], deal: { dealId: '3' }, feedback,
    }, { metrics, agentFeedback: { enabled: true, report } });

    // slice(0,10) → [empty, friction0..friction8]; empty skipped → exactly 9 reports.
    expect(report).toHaveBeenCalledTimes(9);
  });
});
