import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import request from 'supertest';
import { parseBotEvent, parseFeedbackParams, feedbackKeyboard, botResultText, handleBotEvent } from '../b24-bot.js';
import { createApp } from '../index.js';

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
});

// ── Роут POST /b24/bot/event (валидация токена + проводка) ──────────────────────
describe('POST /b24/bot/event', () => {
  const fakeMetrics = () => ({ recordUpload: vi.fn(async () => {}), recordFeedback: vi.fn(async () => {}) });
  function appWith() {
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-route-'));
    const botApi = { sendMessage: vi.fn(async () => {}), downloadAndSaveFiles: vi.fn(async () => ({ jobId: 'j', jobDir: path.join(uploadDir, 'j'), fileEntries: [] })) };
    const app = createApp({ token: 'T', uploadDir, rateLimitMax: 0, metrics: fakeMetrics(), b24BotApplicationToken: 'secret', botApi });
    return { app, botApi };
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
});
