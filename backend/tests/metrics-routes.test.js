import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp, classifyAgentError } from '../index.js';
import { createMetrics } from '../metrics.js';

vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

const TOKEN = 'metrics-test-token-xyz';
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'procure-metrics-test-'));

function appWith(extra = {}) {
  return createApp({ token: TOKEN, uploadDir: UPLOAD_DIR, rateLimitMax: 0, ...extra });
}

describe('GET /metrics/data', () => {
  it('returns a well-formed snapshot with Bearer auth', async () => {
    const res = await request(appWith()).get('/metrics/data').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ uploads: 0, files: 0, ok: 0 });
    expect(Array.isArray(res.body.outcomes)).toBe(true);
    expect(Array.isArray(res.body.daily)).toBe(true);
    // issue #182 — feedback/warnings breakdowns are part of the contract.
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(res.body.feedback).toEqual({ user: [], agent: [] });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(appWith()).get('/metrics/data');
    expect(res.status).toBe(401);
  });

  it('reflects recorded usage', async () => {
    const metrics = createMetrics({ redisUrl: '' });
    await metrics.recordUpload({ fileCount: 2 });
    await metrics.recordFile({
      format: 'pdf', status: 'done', outcome: 'ok', durationMs: 10,
      agent: { extractMethod: 'pdftotext', costUsd: 0.01, agentDurationMs: 10 },
    });
    const res = await request(appWith({ metrics })).get('/metrics/data').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.totals.uploads).toBe(1);
    expect(res.body.totals.files).toBe(2);
    expect(res.body.totals.ok).toBe(1);
    expect(res.body.formats).toContainEqual({ name: 'pdf', count: 1 });
    expect(res.body.extract).toContainEqual({ name: 'pdftotext', count: 1 });
  });
});

// The dashboard page itself is now a Nuxt route (ui/app/pages/metrics.vue) served as a static
// asset — no longer an Express route — so its rendering is covered by the UI build, not here.
// This suite owns the JSON contract at /metrics/data.

