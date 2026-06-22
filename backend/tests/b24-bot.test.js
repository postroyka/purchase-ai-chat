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

// LEGACY-режим (#241): портал заказчика старый (imbot.v2.* → 404). События ONIMBOT*/ONIMCOMMANDADD,
// payload с UPPERCASE-ключами (data.BOT[id], data.PARAMS, data.USER). Скачивание — по ссылке из события.

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
describe('parseBotEvent (legacy)', () => {
  it('нормализует UPPERCASE PHP-ключи/строки события в объект', () => {
    const e = parseBotEvent({
      event: 'ONIMBOTMESSAGEADD',
      auth: { application_token: 'apptok', client_endpoint: 'https://p.bitrix24.ru/rest/' },
      data: {
        BOT: { 456: { access_token: 'botok', client_endpoint: 'https://p.bitrix24.ru/rest/', BOT_CODE: 'procure_ai_invoice' } },
        PARAMS: { BOT_ID: '456', DIALOG_ID: 'chat5', MESSAGE_ID: '789', MESSAGE: 'привет', FROM_USER_ID: '27',
          FILES: [{ id: '12', name: 'schet.pdf', urlDownload: '/im_disk.php?id=12' }] },
        USER: { ID: '27' },
      },
    });
    expect(e.event).toBe('ONIMBOTMESSAGEADD');
    expect(e.applicationToken).toBe('apptok');
    expect(e.bot).toMatchObject({ id: '456', code: 'procure_ai_invoice', token: 'botok', restEndpoint: 'https://p.bitrix24.ru/rest/' });
    expect(e.dialogId).toBe('chat5');
    expect(e.message.files).toEqual([{ id: '12', name: 'schet.pdf', urlDownload: '/im_disk.php?id=12' }]);
    expect(e.user).toEqual({ id: '27', isBot: false });
  });

  it('команда (ONIMCOMMANDADD): бот-авторизация и поля команды — внутри data.COMMAND[<COMMAND_ID>]', () => {
    // Сверено с офиц. докой: data.COMMAND = { "103": { access_token, BOT_ID, COMMAND, COMMAND_PARAMS, ... } },
    // контекст диалога/автора — в data.PARAMS. data.BOT для события команды НЕ приходит.
    const e = parseBotEvent({
      event: 'ONIMCOMMANDADD',
      auth: { application_token: 'apptok' },
      data: {
        COMMAND: { 103: {
          access_token: 'botok', client_endpoint: 'https://p.bitrix24.ru/rest/', application_token: 'apptok',
          BOT_ID: '456', BOT_CODE: 'procure_ai_invoice',
          COMMAND: 'feedback', COMMAND_ID: '103', COMMAND_PARAMS: 'like job1', COMMAND_CONTEXT: 'KEYBOARD', MESSAGE_ID: '88',
        } },
        PARAMS: { DIALOG_ID: 'chat5', FROM_USER_ID: '27', MESSAGE: '/feedback like job1' },
      },
    });
    expect(e.event).toBe('ONIMCOMMANDADD');
    expect(e.bot).toMatchObject({ id: '456', code: 'procure_ai_invoice', token: 'botok', restEndpoint: 'https://p.bitrix24.ru/rest/' });
    expect(e.dialogId).toBe('chat5');
    expect(e.command).toEqual({ name: 'feedback', params: 'like job1', context: 'KEYBOARD' });
    expect(e.user).toEqual({ id: '27', isBot: false });
  });

  it('USER.IS_BOT="Y" → isBot:true даже если автор ≠ BOT_ID (основной гард от эха)', () => {
    const e = parseBotEvent({ event: 'ONIMBOTMESSAGEADD', data: { BOT: { 9: { access_token: 't' } }, PARAMS: { BOT_ID: '9', FROM_USER_ID: '42' }, USER: { ID: '42', IS_BOT: 'Y' } } });
    expect(e.user).toEqual({ id: '42', isBot: true });
  });

  it('application_token берётся из записи бота, если top-level auth отсутствует (фолбэк)', () => {
    const e = parseBotEvent({ event: 'ONIMBOTJOINCHAT', data: { BOT: { 1: { access_token: 't', application_token: 'frombot' } }, PARAMS: { BOT_ID: '1' } } });
    expect(e.applicationToken).toBe('frombot');
  });

  it('FILES как объект (qs-массив) — записи без id и без ссылки отфильтрованы', () => {
    const e = parseBotEvent({ event: 'x', data: { PARAMS: { FILES: { 0: { id: '1', name: 'a.pdf' }, 1: { id: '', name: 'b' } } } } });
    expect(e.message.files).toEqual([{ id: '1', name: 'a.pdf', urlDownload: '' }]);
  });

  it('сообщение от самого бота: FROM_USER_ID == BOT_ID → isBot:true', () => {
    const e = parseBotEvent({ event: 'ONIMBOTMESSAGEADD', data: { BOT: { 5: { access_token: 't' } }, PARAMS: { BOT_ID: '5', FROM_USER_ID: '5' } } });
    expect(e.user).toEqual({ id: '5', isBot: true });
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
// Нормализованное событие (как из parseBotEvent) — событие legacy ONIMBOTMESSAGEADD.
const msgEvt = (files, over = {}) => ({
  event: 'ONIMBOTMESSAGEADD', dialogId: 'chat5', bot: { id: '456', token: 't' },
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
      event: 'ONIMCOMMANDADD', dialogId: 'chat5', bot: { id: '456', token: 't' }, message: {},
      command: { name: 'feedback', params: 'like job1', context: 'keyboard' }, user: { id: '27', isBot: false },
    }, deps);
    expect(r).toBe('feedback');
    expect(deps.submitFeedback).toHaveBeenCalledWith({ kind: 'positive', jobId: 'job1', reporter: 'b24/user:27' });
  });

  it('команда /feedback dislike → problem', async () => {
    const deps = makeDeps();
    await handleBotEvent({
      event: 'ONIMCOMMANDADD', dialogId: 'c', bot: { id: '1', token: 't' }, message: {},
      command: { name: '/feedback', params: 'dislike j2', context: 'keyboard' }, user: { id: '5', isBot: false },
    }, deps);
    expect(deps.submitFeedback).toHaveBeenCalledWith({ kind: 'problem', jobId: 'j2', reporter: 'b24/user:5' });
  });

  it('join → приветствие', async () => {
    const deps = makeDeps();
    const r = await handleBotEvent({ event: 'ONIMBOTJOINCHAT', dialogId: 'c', bot: { id: '1', token: 't' }, message: {}, command: {}, user: {} }, deps);
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
      event: 'ONIMCOMMANDADD', dialogId: 'c', bot: { id: '1', token: 't' }, message: {},
      command: { name: 'feedback', params: 'garbage', context: 'keyboard' }, user: { id: '5', isBot: false },
    }, deps);
    expect(r).toBe('ignored:bad_feedback_params');
    expect(deps.submitFeedback).not.toHaveBeenCalled();
  });
});

