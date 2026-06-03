/**
 * Functional upload tests with a real auth token.
 * Uses a separate module import so the token is set before ESM caches index.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '../uploads-test-functional');
const TOKEN = 'test-functional-token-abc123';
const FIXTURES = path.join(__dirname, 'fixtures-functional');

// Must be set before import
process.env.REDIS_URL = '';
process.env.BACKEND_API_TOKEN = TOKEN;
process.env.UPLOAD_DIR = UPLOAD_DIR;

// Dynamic import with cache-busting via query string is not possible in Vitest ESM.
// Instead this file is loaded in isolation (separate vitest worker) so the module
// cache is fresh and picks up the env vars above.
const { app } = await import('../index.js?functional=1');

function auth() {
  return `Bearer ${TOKEN}`;
}

function makeValidPdfBuffer() {
  const header = '%PDF-1.4\n';
  const obj = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const xref = 'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n';
  const trailer = 'trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n' + header.length + '\n%%EOF\n';
  return Buffer.from(header + obj + xref + trailer);
}

beforeAll(() => {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, 'valid.pdf'), makeValidPdfBuffer());
  fs.writeFileSync(path.join(FIXTURES, 'fake.pdf'), Buffer.from('this is not a pdf'));
  fs.writeFileSync(path.join(FIXTURES, 'script.exe'), Buffer.from([0x4d, 0x5a]));
});

afterAll(() => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  fs.rmSync(FIXTURES, { recursive: true, force: true });
});

describe('POST /upload — functional', () => {
  it('rejects request with no files', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no files/i);
  });

  it('rejects disallowed extension', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'script.exe'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  it('rejects MIME mismatch (fake PDF)', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'fake.pdf'), { contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid content type/i);
  });

  it('accepts a valid PDF, returns jobId and pending files', async () => {
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

  it('rejects request without auth token', async () => {
    const res = await request(app).post('/upload');
    // Token is set → 401 (not 503)
    expect(res.status).toBe(401);
  });

  it('rejects request with wrong token', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });
});

describe('GET /job/:id/status — functional', () => {
  it('returns 404 for unknown jobId with valid token', async () => {
    const res = await request(app)
      .get('/job/nonexistent-id/status')
      .set('Authorization', auth());
    expect(res.status).toBe(404);
  });

  it('returns job status for a real job', async () => {
    // Create a job first
    const uploadRes = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', path.join(FIXTURES, 'valid.pdf'), { contentType: 'application/pdf' });
    expect(uploadRes.status).toBe(201);
    const { jobId } = uploadRes.body;

    const statusRes = await request(app)
      .get(`/job/${jobId}/status`)
      .set('Authorization', auth());
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.jobId).toBe(jobId);
    expect(['pending', 'processing', 'done']).toContain(statusRes.body.status);
  });
});
