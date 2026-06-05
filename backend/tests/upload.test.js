import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

// Suppress expected in-memory store warnings — not a test concern
vi.spyOn(console, 'warn').mockImplementation(() => {});

const app = createApp({ token: TOKEN, uploadDir: UPLOAD_DIR });
const auth = () => `Bearer ${TOKEN}`;

function makeValidPdfBuffer() {
  const header = '%PDF-1.4\n';
  const obj = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const xref = 'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n';
  const trailer = `trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n${header.length}\n%%EOF\n`;
  return Buffer.from(header + obj + xref + trailer);
}

beforeAll(() => {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, 'valid.pdf'), makeValidPdfBuffer());
  fs.writeFileSync(path.join(FIXTURES, 'fake.pdf'), Buffer.from('this is not a pdf'));
  fs.writeFileSync(path.join(FIXTURES, 'script.exe'), Buffer.from([0x4d, 0x5a]));
  // 2 KB filler — large enough to reliably trigger LIMIT_FILE_SIZE at a 1 KB limit
  fs.writeFileSync(path.join(FIXTURES, 'large.pdf'), Buffer.alloc(2048, 0x25));
});

afterAll(() => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  fs.rmSync(FIXTURES, { recursive: true, force: true });
});

// ── Health ──────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns ok without auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
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
});