// ── Роут POST /b24/bot/event (валидация токена + проводка), legacy-payload ──────
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
      .send({ event: 'ONIMBOTJOINCHAT', 'auth[application_token]': 'WRONG', 'data[PARAMS][DIALOG_ID]': 'chat5', 'data[BOT][1][access_token]': 'b' });
    expect(res.status).toBe(403);
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('верный токен → 200 быстро + обработчик вызван (join → приветствие)', async () => {
    const { app, botApi } = appWith();
    const res = await request(app).post('/b24/bot/event').type('form')
      .send({ event: 'ONIMBOTJOINCHAT', 'auth[application_token]': 'secret', 'data[PARAMS][DIALOG_ID]': 'chat5', 'data[BOT][1][access_token]': 'botok' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(botApi.sendMessage).toHaveBeenCalled());
  });

  it('бот выключен (нет B24_BOT_APPLICATION_TOKEN) → 403 на любой запрос', async () => {
    const prev = process.env.B24_BOT_APPLICATION_TOKEN;
    delete process.env.B24_BOT_APPLICATION_TOKEN;
    try {
      const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-off-'));
      const app = createApp({ token: 'T', uploadDir, rateLimitMax: 0, metrics: fakeMetrics() }); // без b24BotApplicationToken
      const res = await request(app).post('/b24/bot/event').type('form').send({ event: 'ONIMBOTJOINCHAT', 'auth[application_token]': '' });
      expect(res.status).toBe(403);
    } finally {
      if (prev !== undefined) process.env.B24_BOT_APPLICATION_TOKEN = prev;
    }
  });

  it('команда feedback (без токена фидбэка) → recordFeedback(source:user) и без падения', async () => {
    const { app, metrics } = appWith();
    // Legacy-форма ONIMCOMMANDADD: команда и бот-авторизация — внутри data[COMMAND][<COMMAND_ID>].
    const res = await request(app).post('/b24/bot/event').type('form').send({
      event: 'ONIMCOMMANDADD', 'auth[application_token]': 'secret', 'data[PARAMS][DIALOG_ID]': 'chat5',
      'data[PARAMS][FROM_USER_ID]': '27', 'data[USER][ID]': '27',
      'data[COMMAND][103][access_token]': 'botok', 'data[COMMAND][103][BOT_ID]': '1',
      'data[COMMAND][103][COMMAND]': 'feedback', 'data[COMMAND][103][COMMAND_PARAMS]': 'like job1', 'data[COMMAND][103][COMMAND_CONTEXT]': 'KEYBOARD',
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
      event: 'ONIMBOTMESSAGEADD', 'auth[application_token]': 'secret', 'data[PARAMS][DIALOG_ID]': 'chat5',
      'data[BOT][1][access_token]': 'botok', 'data[PARAMS][FROM_USER_ID]': '27', 'data[USER][ID]': '27',
      'data[PARAMS][MESSAGE_ID]': '1', 'data[PARAMS][FILES][0][id]': '12', 'data[PARAMS][FILES][0][name]': 'schet.pdf',
      'data[PARAMS][FILES][0][urlDownload]': 'https://p.bitrix24.ru/f',
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

// ── b24-bot-api: фильтрация/SSRF в downloadAndSaveFiles (legacy: качаем по urlDownload из события) ─
describe('makeBotApi.downloadAndSaveFiles (legacy)', () => {
  const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]; // %PDF-1.4\n
  const pdfBytes = (n) => {
    const out = new Uint8Array(Math.max(n, PDF_HEADER.length));
    out.set(PDF_HEADER);
    return out.buffer;
  };
  // Любой fetch (это уже скачивание файла — отдельного imbot.v2.File.download больше нет).
  const okFetch = (bytes = 16, contentLength = '16') => vi.fn(async () =>
    ({ ok: true, headers: { get: () => contentLength }, arrayBuffer: async () => pdfBytes(bytes) }));
  const mk = (over = {}) => makeBotApi({
    restEndpoint: 'https://p.bitrix24.ru/rest/', uploadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bot-api-')),
    allowedExtensions: ['pdf'], maxBytes: 1024, maxFiles: 10, isAllowedHost: () => true, ...over,
  });

  it('неразрешённый ext пропускается; all-filtered → jobDir удалён', async () => {
    const api = mk({ fetchImpl: okFetch() });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'a.exe', urlDownload: 'https://p.bitrix24.ru/f' }], { botToken: 't' });
    expect(r.fileEntries).toEqual([]);
    expect(fs.existsSync(r.jobDir)).toBe(false);
  });

  it('oversize по Content-Length пропускается', async () => {
    const api = mk({ fetchImpl: okFetch(9999, '9999'), maxBytes: 100 });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'a.pdf', urlDownload: 'https://p.bitrix24.ru/f' }], { botToken: 't' });
    expect(r.fileEntries).toEqual([]);
  });

  it('SSRF: urlDownload на чужом домене → throw (host not allowed)', async () => {
    const api = mk({ fetchImpl: okFetch(), isAllowedHost: (h) => h.endsWith('.bitrix24.ru') });
    await expect(api.downloadAndSaveFiles([{ id: '1', name: 'a.pdf', urlDownload: 'https://evil.example.com/f' }], { botToken: 't' })).rejects.toThrow(/not allowed/);
  });

  it('относительный urlDownload → префикс домена из restEndpoint + auth токеном бота', async () => {
    const seen = [];
    const api = mk({ fetchImpl: vi.fn(async (url) => { seen.push(String(url)); return { ok: true, headers: { get: () => '16' }, arrayBuffer: async () => pdfBytes(16) }; }) });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'a.pdf', urlDownload: '/im_disk.php?id=1' }], { botToken: 'TOK' });
    expect(r.fileEntries).toHaveLength(1);
    expect(seen[0]).toBe('https://p.bitrix24.ru/im_disk.php?id=1&auth=TOK');
  });

  it('относительный urlDownload + нераспознаваемый restEndpoint → ссылка не собрана, файл пропущен (без fetch)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, headers: { get: () => '16' }, arrayBuffer: async () => pdfBytes(16) }));
    const api = mk({ restEndpoint: 'not-a-url', fetchImpl });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'a.pdf', urlDownload: '/im_disk.php?id=1' }], { botToken: 'TOK' });
    expect(r.fileEntries).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled(); // resolveDownloadUrl('') → continue до сетевого вызова
  });

  it('cap по числу файлов (maxFiles)', async () => {
    const api = mk({ fetchImpl: okFetch(), maxFiles: 2 });
    const r = await api.downloadAndSaveFiles([
      { id: '1', name: 'a.pdf', urlDownload: 'https://p.bitrix24.ru/a' },
      { id: '2', name: 'b.pdf', urlDownload: 'https://p.bitrix24.ru/b' },
      { id: '3', name: 'c.pdf', urlDownload: 'https://p.bitrix24.ru/c' },
    ], { botToken: 't' });
    expect(r.fileEntries).toHaveLength(2); // 3-й отброшен cap-ом
  });

  it('валидный по содержимому PDF сохраняется (#216)', async () => {
    const api = mk({ fetchImpl: okFetch() });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'a.pdf', urlDownload: 'https://p.bitrix24.ru/f' }], { botToken: 't' });
    expect(r.fileEntries).toHaveLength(1);
  });

  it('смешанная партия: валидный сохраняется, невалидный пропускается, jobDir сохраняется (#216)', async () => {
    // тело зависит от URL: .../1 — валидный PDF, .../2 — нули (не распознаётся).
    const mixedFetch = vi.fn(async (url) => {
      const valid = String(url).startsWith('https://p.bitrix24.ru/1');
      return { ok: true, headers: { get: () => '64' }, arrayBuffer: async () => (valid ? pdfBytes(16) : new Uint8Array(64).buffer) };
    });
    const api = mk({ fetchImpl: mixedFetch });
    const r = await api.downloadAndSaveFiles([
      { id: '1', name: 'ok.pdf', urlDownload: 'https://p.bitrix24.ru/1' },
      { id: '2', name: 'bad.pdf', urlDownload: 'https://p.bitrix24.ru/2' },
    ], { botToken: 't' });
    expect(r.fileEntries).toHaveLength(1);
    expect(r.fileEntries[0].name).toBe('ok.pdf');
    expect(fs.existsSync(r.jobDir)).toBe(true); // непустая партия → каталог НЕ удаляется
  });

  it('невалидный MIME (содержимое ≠ разрешённый тип) пропускается (#216)', async () => {
    const badFetch = vi.fn(async () => ({ ok: true, headers: { get: () => '64' }, arrayBuffer: async () => new Uint8Array(64).buffer }));
    const api = mk({ fetchImpl: badFetch });
    const r = await api.downloadAndSaveFiles([{ id: '1', name: 'a.pdf', urlDownload: 'https://p.bitrix24.ru/f' }], { botToken: 't' });
    expect(r.fileEntries).toEqual([]);
    expect(fs.existsSync(r.jobDir)).toBe(false);
  });
});

