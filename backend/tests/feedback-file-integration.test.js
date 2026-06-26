import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Интеграция #332: upload исходного файла в processJob (ядро фичи) — мокаем spawn агента, чтобы
// эмитить нужный результат, и инжектим feedbackFiles.upload как шпион. Проверяем, что обработка файла
// дёргает (или НЕ дёргает) загрузку в нужных случаях и НИКОГДА не валится из-за её сбоя.
const { createApp } = await import('../index.js');

vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const TOKEN = 'fb-file-int-token';
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'procure-fbfile-'));

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

// Прогнать один файл через processJob; вернуть { jobId, status-body }. spawn агента замокан через
// agentConfig.spawnFn (см. makeApp), поэтому реальный child_process не нужен.
async function run(app) {
  const up = await request(app).post('/upload').set('Authorization', `Bearer ${TOKEN}`)
    .attach('files[]', validPdf(), { filename: 'invoice.pdf' });
  expect(up.status).toBe(201);
  const jobId = up.body.jobId;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = await request(app).get(`/job/${jobId}/status`).set('Authorization', `Bearer ${TOKEN}`);
    if (r.body.status === 'done' || r.body.status === 'error') return { jobId, body: r.body };
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error('job did not finish');
}

function makeApp({ upload, getRepoPrivate = () => true, extra = {} } = {}) {
  return createApp({
    token: TOKEN, uploadDir: UPLOAD_DIR, rateLimitMax: 0,
    agentConfig: { spawnFn: spawnEmitting(extra.result ?? { supplier: {}, items: [] }), extractFn: async () => null },
    feedbackFiles: { enabled: true, repo: 'acme/fb', token: 'tk', getRepoPrivate, maxUploadMb: 15, upload },
  });
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

describe('#332 интеграция — upload исходного файла в processJob', () => {
  it('#7 НЕТ сделки → upload вызван с repo/token/jobId/fileName/content, job завершается done', async () => {
    const upload = vi.fn(async () => ({ url: 'https://github.com/acme/fb/blob/main/x' }));
    const app = makeApp({ upload }); // дефолтный result: без deal → !hasDeal
    const { jobId, body } = await run(app);
    expect(body.status).toBe('done');
    expect(upload).toHaveBeenCalledTimes(1);
    const arg = upload.mock.calls[0][0];
    expect(arg).toMatchObject({ repo: 'acme/fb', token: 'tk', jobId, fileName: 'invoice.pdf', repoPrivate: true });
    expect(Buffer.isBuffer(arg.content)).toBe(true);
  });

  it('#7 ЕСТЬ сделка → upload НЕ вызывается (файл уже в Б24)', async () => {
    const upload = vi.fn(async () => ({ url: 'x' }));
    const app = makeApp({ upload, extra: { result: { deal: { dealId: '777' } } } });
    const { body } = await run(app);
    expect(body.status).toBe('done');
    expect(upload).not.toHaveBeenCalled();
  });

  it('#7 upload БРОСАЕТ → job всё равно done (best-effort, не валит файл)', async () => {
    const upload = vi.fn(async () => { const e = new Error('boom'); e.code = 'UPSTREAM'; throw e; });
    const app = makeApp({ upload });
    const { body } = await run(app);
    expect(body.status).toBe('done');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('#8 гонка приватности: флаг ещё не подтверждён (null) → upload получает repoPrivate=null', async () => {
    const upload = vi.fn(async () => ({ url: 'x' }));
    const app = makeApp({ upload, getRepoPrivate: () => null }); // setFeedbackRepoPrivate ещё не звали
    await run(app);
    expect(upload.mock.calls[0][0].repoPrivate).toBe(null);
  });

  it('feature OFF (enabled:false) → upload не вызывается', async () => {
    const upload = vi.fn(async () => ({ url: 'x' }));
    const app = createApp({
      token: TOKEN, uploadDir: UPLOAD_DIR, rateLimitMax: 0,
      agentConfig: { spawnFn: spawnEmitting({ supplier: {}, items: [] }), extractFn: async () => null },
      feedbackFiles: { enabled: false, repo: 'acme/fb', token: 'tk', getRepoPrivate: () => true, upload },
    });
    const { body } = await run(app);
    expect(body.status).toBe('done');
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('#332 интеграция — /feedback подкладывает sourceFileUrl из журнала (#9)', () => {
  function fakeIssueFetch() {
    const calls = [];
    const fn = vi.fn(async (url, init) => { calls.push({ url, init }); return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/owner/repo/issues/7', number: 7 }) }; });
    fn.calls = calls; return fn;
  }

  it('после no-deal job (url сохранён) /feedback кладёт «Исходный файл»; клиентский sourceFileUrl игнорируется', async () => {
    const FILE_URL = 'https://github.com/acme/fb/blob/main/feedback-files/j/ab12cd34-invoice.pdf';
    const upload = vi.fn(async () => ({ url: FILE_URL }));
    const app = createApp({
      token: TOKEN, uploadDir: UPLOAD_DIR, rateLimitMax: 0, feedbackRateLimitMax: 100,
      githubFeedbackToken: 'gh', githubFeedbackRepo: 'owner/repo',
      agentConfig: { spawnFn: spawnEmitting({ supplier: {}, items: [] }), extractFn: async () => null },
      feedbackFiles: { enabled: true, repo: 'acme/fb', token: 'tk', getRepoPrivate: () => true, maxUploadMb: 15, upload },
    });
    const { jobId } = await run(app);
    expect(upload).toHaveBeenCalledTimes(1);

    const issueFetch = fakeIssueFetch();
    vi.stubGlobal('fetch', issueFetch);
    const res = await request(app).post('/feedback').set('Authorization', `Bearer ${TOKEN}`).send({
      kind: 'problem', comment: 'нет сделки',
      context: { jobId, fileName: 'invoice.pdf', sourceFileUrl: 'https://evil.example/spoof' },
    });
    expect(res.status).toBe(201);
    const bodyText = JSON.parse(issueFetch.calls[0].init.body).body;
    expect(bodyText).toContain(`**Исходный файл:** ${FILE_URL}`); // из журнала
    expect(bodyText).not.toContain('evil.example');                // клиентский spoof не используется
  });
});