// Mock `claude --output-format json`: returns a valid wrapper carrying cost/turns/duration
// so the onMeta → recordFile path (extract method + cost) can be asserted end-to-end.
function makeAgentSpawn({ result = { status: 'stub' }, cost = 0.05 } = {}) {
  return vi.fn(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    proc.kill = vi.fn();
    setImmediate(() => {
      proc.stdout.emit('data', JSON.stringify({
        is_error: false,
        result: JSON.stringify(result),
        total_cost_usd: cost,
        duration_ms: 1234,
        num_turns: 3,
      }));
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

describe('metrics pipeline integration (upload → processJob → /metrics/data)', () => {
  it('records upload, format, extract method, outcome and cost from a real run', async () => {
    const metrics = createMetrics({ redisUrl: '' });
    const app = appWith({
      metrics,
      agentConfig: {
        spawnFn: makeAgentSpawn({
          // 3 line items, 2 without a supplier article (empty + missing vendorCode)
          result: { items: [{ vendorCode: 'A-1', name: 'X' }, { vendorCode: '', name: 'Y' }, { name: 'Z' }] },
          cost: 0.05,
        }),
        extractFn: async () => ({ text: 'СЧЁТ № 1', method: 'pdftotext' }),
      },
    });

    const up = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${TOKEN}`)
      .attach('files[]', validPdf(), 'invoice.pdf');
    expect(up.status).toBe(201);
    const jobId = up.body.jobId;

    // Wait for the job to finish so processJob has recorded the file metric.
    const deadline = Date.now() + 5000;
    let status = '';
    while (Date.now() < deadline) {
      const r = await request(app).get(`/job/${jobId}/status`).set('Authorization', `Bearer ${TOKEN}`);
      status = r.body.status;
      if (status === 'done' || status === 'error') break;
      await new Promise((res) => setTimeout(res, 30));
    }
    expect(status).toBe('done');

    const res = await request(app).get('/metrics/data').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.body.totals.uploads).toBe(1);
    expect(res.body.totals.files).toBe(1);
    expect(res.body.totals.ok).toBe(1);                                  // result had no { error }
    expect(res.body.formats).toContainEqual({ name: 'pdf', count: 1 });
    expect(res.body.extract).toContainEqual({ name: 'pdftotext', count: 1 }); // via onMeta
    expect(res.body.totals.costUsd).toBeCloseTo(0.05, 6);                // total_cost_usd captured
    expect(res.body.totals.costRuns).toBe(1);
    // economics (#75): positions + missing-article counted from items[]
    expect(res.body.economics.enabled).toBe(true);
    expect(res.body.economics.positions).toBe(3);
    expect(res.body.economics.positionsNoArticle).toBe(2);
    expect(res.body.economics.netSavedByn).toBeGreaterThan(0);
  });

  it('records a business error outcome (e.g. tool_unavailable) as done-but-not-ok', async () => {
    const metrics = createMetrics({ redisUrl: '' });
    const app = appWith({
      metrics,
      agentConfig: {
        spawnFn: makeAgentSpawn({ result: { error: 'tool_unavailable', tool: 'b24_pst_crm_find_supplier' } }),
        extractFn: async () => ({ text: 'СЧЁТ № 2', method: 'ocr' }),
      },
    });

    const up = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${TOKEN}`)
      .attach('files[]', validPdf(), 'scan.pdf');
    expect(await waitJob(app, up.body.jobId)).toBe('done');

    const res = await request(app).get('/metrics/data').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.body.totals.ok).toBe(0);
    expect(res.body.totals.filesDone).toBe(1); // resolved (not a thrown error) → done
    expect(res.body.outcomes).toContainEqual({ name: 'tool_unavailable', count: 1 });
  });
});

// Poll a job to a terminal state; returns the final status.
async function waitJob(app, jobId, maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  let status = '';
  while (Date.now() < deadline) {
    const r = await request(app).get(`/job/${jobId}/status`).set('Authorization', `Bearer ${TOKEN}`);
    status = r.body.status;
    if (status === 'done' || status === 'error') break;
    await new Promise((res) => setTimeout(res, 30));
  }
  return status;
}

function makeProcMock(emit) {
  return vi.fn(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    proc.kill = vi.fn();
    setImmediate(() => emit(proc));
    return proc;
  });
}

describe('metrics pipeline — error & edge paths', () => {
  it('records an infra failure (agent crash) as files_error + classified outcome', async () => {
    const metrics = createMetrics({ redisUrl: '' });
    const spawnFn = makeProcMock((proc) => { proc.stderr.emit('data', 'claude: command failed'); proc.emit('close', 2); });
    const app = appWith({ metrics, agentConfig: { spawnFn, extractFn: async () => ({ text: 't', method: 'pdftotext' }) } });

    const up = await request(app).post('/upload').set('Authorization', `Bearer ${TOKEN}`).attach('files[]', validPdf(), 'fail.pdf');
    expect(await waitJob(app, up.body.jobId)).toBe('error');

    const res = await request(app).get('/metrics/data').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.body.totals.filesError).toBe(1);
    expect(res.body.totals.filesDone).toBe(0);
    expect(res.body.outcomes).toContainEqual({ name: 'agent_crash', count: 1 });
  });

  it('does not record cost when the wrapper omits total_cost_usd (DeepSeek case)', async () => {
    const metrics = createMetrics({ redisUrl: '' });
    const spawnFn = makeProcMock((proc) => {
      // wrapper WITHOUT total_cost_usd
      proc.stdout.emit('data', JSON.stringify({ is_error: false, result: JSON.stringify({ items: [] }), duration_ms: 500 }));
      proc.emit('close', 0);
    });
    const app = appWith({ metrics, agentConfig: { spawnFn, extractFn: async () => null } });

    const up = await request(app).post('/upload').set('Authorization', `Bearer ${TOKEN}`).attach('files[]', validPdf(), 'inv.pdf');
    expect(await waitJob(app, up.body.jobId)).toBe('done');

    const res = await request(app).get('/metrics/data').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.body.totals.costRuns).toBe(0);
    expect(res.body.totals.costUsd).toBe(0);
    expect(Number.isFinite(res.body.totals.avgCostUsd)).toBe(true); // not NaN
    expect(res.body.totals.agentRuns).toBe(1);                      // agent still ran
  });
});

describe('GET /metrics/data — auth & robustness', () => {
  it('accepts an app session cookie + X-PAI-Auth header (in-browser dashboard)', async () => {
    const app = appWith({ basicAuthUser: 'op', basicAuthPass: 'secret-pass' });
    const cookie = (await request(app).post('/login').set('X-PAI-Auth', '1')
      .send({ username: 'op', password: 'secret-pass' })).headers['set-cookie'];
    const res = await request(app).get('/metrics/data').set('Cookie', cookie).set('X-PAI-Auth', '1');
    expect(res.status).toBe(200);
    expect(res.body.totals).toBeDefined();
  });

  it('returns 503 when snapshot fails', async () => {
    const metrics = {
      recordUpload: async () => {}, recordFile: async () => {}, ping: async () => {},
      snapshot: async () => { throw new Error('redis down'); },
    };
    const res = await request(appWith({ metrics })).get('/metrics/data').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
  });
});

describe('classifyAgentError', () => {
  it.each([
    ['Agent timed out after 300000ms', 'timeout'],
    ['Claude Code CLI not found at "claude". Set CLAUDE_CODE_BIN env var or ensure "claude" is in PATH.', 'cli_missing'],
    ['Agent process exited with code 1: claude: command failed', 'agent_crash'],
    ['Agent process exited with code 1: spawn ENOENT', 'agent_crash'], // embedded ENOENT must NOT read as cli_missing
    ['Agent output is not valid JSON. stdout: blah', 'bad_output'],
    ['Agent produced no JSON in its response. result: hello', 'bad_output'],
    ['Something completely unexpected', 'other_error'],
  ])('classifies %j → %s', (msg, expected) => {
    expect(classifyAgentError(msg)).toBe(expected);
  });
});
