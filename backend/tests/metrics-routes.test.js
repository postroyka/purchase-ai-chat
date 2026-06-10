import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../index.js';
import { createMetrics } from '../metrics.js';

vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

const TOKEN = 'metrics-test-token-xyz';
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'procure-metrics-test-'));

function appWith(extra = {}) {
  return createApp({ token: TOKEN, uploadDir: UPLOAD_DIR, rateLimitMax: 0, ...extra });
}

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

describe('GET /metrics/data', () => {
  it('returns a well-formed snapshot with Bearer auth', async () => {
    const res = await request(appWith()).get('/metrics/data').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ uploads: 0, files: 0, ok: 0 });
    expect(Array.isArray(res.body.outcomes)).toBe(true);
    expect(Array.isArray(res.body.daily)).toBe(true);
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

describe('GET /metrics (dashboard page)', () => {
  const pageApp = () => appWith({ basicAuthUser: 'op', basicAuthPass: 'secret-pass', publicPageEnabled: true });

  it('serves HTML when page Basic auth is configured and valid', async () => {
    const res = await request(pageApp()).get('/metrics').set('Authorization', basic('op', 'secret-pass'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Procure AI');
    expect(res.text).toContain('/metrics/data'); // page fetches the JSON snapshot
  });

  it('challenges with 401 + WWW-Authenticate when no credentials', async () => {
    const res = await request(pageApp()).get('/metrics');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Basic/);
  });

  it('returns 503 when page Basic auth is not configured', async () => {
    const res = await request(appWith()).get('/metrics');
    expect(res.status).toBe(503);
  });
});

// Mock `claude --output-format json`: returns a valid wrapper carrying cost/turns/duration
// so the onMeta → recordFile path (extract method + cost) can be asserted end-to-end.
function makeAgentSpawn({ result = { status: 'stub' }, cost = 0.05 } = {}) {
  return vi.fn(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: vi.fn() };
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
    const jobId = up.body.jobId;

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = await request(app).get(`/job/${jobId}/status`).set('Authorization', `Bearer ${TOKEN}`);
      if (r.body.status === 'done' || r.body.status === 'error') break;
      await new Promise((res) => setTimeout(res, 30));
    }

    const res = await request(app).get('/metrics/data').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.body.totals.ok).toBe(0);
    expect(res.body.totals.filesDone).toBe(1); // resolved (not a thrown error) → done
    expect(res.body.outcomes).toContainEqual({ name: 'tool_unavailable', count: 1 });
  });
});
