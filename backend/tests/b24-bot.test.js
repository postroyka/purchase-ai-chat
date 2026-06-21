import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import { parseBotEvent, parseFeedbackParams, feedbackKeyboard, botResultText, handleBotEvent } from '../b24-bot.js';
import { makeBotApi } from '../b24-bot-api.js';
import { createApp } from '../index.js';
import { createAppStore } from '../app-store.js';

// Мок агент-спавна (как в metrics-routes.test): успешный прогон с заданным result.
function makeAgentSpawn({ result = { status: 'stub' } } = {}) {
  return vi.fn(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
    proc.kill = vi.fn();
    setImmediate(() => {
      proc.stdout.emit('data', JSON.stringify({ is_error: false, result: JSON.stringify(result), total_cost_usd: 0.05, duration_ms: 1234, num_turns: 3 }));
      proc.emit('close', 0);
    });
    return proc;
  });
}

// ── Чистые функции ────────────────────────────────────────────────────────────
describe('parseBotEvent', () => {
  it('нормализует PHP-ключи/строки события в объект', () => {
    const e = parseBotEvent({
      event: 'ONIMBOTV2MESSAGEADD',
      auth: { application_token: 'apptok', client_endpoint: 'https://p.bitrix24.ru/rest/' },
      data: {
        bot: { id: '456', code: 'procure_ai_invoice', auth: { access_token: 'botok', client_endpoint: 'https://p.bitrix24.ru/rest/' } },
        message: { id: '789', dialogId: 'chat5', text: 'привет', files: [{ id: '12', name: 'schet.pdf' }] },
        user: { id: '27', bot: '0' },
      },
    });
    expect(e.event).toBe('ONIMBOTV2MESSAGEADD');
    expect(e.applicationToken).toBe('apptok');
    expect(e.bot).toMatchObject({ id: '456', token: 'botok', restEndpoint: 'https://p.bitrix24.ru/rest/' });
    expect(e.dialogId).toBe('chat5');
    expect(e.message.files).toEqual([{ id: '12', name: 'schet.pdf' }]);
    expect(e.user).toEqual({ id: '27', isBot: false });
  });

  it('files как объект (qs-массив) — пустые id отфильтрованы', () => {
    const e = parseBotEvent({ event: 'x', data: { message: { files: { 0: { id: '1', name: 'a.pdf' }, 1: { id: '', name: 'b' } } } } });
    expect(e.message.files).toEqual([{ id: '1', name: 'a.pdf' }]);
  });

  it('пустое тело → безопасные дефолты', () => {
    const e = parseBotEvent({});
    expect(e.event).toBe('');
    expect(e.message.files).toEqual([]);
    expect(e.applicationToken).toBe('');
  });
});

describe('parseFeedbackParams', () => {
  it('like/dislike <jobId> → kind+jobId', () => {
    expect(parseFeedbackParams('like abc-123')).toEqual({ kind: 'positive', jobId: 'abc-123' });
    expect(parseFeedbackParams('dislike JOB1')).toEqual({ kind: 'problem', jobId: 'JOB1' });
  });
  it('мусор → null', () => {
    expect(parseFeedbackParams('like')).toBeNull();
    expect(parseFeedbackParams('foo bar')).toBeNull();
    expect(parseFeedbackParams('')).toBeNull();
  });
});

describe('feedbackKeyboard / botResultText', () => {
  it('клавиатура — { BUTTONS:[👍,👎] } с командой feedback и jobId', () => {
    const kb = feedbackKeyboard('job1');
    expect(kb.BUTTONS).toHaveLength(2);
    expect(kb.BUTTONS[0]).toMatchObject({ COMMAND: 'feedback', COMMAND_PARAMS: 'like job1' });
    expect(kb.BUTTONS[1]).toMatchObject({ COMMAND: 'feedback', COMMAND_PARAMS: 'dislike job1' });
  });
  it('текст результата: сделка / без сделки+причина / ошибка; заголовок по числу файлов', () => {
    const txt = botResultText({ files: [
      { name: 'a.pdf', status: 'done', result: { deal: { dealId: '1609008' } } },
      { name: 'b.pdf', status: 'done', result: {}, problem: 'не распознан документ' },
      { name: 'c.pdf', status: 'error', error: 'agent error' },
    ] });
    expect(txt).toContain('Готово (3 файлов):');
    expect(txt).toContain('a.pdf: ✅ Сделка #1609008');
    expect(txt).toContain('b.pdf: ⚠️ Без сделки — не распознан документ');
    expect(txt).toContain('c.pdf: ошибка');
  });
});

