import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createApp } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN = 'test-upload-token-abc123';
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'procure-upload-test-'));
const FIXTURES = path.join(__dirname, 'fixtures');

// Suppress expected in-memory store warnings/logs — not a test concern
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

// Mock spawnFn: simulates `claude --output-format json` returning a valid stub result.
// Prevents tests from requiring the real `claude` binary to be installed.
function makeMockAgentSpawn() {
  return vi.fn(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: vi.fn() };
    proc.kill = vi.fn();
    setImmediate(() => {
      proc.stdout.emit('data', JSON.stringify({
        is_error: false,
        result: JSON.stringify({ status: 'stub', message: 'mock agent response' }),
      }));
      proc.emit('close', 0);
    });
    return proc;
  });
}

// Spawn mock that always fails (non-zero exit) — runAgent rejects → file status 'error'.
function makeFailingAgentSpawn() {
  return vi.fn(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: vi.fn() };
    proc.kill = vi.fn();
    setImmediate(() => {
      proc.stderr.emit('data', 'agent boom');
      proc.emit('close', 1);
    });
    return proc;
  });
}

// Spawn mock driven by a per-call success/failure sequence (e.g. [true, false]).
function makeSequencedAgentSpawn(outcomes) {
  let i = 0;
  return vi.fn(() => {
    const ok = outcomes[i++] ?? true;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: vi.fn() };
    proc.kill = vi.fn();
    setImmediate(() => {
      if (ok) {
        proc.stdout.emit('data', JSON.stringify({
          is_error: false,
          result: JSON.stringify({ status: 'stub' }),
        }));
        proc.emit('close', 0);
      } else {
        proc.stderr.emit('data', 'agent boom');
        proc.emit('close', 1);
      }
    });
    return proc;
  });
}

// Poll a specific app instance's job until terminal state.
async function pollJob(appInstance, jobId, maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = await request(appInstance)
      .get(`/job/${jobId}/status`)
      .set('Authorization', auth());
    if (r.body.status === 'done' || r.body.status === 'error') return r.body;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`Job ${jobId} did not reach terminal state in ${maxMs}ms`);
}

const app = createApp({
  token: TOKEN,
  uploadDir: UPLOAD_DIR,
  agentConfig: { spawnFn: makeMockAgentSpawn() },
});
const auth = () => `Bearer ${TOKEN}`;

function makeValidPdfBuffer() {
  const header = '%PDF-1.4\n';
  const obj = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const xref = 'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n';
  const trailer = `trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${header.length}\n%%EOF\n`;
  return Buffer.from(header + obj + xref + trailer);
}

// Minimal valid ZIP (empty archive) — xlsx/docx are ZIP-based.
// file-type detects this as application/zip, which is allowed for xlsx/docx extensions.
function makeMinimalZipBuffer() {
  // End-of-central-directory record only: PK\x05\x06 + 18 zero bytes = 22 bytes
  return Buffer.from([
    0x50, 0x4b, 0x05, 0x06, // EOCD signature
    0x00, 0x00, 0x00, 0x00, // disk number, start disk
    0x00, 0x00, 0x00, 0x00, // entries on disk, total entries
    0x00, 0x00, 0x00, 0x00, // central dir size
    0x00, 0x00, 0x00, 0x00, // central dir offset
    0x00, 0x00,             // comment length
  ]);
}

