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
    proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
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
    proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
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
    proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
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
  agentConfig: { spawnFn: makeMockAgentSpawn(), extractFn: async () => null },
  rateLimitMax: 0, // disable rate limiting for the shared app — exercised separately below
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

// Minimal OLE2 / Compound File Binary header — file-type detects this as
// application/x-cfb, the signature used for legacy .xls.
function makeMinimalCfbBuffer() {
  const b = Buffer.alloc(512, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b, 0);
  return b;
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

// ── App session (login → cookie) auth ─────────────────────────────────────────
// HTTP Basic was REMOVED (incompatible with the cross-site Bitrix24 iframe). The API now accepts
// either the Bearer token (unchanged, programmatic/MCP) or an app session: a signed pai_sess
// cookie (from /login or /session/b24) PLUS the X-PAI-Auth CSRF header. The served UI is now open.

describe('App session (login → cookie) auth', () => {
  const PAGE_USER = 'procure';
  const PAGE_PASS = 'super-secret-page-pass';

  // App with BOTH a Bearer token and standalone login credentials configured.
  const dualAuthApp = createApp({
    token: TOKEN,
    uploadDir: UPLOAD_DIR,
    basicAuthUser: PAGE_USER,
    basicAuthPass: PAGE_PASS,
    rateLimitMax: 0,
  });

  // Log in and return the raw Set-Cookie header value (pai_sess=…) for reuse on later requests.
  async function login(appInstance, user = PAGE_USER, pass = PAGE_PASS) {
    const res = await request(appInstance)
      .post('/login')
      .set('X-PAI-Auth', '1')
      .send({ username: user, password: pass });
    return res;
  }

  it('POST /login with valid credentials sets the pai_sess cookie and returns 200', async () => {
    const res = await login(dualAuthApp);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/pai_sess=/);
    expect(cookie).toMatch(/HttpOnly/i);
    // Dev/test over HTTP → SameSite=Lax, no Secure (NODE_ENV !== production here).
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('POST /login with a wrong password returns 401 and sets no cookie', async () => {
    const res = await login(dualAuthApp, PAGE_USER, 'wrong');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('the login cookie + X-PAI-Auth header authorizes /upload', async () => {
    const cookie = (await login(dualAuthApp)).headers['set-cookie'];
    const res = await request(dualAuthApp)
      .post('/upload')
      .set('Cookie', cookie)
      .set('X-PAI-Auth', '1')
      .attach('files[]', makeValidPdfBuffer(), { filename: 'invoice.pdf' });
    expect(res.status).toBe(201); // auth passed → upload accepted
  });

  it('the login cookie WITHOUT the X-PAI-Auth CSRF header → 401', async () => {
    const cookie = (await login(dualAuthApp)).headers['set-cookie'];
    const res = await request(dualAuthApp)
      .get('/job/nope/status')
      .set('Cookie', cookie); // cookie present, CSRF header missing
    expect(res.status).toBe(401);
  });

  it('still accepts the Bearer token (programmatic path unchanged)', async () => {
    const res = await request(dualAuthApp)
      .get('/job/nope/status')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(404); // auth passed → job simply not found
  });

  it('GET /session reports authenticated state from the cookie', async () => {
    const before = await request(dualAuthApp).get('/session');
    expect(before.body).toEqual({ authenticated: false });

    const cookie = (await login(dualAuthApp)).headers['set-cookie'];
    const after = await request(dualAuthApp).get('/session').set('Cookie', cookie);
    expect(after.body).toEqual({ authenticated: true });
  });

  it('POST /logout clears the cookie (Max-Age=0) and returns 204', async () => {
    const res = await request(dualAuthApp).post('/logout');
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie']?.[0]).toMatch(/pai_sess=;.*Max-Age=0/i);
  });

  it('POST /login returns 503 when no page password is configured', async () => {
    const noPassApp = createApp({ token: TOKEN, uploadDir: UPLOAD_DIR, basicAuthPass: '' });
    const res = await request(noPassApp)
      .post('/login')
      .set('X-PAI-Auth', '1')
      .send({ username: 'x', password: 'y' });
    expect(res.status).toBe(503);
  });

  it('serves the built UI OPENLY (no auth) so the Bitrix24 iframe can load it', async () => {
    const uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-public-'));
    fs.writeFileSync(path.join(uiDir, 'index.html'), '<html>ok</html>');
    try {
      const pageApp = createApp({
        token: TOKEN, uploadDir: UPLOAD_DIR, basicAuthPass: PAGE_PASS, uiPublicDir: uiDir,
      });
      const res = await request(pageApp).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('ok');
      expect(res.headers['www-authenticate']).toBeUndefined();
    } finally {
      fs.rmSync(uiDir, { recursive: true, force: true });
    }
  });
});

// ── Concurrency cap & store errors ───────────────────────────────────────────

describe('Concurrency cap & store errors', () => {
  it('returns 429 when the concurrency cap is reached', async () => {
    const busy = createApp({ token: TOKEN, uploadDir: UPLOAD_DIR, maxConcurrentJobs: 0 });
    const res = await request(busy).post('/upload').set('Authorization', auth());
    expect(res.status).toBe(429);
  });

  it('returns 503 on /job/:id/status when the store throws', async () => {
    const brokenJobs = {
      get: async () => { throw new Error('ECONNREFUSED'); },
      set: async () => {},
      ping: async () => 'PONG',
    };
    const a = createApp({ token: TOKEN, uploadDir: UPLOAD_DIR, jobs: brokenJobs });
    const res = await request(a).get('/job/x/status').set('Authorization', auth());
    expect(res.status).toBe(503);
  });

  it('returns 503 on /upload when persisting the job fails', async () => {
    const brokenJobs = {
      get: async () => null,
      set: async () => { throw new Error('ECONNREFUSED'); },
      ping: async () => 'PONG',
    };
    const a = createApp({
      token: TOKEN, uploadDir: UPLOAD_DIR, jobs: brokenJobs,
      agentConfig: { spawnFn: makeMockAgentSpawn() },
    });
    const res = await request(a)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', makeValidPdfBuffer(), { filename: 'invoice.pdf' });
    expect(res.status).toBe(503);
  });

  it('stores files under a generated name, exposing only the basename to the UI', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', makeValidPdfBuffer(), { filename: '../../evil name.pdf' });
    expect(res.status).toBe(201);
    expect(res.body.files[0].name).toBe('evil name.pdf'); // basename only, no traversal
  });
});

// ── File type validation (regression) ────────────────────────────────────────

describe('File type validation (regression)', () => {
  it('accepts a real legacy .xls (OLE2/CFB) — now a supported format', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', makeMinimalCfbBuffer(), { filename: 'prices.xls' });
    expect(res.status).toBe(201);
  });

  it('rejects a non-OLE2 file disguised as .xls (content ≠ extension)', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', Buffer.from('not really excel'), { filename: 'fake.xls' });
    expect(res.status).toBe(400);
  });

  it('accepts a JPEG image (OCR path)', async () => {
    // Minimal JPEG: SOI + APP0/JFIF header → file-type detects image/jpeg.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]);
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', jpeg, { filename: 'scan.jpg' });
    expect(res.status).toBe(201);
  });

  it('decodes Cyrillic filenames (no mojibake in status) — issue #54', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', makeValidPdfBuffer(), { filename: 'Счёт-тест.pdf' });
    expect(res.status).toBe(201);
    expect(res.body.files[0].name).toBe('Счёт-тест.pdf');
  });

  it('rejects an OLE2/CFB file with a non-.xls extension (content ≠ extension)', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', makeMinimalCfbBuffer(), { filename: 'evil.pdf' });
    expect(res.status).toBe(400);
  });

  it('accepts a PNG image (OCR path)', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    ]);
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', png, { filename: 'scan.png' });
    expect(res.status).toBe(201);
  });

  it('rejects a ZIP payload disguised as .pdf (MIME ≠ extension)', async () => {
    const res = await request(app)
      .post('/upload')
      .set('Authorization', auth())
      .attach('files[]', makeMinimalZipBuffer(), { filename: 'evil.pdf' });
    expect(res.status).toBe(400);
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

  it('returns 400 when file exceeds maxFileSizeMb limit', async () => {
    // supertest buffers the full request before sending, so busboy's streaming
    // fileSize limit never fires. Use a real http.Server + node:http client to
    // stream the multipart body and actually trigger the limit event.
    const { createServer } = await import('node:http');
    const { request: httpReq } = await import('node:http');
    const { once } = await import('node:events');

    const smallApp = createApp({ token: TOKEN, uploadDir: UPLOAD_DIR, maxFileSizeMb: 1 / 1024 }); // 1 KB
    const server = createServer(smallApp);
    server.listen(0);
    await once(server, 'listening');
    const { port } = server.address();

    const boundary = '----TestBoundary999';
    // Minimal valid-looking PDF so MIME sniff passes, padded past the 1 KB limit.
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files[]"; filename="oversized.pdf"\r\nContent-Type: application/pdf\r\n\r\n`
    );
    const fileBody = Buffer.from('%PDF-1.4\n' + 'x'.repeat(2048)); // ~2 KB > 1 KB cap
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);

    const { status, body } = await new Promise((resolve, reject) => {
      const chunks = [];
      const r = httpReq(
        { hostname: '127.0.0.1', port, method: 'POST', path: '/upload',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': preamble.length + fileBody.length + epilogue.length,
          } },
        (res) => {
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
            catch (e) { reject(e); }
          });
        }
      );
      r.on('error', reject);
      r.write(preamble); r.write(fileBody); r.write(epilogue); r.end();
    });

    server.close();
    expect(status).toBe(400);
    expect(body.error).toMatch(/too large/i);
  });
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
    // X-Frame-Options намеренно НЕ ставится: фрейм Bitrix24 (кросс-домен) разрешаем через CSP
    // frame-ancestors, а X-Frame-Options умеет только SAMEORIGIN/DENY и заблокировал бы его.
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets CSP always; HSTS only in production (#105)', async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");      // anti-exfil lever
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");  // clickjacking: same-origin…
    expect(csp).toContain('https://*.bitrix24.ru');   // …+ порталы Bitrix24 (работа во фрейме)
    expect(csp).toContain("base-uri 'self'");         // base-tag injection
    // HSTS gated to NODE_ENV=production so a dev/staging HTTP host isn't pinned for 2y.
    expect(res.headers['strict-transport-security']).toBeUndefined();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const prod = await request(app).get('/health');
      expect(prod.headers['strict-transport-security']).toContain('max-age=63072000');
    } finally {
      process.env.NODE_ENV = prev;
    }
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

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe('rate limiting on /upload', () => {
  const pdf = () => path.join(FIXTURES, 'valid.pdf');

  // Each app below sets a high maxConcurrentJobs on purpose: these tests assert the RATE
  // LIMITER's 429, but /upload also 429s on the concurrency cap (default 2). The mock agent
  // closes on setImmediate, so a prior upload's job can still be in flight (activeJobs not yet
  // decremented) when the next request's `activeJobs >= max` check runs → a flaky "Server busy"
  // 429. Raising the cap removes that confound; the concurrency cap has its own test above.

  it('returns 429 once the per-window limit is exceeded', async () => {
    const limitedApp = createApp({
      token: TOKEN,
      uploadDir: UPLOAD_DIR,
      agentConfig: { spawnFn: makeMockAgentSpawn() },
      rateLimitMax: 2,
      rateLimitWindowMs: 60_000,
      maxConcurrentJobs: 50,
    });
    const r1 = await request(limitedApp).post('/upload').set('Authorization', auth())
      .attach('files[]', pdf(), { contentType: 'application/pdf' });
    const r2 = await request(limitedApp).post('/upload').set('Authorization', auth())
      .attach('files[]', pdf(), { contentType: 'application/pdf' });
    const r3 = await request(limitedApp).post('/upload').set('Authorization', auth())
      .attach('files[]', pdf(), { contentType: 'application/pdf' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r3.status).toBe(429);
    expect(r3.body.error).toMatch(/too many/i);
    expect(r3.headers['retry-after']).toBeDefined();
  });

  it('does not limit requests when rateLimitMax is 0 (disabled)', async () => {
    const openApp = createApp({
      token: TOKEN,
      uploadDir: UPLOAD_DIR,
      agentConfig: { spawnFn: makeMockAgentSpawn() },
      rateLimitMax: 0,
      maxConcurrentJobs: 50,
    });
    for (let i = 0; i < 5; i++) {
      const r = await request(openApp).post('/upload').set('Authorization', auth())
        .attach('files[]', pdf(), { contentType: 'application/pdf' });
      expect(r.status).toBe(201);
    }
  });

  // #105: when a Redis client is present the limiter uses it (multi-instance-safe).
  it('uses per-key Redis INCR/pexpire, arms the correct TTL, and 429s over the limit', async () => {
    const counters = new Map(); // per-key — proves keyFor isolates clients, not a global counter
    const ttls = [];
    const fakeRedis = {
      incr: async (key) => { const n = (counters.get(key) ?? 0) + 1; counters.set(key, n); return n; },
      pexpire: async (_key, ms) => { ttls.push(ms); },
      on: () => {},
    };
    const redisApp = createApp({
      token: TOKEN,
      uploadDir: UPLOAD_DIR,
      agentConfig: { spawnFn: makeMockAgentSpawn() },
      rateLimitMax: 2,
      rateLimitWindowMs: 60_000,
      rateLimitRedis: fakeRedis,
      // A second valid identity (app session) so we can prove keyFor isolates clients: only one
      // bearer token is valid, so a distinct client must authenticate a different way. The
      // session-cookie client sends NO Authorization header → the limiter keys it by req.ip,
      // which is a distinct key from the Bearer client's hashed-token key.
      basicAuthUser: 'u',
      basicAuthPass: 'p',
      maxConcurrentJobs: 50,
    });
    const uploadWithBearer = () => request(redisApp).post('/upload').set('Authorization', auth())
      .attach('files[]', pdf(), { contentType: 'application/pdf' });
    // Client A (Bearer): 3 hits, limit 2 → 3rd is 429. (keyed by hashed Authorization header)
    const [a1, a2, a3] = [await uploadWithBearer(), await uploadWithBearer(), await uploadWithBearer()];
    expect([a1.status, a2.status, a3.status]).toEqual([201, 201, 429]);
    // Client B (app session): establish a cookie, then upload with cookie + CSRF header but NO
    // Authorization → keyed by req.ip, an INDEPENDENT counter, so its first upload still passes.
    const cookie = (await request(redisApp).post('/login').set('X-PAI-Auth', '1')
      .send({ username: 'u', password: 'p' })).headers['set-cookie'];
    const b1 = await request(redisApp).post('/upload').set('Cookie', cookie).set('X-PAI-Auth', '1')
      .attach('files[]', pdf(), { contentType: 'application/pdf' });
    expect(b1.status).toBe(201);
    expect(counters.size).toBe(2);            // two distinct keys (Bearer token ≠ req.ip)
    expect(ttls.every((ms) => ms === 60_000)).toBe(true); // pexpire armed with windowMs (ms, not s)
  });

  it('fails OPEN when Redis errors — a blip must not block uploads (#105)', async () => {
    const fakeRedis = {
      incr: async () => { throw new Error('redis down'); },
      pexpire: async () => {},
      on: () => {},
    };
    const redisApp = createApp({
      token: TOKEN,
      uploadDir: UPLOAD_DIR,
      agentConfig: { spawnFn: makeMockAgentSpawn() },
      rateLimitMax: 1, // would 429 after the 1st request if Redis worked
      rateLimitRedis: fakeRedis,
      maxConcurrentJobs: 50,
    });
    for (let i = 0; i < 3; i++) {
      const r = await request(redisApp).post('/upload').set('Authorization', auth())
        .attach('files[]', pdf(), { contentType: 'application/pdf' });
      expect(r.status).toBe(201); // all allowed — failed open
    }
  });
});