// ── handleBotEvent (I/O инъектируется → без портала) ───────────────────────────
function makeDeps(over = {}) {
  return {
    createAndStartJob: vi.fn(async () => {}),
    submitFeedback: vi.fn(async () => {}),
    downloadAndSaveFiles: vi.fn(async () => ({ jobId: 'job1', jobDir: '/u/job1', fileEntries: [{ name: 'a.pdf' }] })),
    sendMessage: vi.fn(async () => {}),
    hasCapacity: () => true,
    responsibleUserIdFor: (uid) => String(uid || '20'),
    log: vi.fn(),
    ...over,
  };
}
const msgEvt = (files, over = {}) => ({
  event: 'ONIMBOTV2MESSAGEADD', dialogId: 'chat5', bot: { id: '456', token: 't' },
  message: { id: '1', text: '', files }, command: {}, user: { id: '27', isBot: false }, ...over,
});

describe('handleBotEvent', () => {
  it('сообщение с файлом → скачивание + старт задания + «обрабатываю» + результат по onDone', async () => {
    const deps = makeDeps();
    const r = await handleBotEvent(msgEvt([{ id: '12', name: 'a.pdf' }]), deps);
    expect(r).toBe('started');
    expect(deps.downloadAndSaveFiles).toHaveBeenCalledOnce();
    expect(deps.createAndStartJob).toHaveBeenCalledOnce();
    expect(deps.sendMessage).toHaveBeenCalled();
    const onDone = deps.createAndStartJob.mock.calls[0][0].onDone;
    await onDone({ files: [{ name: 'a.pdf', status: 'done', result: { deal: { dealId: '7' } } }] });
    const lastSend = deps.sendMessage.mock.calls.at(-1)[0];
    expect(lastSend.text).toContain('Сделка #7');
    expect(lastSend.keyboard).toMatchObject({ BUTTONS: expect.any(Array) });
  });

  it('НЕСКОЛЬКО файлов в одном сообщении → одно задание, «Принял N файлов»', async () => {
    const deps = makeDeps({ downloadAndSaveFiles: vi.fn(async () => ({ jobId: 'j', jobDir: '/u/j', fileEntries: [{ name: 'a' }, { name: 'b' }] })) });
    await handleBotEvent(msgEvt([{ id: '1', name: 'a.pdf' }, { id: '2', name: 'b.pdf' }]), deps);
    expect(deps.createAndStartJob).toHaveBeenCalledOnce();
    expect(deps.sendMessage.mock.calls[0][0].text).toContain('2 файлов');
  });

  it('сообщение БЕЗ файла → подсказка, задание не создаётся', async () => {
    const deps = makeDeps();
    const r = await handleBotEvent(msgEvt([]), deps);
    expect(r).toBe('hint');
    expect(deps.createAndStartJob).not.toHaveBeenCalled();
    expect(deps.sendMessage.mock.calls[0][0].text).toMatch(/файл счёта/i);
  });

  it('нет ёмкости (лимит заданий) → «занято», ни скачивания, ни задания', async () => {
    const deps = makeDeps({ hasCapacity: () => false });
    const r = await handleBotEvent(msgEvt([{ id: '1', name: 'a.pdf' }]), deps);
    expect(r).toBe('ignored:busy');
    expect(deps.downloadAndSaveFiles).not.toHaveBeenCalled();
    expect(deps.createAndStartJob).not.toHaveBeenCalled();
  });

  it('сообщение от бота игнорируется (без эха/циклов)', async () => {
    const deps = makeDeps();
    const r = await handleBotEvent(msgEvt([{ id: '1', name: 'a.pdf' }], { user: { id: '456', isBot: true } }), deps);
    expect(r).toBe('ignored:from_bot');
    expect(deps.createAndStartJob).not.toHaveBeenCalled();
  });

  it('ошибка скачивания → сообщение об ошибке, задание не создаётся', async () => {
    const deps = makeDeps({ downloadAndSaveFiles: vi.fn(async () => { throw new Error('boom'); }) });
    const r = await handleBotEvent(msgEvt([{ id: '1', name: 'a.pdf' }]), deps);
    expect(r).toBe('ignored:download_failed');
    expect(deps.createAndStartJob).not.toHaveBeenCalled();
  });

  it('команда feedback like → submitFeedback(positive, jobId, reporter)', async () => {
    const deps = makeDeps();
    const r = await handleBotEvent({
      event: 'ONIMBOTV2COMMANDADD', dialogId: 'chat5', bot: { id: '456', token: 't' }, message: {},
      command: { name: 'feedback', params: 'like job1', context: 'keyboard' }, user: { id: '27', isBot: false },
    }, deps);
    expect(r).toBe('feedback');
    expect(deps.submitFeedback).toHaveBeenCalledWith({ kind: 'positive', jobId: 'job1', reporter: 'b24/user:27' });
  });

  it('команда /feedback dislike → problem', async () => {
    const deps = makeDeps();
    await handleBotEvent({
      event: 'ONIMBOTV2COMMANDADD', dialogId: 'c', bot: { id: '1', token: 't' }, message: {},
      command: { name: '/feedback', params: 'dislike j2', context: 'keyboard' }, user: { id: '5', isBot: false },
    }, deps);
    expect(deps.submitFeedback).toHaveBeenCalledWith({ kind: 'problem', jobId: 'j2', reporter: 'b24/user:5' });
  });

  it('join → приветствие', async () => {
    const deps = makeDeps();
    const r = await handleBotEvent({ event: 'ONIMBOTV2JOINCHAT', dialogId: 'c', bot: { id: '1', token: 't' }, message: {}, command: {}, user: {} }, deps);
    expect(r).toBe('welcome');
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  it('скачивание отфильтровало все файлы → «не нашёл», задание не создаётся', async () => {
    const deps = makeDeps({ downloadAndSaveFiles: vi.fn(async () => ({ jobId: 'j', jobDir: '/u/j', fileEntries: [] })) });
    const r = await handleBotEvent(msgEvt([{ id: '1', name: 'a.exe' }]), deps);
    expect(r).toBe('ignored:no_valid_files');
    expect(deps.createAndStartJob).not.toHaveBeenCalled();
  });

  it('команда feedback с мусорными params → submitFeedback НЕ вызывается', async () => {
    const deps = makeDeps();
    const r = await handleBotEvent({
      event: 'ONIMBOTV2COMMANDADD', dialogId: 'c', bot: { id: '1', token: 't' }, message: {},
      command: { name: 'feedback', params: 'garbage', context: 'keyboard' }, user: { id: '5', isBot: false },
    }, deps);
    expect(r).toBe('ignored:bad_feedback_params');
    expect(deps.submitFeedback).not.toHaveBeenCalled();
  });
});

// ── Роут POST /b24/bot/event (валидация токена + проводка) ──────────────────────
describe('POST /b24/bot/event', () => {
  const fakeMetrics = () => ({
    recordUpload: vi.fn(async () => {}), recordFeedback: vi.fn(async () => {}),
    recordFile: vi.fn(() => {}), recordMatching: vi.fn(() => {}), recordWarnings: vi.fn(() => {}),
  });
  function appWith() {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-route-'));
    const metrics = fakeMetrics();
    const botApi = { sendMessage: vi.fn(async () => {}), downloadAndSaveFiles: vi.fn(async () => ({ jobId: 'j', jobDir: path.join(uploadDir, 'j'), fileEntries: [] })) };
    const app = createApp({ token: 'T', uploadDir, rateLimitMax: 0, metrics, b24BotApplicationToken: 'secret', botApi });
    return { app, botApi, metrics, uploadDir };
  }

  it('неверный application_token → 403, обработчик не запускается', async () => {
    const { app, botApi } = appWith();
    const res = await request(app).post('/b24/bot/event').type('form')
      .send({ event: 'ONIMBOTV2JOINCHAT', 'auth[application_token]': 'WRONG', 'data[dialogId]': 'chat5', 'data[bot][id]': '1' });
    expect(res.status).toBe(403);
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('верный токен → 200 быстро + обработчик вызван (join → приветствие)', async () => {
    const { app, botApi } = appWith();
    const res = await request(app).post('/b24/bot/event').type('form')
      .send({ event: 'ONIMBOTV2JOINCHAT', 'auth[application_token]': 'secret', 'data[dialogId]': 'chat5', 'data[bot][id]': '1', 'data[bot][auth][access_token]': 'botok' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(botApi.sendMessage).toHaveBeenCalled());
  });

  it('бот выключен (нет B24_BOT_APPLICATION_TOKEN) → 403 на любой запрос', async () => {
    const prev = process.env.B24_BOT_APPLICATION_TOKEN;
    delete process.env.B24_BOT_APPLICATION_TOKEN;
    try {
      const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-off-'));
      const app = createApp({ token: 'T', uploadDir, rateLimitMax: 0, metrics: fakeMetrics() }); // без b24BotApplicationToken
      const res = await request(app).post('/b24/bot/event').type('form').send({ event: 'ONIMBOTV2JOINCHAT', 'auth[application_token]': '' });
      expect(res.status).toBe(403);
    } finally {
      if (prev !== undefined) process.env.B24_BOT_APPLICATION_TOKEN = prev;
    }
  });

  it('команда feedback (без токена фидбэка) → recordFeedback(source:user) и без падения', async () => {
    const { app, metrics } = appWith();
    const res = await request(app).post('/b24/bot/event').type('form').send({
      event: 'ONIMBOTV2COMMANDADD', 'auth[application_token]': 'secret', 'data[dialogId]': 'chat5', 'data[bot][id]': '1',
      'data[bot][auth][access_token]': 'botok', 'data[user][id]': '27',
      'data[command][command]': 'feedback', 'data[command][params]': 'like job1', 'data[command][context]': 'keyboard',
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(metrics.recordFeedback).toHaveBeenCalledWith({ source: 'user', kind: 'positive' }));
  });

  it('сообщение с файлом → реальный createAndStartJob → результат+клавиатура в чат по готовности', async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-file-'));
    const jobDir = path.join(uploadDir, 'j1');
    fs.mkdirSync(jobDir, { recursive: true });
    const filePath = path.join(jobDir, 'f.pdf');
    fs.writeFileSync(filePath, '%PDF-1.4\n');
    const botApi = {
      sendMessage: vi.fn(async () => {}),
      downloadAndSaveFiles: vi.fn(async () => ({ jobId: 'j1', jobDir, fileEntries: [{ name: 'schet.pdf', path: filePath, status: 'pending', result: null, error: null }] })),
    };
    const app = createApp({
      token: 'T', uploadDir, rateLimitMax: 0, metrics: fakeMetrics(), b24BotApplicationToken: 'secret', botApi,
      agentConfig: { spawnFn: makeAgentSpawn({ result: { deal: { dealId: '5' } } }), extractFn: async () => ({ text: 'СЧЁТ', method: 'pdftotext' }) },
    });
    const res = await request(app).post('/b24/bot/event').type('form').send({
      event: 'ONIMBOTV2MESSAGEADD', 'auth[application_token]': 'secret', 'data[dialogId]': 'chat5',
      'data[bot][id]': '1', 'data[bot][auth][access_token]': 'botok', 'data[user][id]': '27',
      'data[message][id]': '1', 'data[message][files][0][id]': '12', 'data[message][files][0][name]': 'schet.pdf',
    });
    expect(res.status).toBe(200);
    expect(botApi.downloadAndSaveFiles).toHaveBeenCalled();
    await vi.waitFor(() => {
      const calls = botApi.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2); // «обрабатываю» + результат
      expect(calls.at(-1)[0].text).toContain('Сделка #5');
      expect(calls.at(-1)[0].keyboard).toMatchObject({ BUTTONS: expect.any(Array) });
    });
  });
});

// ── b24-bot-api: фильтрация/SSRF в downloadAndSaveFiles (детерминированно, с mock fetch) ─────────
describe('makeBotApi.downloadAndSaveFiles', () => {
  // Тело по умолчанию — валидный PDF (%PDF-1.4): после добавления magic-MIME-проверки (#216)
  // «пустые» байты больше не проходят как pdf, поэтому файл-фикстуры начинаются с PDF-заголовка.
  const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]; // %PDF-1.4\n
  const pdfBytes = (n) => {
    const out = new Uint8Array(Math.max(n, PDF_HEADER.length));
    out.set(PDF_HEADER);
    return out.buffer;
  };
  const okFetch = (downloadUrl, bytes = 16, contentLength = '16') => vi.fn(async (url) => {
    if (String(url).includes('imbot.v2.File.download')) return { ok: true, json: async () => ({ result: { downloadUrl } }) };
    return { ok: true, headers: { get: () => contentLength }, arrayBuffer: async () => pdfBytes(bytes) };
  });

  it('неразрешённый ext пропускается; all-filtered → jobDir удалён', async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-api-'));
    const api = makeBotApi({ restEndpoint: 'https://p.bitrix24.ru/rest/', fetchImpl: okFetch('https://p.bitrix24.ru/f'), uploadDir, allowedExtensions: ['pdf'], maxBytes: 1024, maxFiles: 10, isAllowedHost: () => true });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'a.exe' }], { botToken: 't', botId: '1' });
    expect(r.fileEntries).toEqual([]);
    expect(fs.existsSync(r.jobDir)).toBe(false);
  });

  it('oversize по Content-Length пропускается', async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-api-'));
    const api = makeBotApi({ restEndpoint: 'https://p.bitrix24.ru/rest/', fetchImpl: okFetch('https://p.bitrix24.ru/f', 9999, '9999'), uploadDir, allowedExtensions: ['pdf'], maxBytes: 100, maxFiles: 10, isAllowedHost: () => true });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'a.pdf' }], { botToken: 't', botId: '1' });
    expect(r.fileEntries).toEqual([]);
  });

  it('SSRF: downloadUrl на чужом домене → throw (host not allowed)', async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-api-'));
    const isAllowedHost = (h) => h.endsWith('.bitrix24.ru');
    const api = makeBotApi({ restEndpoint: 'https://p.bitrix24.ru/rest/', fetchImpl: okFetch('https://evil.example.com/f'), uploadDir, allowedExtensions: ['pdf'], maxBytes: 1024, maxFiles: 10, isAllowedHost });
    await expect(api.downloadAndSaveFiles([{ id: '1', name: 'a.pdf' }], { botToken: 't', botId: '1' })).rejects.toThrow(/not allowed/);
  });

  it('cap по числу файлов (maxFiles)', async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-api-'));
    const api = makeBotApi({ restEndpoint: 'https://p.bitrix24.ru/rest/', fetchImpl: okFetch('https://p.bitrix24.ru/f'), uploadDir, allowedExtensions: ['pdf'], maxBytes: 1024, maxFiles: 2, isAllowedHost: () => true });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'a.pdf' }, { id: '2', name: 'b.pdf' }, { id: '3', name: 'c.pdf' }], { botToken: 't', botId: '1' });
    expect(r.fileEntries).toHaveLength(2); // 3-й отброшен cap-ом
  });

  it('валидный по содержимому PDF сохраняется (#216)', async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-api-'));
    const api = makeBotApi({ restEndpoint: 'https://p.bitrix24.ru/rest/', fetchImpl: okFetch('https://p.bitrix24.ru/f'), uploadDir, allowedExtensions: ['pdf'], maxBytes: 1024, maxFiles: 10, isAllowedHost: () => true });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'a.pdf' }], { botToken: 't', botId: '1' });
    expect(r.fileEntries).toHaveLength(1);
  });

  it('смешанная партия: валидный сохраняется, невалидный пропускается, jobDir сохраняется (#216)', async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-api-'));
    // download-url зависит от fileId; тело: f/1 — валидный PDF, f/2 — нули (не распознаётся).
    const mixedFetch = vi.fn(async (url, opts) => {
      if (String(url).includes('imbot.v2.File.download')) {
        const fileId = JSON.parse(opts.body).fileId;
        return { ok: true, json: async () => ({ result: { downloadUrl: `https://p.bitrix24.ru/f/${fileId}` } }) };
      }
      const valid = String(url).endsWith('/1');
      return { ok: true, headers: { get: () => '64' }, arrayBuffer: async () => (valid ? pdfBytes(16) : new Uint8Array(64).buffer) };
    });
    const api = makeBotApi({ restEndpoint: 'https://p.bitrix24.ru/rest/', fetchImpl: mixedFetch, uploadDir, allowedExtensions: ['pdf'], maxBytes: 1024, maxFiles: 10, isAllowedHost: () => true });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'ok.pdf' }, { id: '2', name: 'bad.pdf' }], { botToken: 't', botId: '1' });
    expect(r.fileEntries).toHaveLength(1);
    expect(r.fileEntries[0].name).toBe('ok.pdf');
    expect(fs.existsSync(r.jobDir)).toBe(true); // непустая партия → каталог НЕ удаляется
  });

  it('невалидный MIME (содержимое ≠ разрешённый тип) пропускается (#216)', async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-api-'));
    // download отдаёт «.pdf», но тело — нули: file-type не распознаёт разрешённый тип → файл отброшен,
    // как и в /upload. Расширение allowed, размер в норме — отсекает именно magic-MIME-проверка.
    const badFetch = vi.fn(async (url) => {
      if (String(url).includes('imbot.v2.File.download')) return { ok: true, json: async () => ({ result: { downloadUrl: 'https://p.bitrix24.ru/f' } }) };
      return { ok: true, headers: { get: () => '64' }, arrayBuffer: async () => new Uint8Array(64).buffer };
    });
    const api = makeBotApi({ restEndpoint: 'https://p.bitrix24.ru/rest/', fetchImpl: badFetch, uploadDir, allowedExtensions: ['pdf'], maxBytes: 1024, maxFiles: 10, isAllowedHost: () => true });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'a.pdf' }], { botToken: 't', botId: '1' });
    expect(r.fileEntries).toEqual([]);
    expect(fs.existsSync(r.jobDir)).toBe(false);
  });
});

