/**
 * Verifies the placeholder-token branch of requireAuth returns 503.
 *
 * BACKEND_API_TOKEN is read into a module-scope constant when index.js is first
 * imported, so the env var MUST be set before the (dynamic) import — mutating
 * process.env afterwards would have no effect and produce a false-green test.
 * This file runs in its own Vitest worker, so its module cache is fresh and the
 * cache-busting query string guarantees a distinct module instance.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Must be set BEFORE importing the app so the placeholder value is captured.
process.env.REDIS_URL = '';
process.env.BACKEND_API_TOKEN = 'replace-with-secure-token';
process.env.UPLOAD_DIR = path.join(__dirname, '../uploads-test-placeholder');

const { app } = await import('../index.js?placeholder=1');

describe('Auth middleware — placeholder token', () => {
  it('returns 503 on /upload when BACKEND_API_TOKEN is the placeholder', async () => {
    const res = await request(app).post('/upload');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('returns 503 even when the placeholder token is supplied as Bearer', async () => {
    // Proves the 503 comes from the placeholder check, not from a missing header.
    const res = await request(app)
      .post('/upload')
      .set('Authorization', 'Bearer replace-with-secure-token');
    expect(res.status).toBe(503);
  });

  it('returns 503 on /job/:id/status with the placeholder token', async () => {
    const res = await request(app).get('/job/some-id/status');
    expect(res.status).toBe(503);
  });
});
