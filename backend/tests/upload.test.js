import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Set env before import so jobs-store and auth use correct values
process.env.REDIS_URL = '';
process.env.BACKEND_API_TOKEN = '';
process.env.UPLOAD_DIR = path.join(__dirname, '../uploads-test');

const { app } = await import('../index.js');

const FIXTURES = path.join(__dirname, 'fixtures');

// Minimal valid PDF (256 bytes) — enough for file-type to detect application/pdf
function makeValidPdfBuffer() {
  // Minimal PDF 1.4 structure that file-type recognises as application/pdf
  const header = '%PDF-1.4\n';
  const obj = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const xref = 'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n';
  const trailer = 'trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n' + header.length + '\n%%EOF\n';
  return Buffer.from(header + obj + xref + trailer);
}

beforeAll(() => {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, 'valid.pdf'), makeValidPdfBuffer());
  fs.writeFileSync(path.join(FIXTURES, 'fake.pdf'), Buffer.from('this is not a pdf at all'));
  fs.writeFileSync(path.join(FIXTURES, 'script.exe'), Buffer.from([0x4d, 0x5a]));
});

afterAll(() => {
  fs.rmSync(path.join(__dirname, '../uploads-test'), { recursive: true, force: true });
  fs.rmSync(FIXTURES, { recursive: true, force: true });
});

describe('GET /health', () => {
  it('returns ok without auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Auth middleware — no token configured (dev mode blocked)', () => {
  it('returns 503 when BACKEND_API_TOKEN is empty', async () => {
    // env is '' — service not configured → 503
    const res = await request(app).post('/upload');
    expect(res.status).toBe(503);
  });

  // NOTE: the placeholder-token (503) case is covered in auth-placeholder.test.js.
  // BACKEND_API_TOKEN is captured into a module-scope constant at import time, so
  // mutating process.env *after* importing index.js here has no effect — that
  // would be a false-green test. The dedicated file sets the env before import.
});

describe('POST /upload (auth bypassed via empty token in this test suite)', () => {
  // BACKEND_API_TOKEN='' → 503 for all upload requests in this file.
  // Upload functional tests run in upload-noauth.test.js which sets a real token.
  it('returns 503 without token set', async () => {
    const res = await request(app).post('/upload');
    expect(res.status).toBe(503);
  });
});

describe('GET /job/:id/status', () => {
  it('returns 503 when token not configured', async () => {
    const res = await request(app).get('/job/some-id/status');
    expect(res.status).toBe(503);
  });
});