// ── POST /b24/app/event — захват application_token (#217) ───────────────────────────────────────
describe('POST /b24/app/event (захват токена + проверка через app.info)', () => {
  const fakeMetrics = () => ({
    recordUpload: vi.fn(async () => {}), recordFeedback: vi.fn(async () => {}), recordFile: vi.fn(async () => {}),
    recordMatching: vi.fn(async () => {}), recordWarnings: vi.fn(async () => {}), snapshot: vi.fn(async () => ({})), ping: vi.fn(async () => {}),
  });
  // handleAppEvent выполняется АСИНХРОННО после 200 — ждём условие с таймаутом.
  const until = async (fn, ms = 1000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 10)); }
    return false;
  };
  function appWith(appInfo) {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-evt-'));
    const appStore = createAppStore({ redisUrl: '' });
    // portalDomains задаём напрямую; appInfo инжектируем (одна проба и для /session/b24, и для захвата).
    const app = createApp({ token: 'T', uploadDir, rateLimitMax: 0, metrics: fakeMetrics(), appStore, appInfo, portalDomains: ['p.bitrix24.by'] });
    return { app, appStore };
  }
  const install = (over = {}) => ({
    event: 'ONAPPINSTALL', 'auth[application_token]': 'APPTOK', 'auth[access_token]': 'ACC',
    'auth[member_id]': 'm1', 'auth[domain]': 'p.bitrix24.by', ...over,
  });

  it('валидный install (app.info ок, домен в allowlist) → токен захвачен, событие бота с ним проходит', async () => {
    const appInfo = vi.fn(async () => true);
    const { app, appStore } = appWith(appInfo);
    const res = await request(app).post('/b24/app/event').type('form').send(install());
    expect(res.status).toBe(200);
    expect(await until(() => appStore.isKnownToken('APPTOK'))).toBe(true);
    expect(appInfo).toHaveBeenCalledWith('p.bitrix24.by', 'ACC');
    // теперь /b24/bot/event с этим токеном валиден БЕЗ env-токена (B24_BOT_APPLICATION_TOKEN не задан)
    const ev = await request(app).post('/b24/bot/event').type('form')
      .send({ event: 'ONIMBOTV2JOINCHAT', 'auth[application_token]': 'APPTOK', 'data[bot][id]': '1', 'data[bot][auth][access_token]': 'b' });
    expect(ev.status).toBe(200);
  });

  it('app.info вернул false → токен НЕ захвачен (recordInstall не вызван); событие бота с ним → 403', async () => {
    const appInfo = vi.fn(async () => false);
    const { app, appStore } = appWith(appInfo);
    const recordSpy = vi.spyOn(appStore, 'recordInstall');
    await request(app).post('/b24/app/event').type('form').send(install());
    // детерминированно: ждём вызова app.info (обработчик дошёл до проверки), затем флашим микротаски
    expect(await until(() => appInfo.mock.calls.length > 0)).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(recordSpy).not.toHaveBeenCalled();
    expect(await appStore.isKnownToken('APPTOK')).toBe(false);
    const ev = await request(app).post('/b24/bot/event').type('form').send({ event: 'ONIMBOTV2JOINCHAT', 'auth[application_token]': 'APPTOK' });
    expect(ev.status).toBe(403);
  });

  it('домен НЕ в allowlist → app.info даже не вызывается, recordInstall не вызван (SSRF-гард)', async () => {
    const appInfo = vi.fn(async () => true);
    const { app, appStore } = appWith(appInfo);
    const recordSpy = vi.spyOn(appStore, 'recordInstall');
    await request(app).post('/b24/app/event').type('form').send(install({ 'auth[domain]': 'evil.example.com' }));
    await new Promise((r) => setImmediate(r)); // отказ по allowlist синхронен — флаша достаточно
    expect(appInfo).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
    expect(await appStore.isKnownToken('APPTOK')).toBe(false);
  });

  it('слишком длинный access_token → app.info не вызывается, не захвачен', async () => {
    const appInfo = vi.fn(async () => true);
    const { app, appStore } = appWith(appInfo);
    await request(app).post('/b24/app/event').type('form').send(install({ 'auth[access_token]': 'x'.repeat(4097) }));
    await new Promise((r) => setImmediate(r));
    expect(appInfo).not.toHaveBeenCalled(); // length-guard до исходящего вызова
    expect(await appStore.isKnownToken('APPTOK')).toBe(false);
  });

  it('ONAPPUPDATE так же захватывает/ротирует токен', async () => {
    const { app, appStore } = appWith(vi.fn(async () => true));
    await request(app).post('/b24/app/event').type('form').send(install({ event: 'ONAPPUPDATE', 'auth[application_token]': 'UPDTOK' }));
    expect(await until(() => appStore.isKnownToken('UPDTOK'))).toBe(true);
  });

  it('ONAPPUNINSTALL чистит захваченный токен', async () => {
    const { app, appStore } = appWith(vi.fn(async () => true));
    await request(app).post('/b24/app/event').type('form').send(install());
    expect(await until(() => appStore.isKnownToken('APPTOK'))).toBe(true);
    await request(app).post('/b24/app/event').type('form')
      .send({ event: 'ONAPPUNINSTALL', 'auth[application_token]': 'APPTOK', 'auth[member_id]': 'm1' });
    expect(await until(async () => !(await appStore.isKnownToken('APPTOK')))).toBe(true);
  });

  it('env-токен и стор сосуществуют: проходит и env-токен, и захваченный; пустой → 403', async () => {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-evt-'));
    const appStore = createAppStore({ redisUrl: '' });
    await appStore.recordInstall({ memberId: 'm9', applicationToken: 'CAPTURED' });
    const app = createApp({ token: 'T', uploadDir, rateLimitMax: 0, metrics: fakeMetrics(), appStore, b24BotApplicationToken: 'ENVTOK', portalDomains: ['p.bitrix24.by'] });
    const join = (tok) => request(app).post('/b24/bot/event').type('form')
      .send({ event: 'ONIMBOTV2JOINCHAT', 'auth[application_token]': tok, 'data[bot][id]': '1', 'data[bot][auth][access_token]': 'b' });
    expect((await join('ENVTOK')).status).toBe(200);    // env-фолбэк не сломан стором
    expect((await join('CAPTURED')).status).toBe(200);  // захваченный токен валиден
    expect((await join('NOPE')).status).toBe(403);
    expect((await join('')).status).toBe(403);          // пустой токен — 403 даже при непустом сторе
    expect((await join('   ')).status).toBe(403);        // пробельный — тоже не «известный»
  });
});