// Poll job status until terminal state or timeout.
async function waitForJob(jobId, maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await request(app)
      .get(`/job/${jobId}/status`)
      .set('Authorization', auth());
    if (res.body.status === 'done' || res.body.status === 'error') return res.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Job ${jobId} did not reach terminal state in ${maxMs}ms`);
}

beforeAll(() => {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, 'valid.pdf'), makeValidPdfBuffer());
  fs.writeFileSync(path.join(FIXTURES, 'fake.pdf'), Buffer.from('this is not a pdf'));
  fs.writeFileSync(path.join(FIXTURES, 'script.exe'), Buffer.from([0x4d, 0x5a]));
  // 2 KB filler — large enough to reliably trigger LIMIT_FILE_SIZE at a 1 KB limit
  fs.writeFileSync(path.join(FIXTURES, 'large.pdf'), Buffer.alloc(2048, 0x25));
  // Minimal valid ZIP used as xlsx/docx fixtures
  const zip = makeMinimalZipBuffer();
  fs.writeFileSync(path.join(FIXTURES, 'valid.xlsx'), zip);
  fs.writeFileSync(path.join(FIXTURES, 'valid.docx'), zip);
});

afterAll(() => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  fs.rmSync(FIXTURES, { recursive: true, force: true });
});

// ── Health ──────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns ok with redis status, no auth required', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.redis).toBe('ok');
  });

  it('returns 503 when jobs store ping fails', async () => {
    const brokenJobs = {
      get: async () => null,
      set: async () => {},
      ping: async () => { throw new Error('Redis connection refused'); },
    };
    const brokenApp = createApp({ token: TOKEN, uploadDir: UPLOAD_DIR, jobs: brokenJobs });
    const res = await request(brokenApp).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.redis).toBe('unavailable');
  });
});

// ── Auth ────────────────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  it('returns 503 when token is empty (service not configured)', async () => {
    const unconfigured = createApp({ token: '', uploadDir: UPLOAD_DIR });
    const res = await request(unconfigured).post('/upload');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('returns 503 when token is the placeholder value', async () => {
    const placeholder = createApp({
      token: 'replace-with-secure-token',
      uploadDir: UPLOAD_DIR,
    });
    const res = await request(placeholder).post('/upload');
    expect(res.status).toBe(503);
  });

  it('returns 503 on /job/:id/status when token is the placeholder (with Bearer header)', async () => {
    const placeholder = createApp({
      token: 'replace-with-secure-token',
      uploadDir: UPLOAD_DIR,
    });
    const res = await request(placeholder)
      .get('/job/some-id/status')
      .set('Authorization', 'Bearer replace-with-secure-token');
    expect(res.status).toBe(503);
  });

  it('returns 401 on /upload without Authorization header', async () => {
    const res = await request(app).post('/upload');
    expect(res.status).toBe(401);
  });

  it('returns 401 on /upload with wrong token', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  it('returns 401 on /job/:id/status without Authorization header', async () => {
    const res = await request(app).get('/job/some-id/status');
    expect(res.status).toBe(401);
  });

  it('returns 401 on /job/:id/status with wrong token', async () => {
    const res = await request(app)
      .get('/job/some-id/status')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });
});

// ── POST /upload ─────────────────────────────────────────────────────────────

describe('POST /upload', () => {
  it('returns 400 when no files attached', async () => {
    const res = await request(app).post('/upload').set('Authorization', auth());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no files/i);
  });

  it('returns 400 for disallowed extension', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'script.exe'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  it('returns 400 for MIME mismatch (fake PDF)', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'fake.pdf'), { contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid content type/i);
  });

  it('accepts a valid PDF and returns 201 with jobId', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('jobId');
    expect(typeof res.body.jobId).toBe('string');
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].status).toBe('pending');
  });

  it('respects maxFilesPerRequest limit', async () => {
    const limited = createApp({ token: TOKEN, uploadDir: UPLOAD_DIR, maxFilesPerRequest: 1 });
    const res = await request(limited)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' })
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too many files/i);
  });

  // NOTE: LIMIT_FILE_SIZE cannot be reliably tested with supertest — it buffers
  // the entire request in memory before sending, so busboy never fires the 'limit'
  // event during streaming. Integration tests with a real HTTP client are needed.
});

// ── GET /job/:id/status ───────────────────────────────────────────────────────

describe('GET /job/:id/status', () => {
  it('returns 404 for unknown jobId', async () => {
    const res = await request(app)
      .get('/job/nonexistent-id/status')
      .set('Authorization', auth());
    expect(res.status).toBe(404);
  });

  it('returns job status after upload', async () => {
    const upload = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' });
    expect(upload.status).toBe(201);

    const status = await request(app)
      .get(`/job/${upload.body.jobId}/status`)
      .set('Authorization', auth());
    expect(status.status).toBe(200);
    expect(status.body.jobId).toBe(upload.body.jobId);
    expect(['pending', 'processing', 'done']).toContain(status.body.status);
  });

  it('response includes files array with name/status/result/error fields', async () => {
    const upload = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' });
    expect(upload.status).toBe(201);

    const job = await waitForJob(upload.body.jobId);
    expect(job.files).toHaveLength(1);
    const file = job.files[0];
    expect(file).toHaveProperty('name');
    expect(file).toHaveProperty('status');
    expect(file).toHaveProperty('result');
    expect(file).toHaveProperty('error');
    expect(file.name).toBe('valid.pdf');
  });
});

// ── xlsx / docx happy path ────────────────────────────────────────────────────

describe('xlsx and docx upload', () => {
  it('accepts a valid .xlsx file', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'valid.xlsx'), {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    expect(res.status).toBe(201);
    expect(res.body.files[0].name).toBe('valid.xlsx');
  });

  it('accepts a valid .docx file', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'valid.docx'), {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
    expect(res.status).toBe(201);
    expect(res.body.files[0].name).toBe('valid.docx');
  });
});

// ── Multi-file upload ─────────────────────────────────────────────────────────

describe('Multi-file upload', () => {
  it('accepts multiple files in one request', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' })
      .attach('files[]', path.join(FIXTURES, 'valid.xlsx'), {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    expect(res.status).toBe(201);
    expect(res.body.files).toHaveLength(2);
    expect(res.body.files.map((f) => f.name)).toEqual(
      expect.arrayContaining(['valid.pdf', 'valid.xlsx']),
    );
  });
});

// ── File cleanup after job ────────────────────────────────────────────────────

describe('File cleanup', () => {
  it('removes job directory from disk after job completes', async () => {
    const upload = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' });
    expect(upload.status).toBe(201);

    const jobId = upload.body.jobId;
    const jobDir = path.join(UPLOAD_DIR, jobId);

    await waitForJob(jobId);

    // Directory removed after job finishes (stub agent completes instantly)
    expect(fs.existsSync(jobDir)).toBe(false);
  });
});

// ── responsibleUserId validation ──────────────────────────────────────────────

describe('responsibleUserId validation', () => {
  it('rejects a non-numeric responsibleUserId with 400', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .field('responsibleUserId', 'abc; rm -rf /')
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/responsibleUserId/);
  });

  it('accepts a numeric responsibleUserId', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .field('responsibleUserId', '20')
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    await waitForJob(res.body.jobId);
  });
});

// ── Security headers ──────────────────────────────────────────────────────────

describe('Security headers', () => {
  it('sets baseline headers and hides X-Powered-By', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

// ── processJob error handling ─────────────────────────────────────────────────

describe('processJob error handling', () => {
  it('marks job as error when all files fail', async () => {
    const failApp = createApp({
      token: TOKEN,
      uploadDir: UPLOAD_DIR,
      agentConfig: { spawnFn: makeFailingAgentSpawn() },
    });
    const res = await request(failApp)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' });
    expect(res.status).toBe(201);

    const body = await pollJob(failApp, res.body.jobId);
    expect(body.status).toBe('error');
    expect(body.files[0].status).toBe('error');
    expect(typeof body.files[0].error).toBe('string');
  });

  it('keeps job "done" on partial failure but marks the failed file', async () => {
    const seqApp = createApp({
      token: TOKEN,
      uploadDir: UPLOAD_DIR,
      // First file succeeds, second fails.
      agentConfig: { spawnFn: makeSequencedAgentSpawn([true, false]) },
    });
    const res = await request(seqApp)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' })
      .attach('files[]', path.join(FIXTURES, 'valid.xlsx'), { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(res.status).toBe(201);

    const body = await pollJob(seqApp, res.body.jobId);
    expect(body.status).toBe('done');
    expect(body.files.map((f) => f.status).sort()).toEqual(['done', 'error']);
  });
});