// ── POST /b24/app/event — захват application_token (#217), не затронут legacy-переключением ───────
describe('POST /b24/app/event (захват токена + проверка через app.info)', () => {
  const fakeMetrics = () => ({
    recordUpload: vi.fn(async () => {}), recordFeedback: vi.fn(async () => {}), recordFile: vi.fn(async () => {}),
    recordMatching: vi.fn(async () => {}), recordWarnings: vi.fn(async () => {}), snapshot: vi.fn(async () => ({})), ping: vi.fn(async () => {}),
  });
  const until = async (fn, ms = 1000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 10)); }
    return false;
  };
  function appWith(appInfo) {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-evt-'));
    const appStore = createAppStore({ redisUrl: '' });
    const app = createApp({ token: 'T', uploadDir, rateLimitMax: 0, metrics: fakeMetrics(), appStore, appInfo, portalDomains: ['p.bitrix24.by'] });
    return { app, appStore };
  }
  const install = (over = {}) => ({
    event: 'ONAPPINSTALL', 'auth[application_token]': 'APPTOK', 'auth[access_token]': 'ACC',
    'auth[member_id]': 'm1', 'auth[domain]': 'p.bitrix24.by', ...over,
  });
  // join-событие бота с legacy-ключами (для проверки валидности токена через стор).
  const botJoin = (app, tok) => request(app).post('/b24/bot/event').type('form')
    .send({ event: 'ONIMBOTJOINCHAT', 'auth[application_token]': tok, 'data[BOT][1][access_token]': 'b' });

  it('валидный install (app.info ок, домен в allowlist) → токен захвачен, событие бота с ним проходит', async () => {
    const appInfo = vi.fn(async () => true);
    const { app, appStore } = appWith(appInfo);
    const res = await request(app).post('/b24/app/event').type('form').send(install());
    expect(res.status).toBe(200);
    expect(await until(() => appStore.isKnownToken('APPTOK'))).toBe(true);
    expect(appInfo).toHaveBeenCalledWith('p.bitrix24.by', 'ACC');
    expect((await botJoin(app, 'APPTOK')).status).toBe(200);
  });

  it('app.info вернул false → токен НЕ захвачен (recordInstall не вызван); событие бота с ним → 403', async () => {
    const appInfo = vi.fn(async () => false);
    const { app, appStore } = appWith(appInfo);
    const recordSpy = vi.spyOn(appStore, 'recordInstall');
    await request(app).post('/b24/app/event').type('form').send(install());
    expect(await until(() => appInfo.mock.calls.length > 0)).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(recordSpy).not.toHaveBeenCalled();
    expect(await appStore.isKnownToken('APPTOK')).toBe(false);
    expect((await botJoin(app, 'APPTOK')).status).toBe(403);
  });

  it('домен НЕ в allowlist → app.info даже не вызывается, recordInstall не вызван (SSRF-гард)', async () => {
    const appInfo = vi.fn(async () => true);
    const { app, appStore } = appWith(appInfo);
    const recordSpy = vi.spyOn(appStore, 'recordInstall');
    await request(app).post('/b24/app/event').type('form').send(install({ 'auth[domain]': 'evil.example.com' }));
    await new Promise((r) => setImmediate(r));
    expect(appInfo).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
    expect(await appStore.isKnownToken('APPTOK')).toBe(false);
  });

  it('слишком длинный access_token → app.info не вызывается, не захвачен', async () => {
    const appInfo = vi.fn(async () => true);
    const { app, appStore } = appWith(appInfo);
    await request(app).post('/b24/app/event').type('form').send(install({ 'auth[access_token]': 'x'.repeat(4097) }));
    await new Promise((r) => setImmediate(r));
    expect(appInfo).not.toHaveBeenCalled();
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
    expect((await botJoin(app, 'ENVTOK')).status).toBe(200);    // env-фолбэк не сломан стором
    expect((await botJoin(app, 'CAPTURED')).status).toBe(200);  // захваченный токен валиден
    expect((await botJoin(app, 'NOPE')).status).toBe(403);
    expect((await botJoin(app, '')).status).toBe(403);          // пустой токен — 403 даже при непустом сторе
    expect((await botJoin(app, '   ')).status).toBe(403);        // пробельный — тоже не «известный»
  });
});
