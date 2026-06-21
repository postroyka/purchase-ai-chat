// Чат-бот Битрикс24 (дизайн — docs/B24_BOT.md): чистая логика разбора/роутинга событий бота.
// Весь I/O (скачивание файла, отправка сообщения, запуск задания, отзыв) ИНЪЕКТИРУЕТСЯ через deps —
// поэтому модуль тестируется без живого портала. Боевые REST-вызовы imbot.v2.* — в b24-bot-api.js
// (граница, требующая портал-QA). Используем API чат-ботов 2.0 (события ONIMBOTV2*).

import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

// Webhook-режим Б24 сериализует тело через http_build_query → ВСЕ скаляры приходят строками,
// ключи в PHP-виде (data[bot][id]); express.urlencoded({extended:true}) парсит их в объект.
const s = (v) => (v == null ? '' : String(v));

/**
 * Привести сырое тело вебхук-события к нормализованной форме.
 * @returns {{ event:string, applicationToken:string, bot:{id,code,token}, dialogId:string,
 *   message:{id,text,files:Array<{id,name}>}, command:{name,params,context}, user:{id,isBot} }}
 */
export function parseBotEvent(body = {}) {
  const data = (body && typeof body.data === 'object' && body.data) || {};
  const bot = (data.bot && typeof data.bot === 'object' && data.bot) || {};
  const botAuth = (bot.auth && typeof bot.auth === 'object' && bot.auth) || {};
  const msg = (data.message && typeof data.message === 'object' && data.message) || {};
  const cmd = (data.command && typeof data.command === 'object' && data.command) || {};
  const user = (data.user && typeof data.user === 'object' && data.user) || {};
  const topAuth = (body.auth && typeof body.auth === 'object' && body.auth) || {};

  // Файлы v2 приходят в структурном message; форму (message.files[].id/name) сверить на портале.
  const rawFiles = Array.isArray(msg.files) ? msg.files
    : (msg.files && typeof msg.files === 'object' ? Object.values(msg.files) : []);
  const files = rawFiles
    .map((f) => ({ id: s(f && f.id), name: s(f && (f.name ?? f.fileName)) }))
    .filter((f) => f.id !== '');

  return {
    event: s(body.event).toUpperCase(),
    applicationToken: s(topAuth.application_token),
    // restEndpoint — база REST портала для обратных вызовов бота (client_endpoint из OAuth-токена бота).
    bot: { id: s(bot.id), code: s(bot.code), token: s(botAuth.access_token), restEndpoint: s(botAuth.client_endpoint || topAuth.client_endpoint) },
    // dialogId в data (join/context-события) или в message (сообщение); чат — chatXXX/число.
    dialogId: s(data.dialogId || msg.dialogId),
    message: { id: s(msg.id), text: s(msg.text), files },
    command: { name: s(cmd.command), params: s(cmd.params), context: s(cmd.context) },
    user: { id: s(user.id), isBot: s(user.bot) === '1' || s(user.bot).toLowerCase() === 'true' },
  };
}

/**
 * Привести сырое тело APP-события (ONAPPINSTALL/ONAPPUNINSTALL) к нормализованной форме (#217).
 * Тело — form-urlencoded с PHP-ключами (`auth[application_token]` и т.д.); все скаляры — строки.
 * `application_token` приходит ТОЛЬКО в этих серверных событиях (не в iframe-установке).
 * @returns {{ event:string, applicationToken:string, accessToken:string, memberId:string, domain:string, clientEndpoint:string }}
 */
export function parseAppEvent(body = {}) {
  const auth = (body && typeof body.auth === 'object' && body.auth) || {};
  return {
    event: s(body.event).toUpperCase(),
    applicationToken: s(auth.application_token),
    accessToken: s(auth.access_token),
    memberId: s(auth.member_id),
    domain: s(auth.domain),
    clientEndpoint: s(auth.client_endpoint),
  };
}

// Кнопка-команда 👍/👎: COMMAND_PARAMS = "like <jobId>" / "dislike <jobId>" → отзыв.
// kind по контракту feedback: 👍→positive, 👎→problem.
export function parseFeedbackParams(params = '') {
  const m = /^\s*(like|dislike)\s+([A-Za-z0-9-]{1,64})\s*$/.exec(s(params));
  if (!m) return null;
  return { kind: m[1] === 'like' ? 'positive' : 'problem', jobId: m[2] };
}

// Клавиатура 👍/👎 под результатом (формат B24: { BUTTONS:[...] }; команда feedback должна быть
// зарегистрирована imbot.command.register, чтобы клик породил ONIMBOTV2COMMANDADD).
export function feedbackKeyboard(jobId) {
  return { BUTTONS: [
    { TEXT: '👍 Верно', COMMAND: 'feedback', COMMAND_PARAMS: `like ${jobId}`, BG_COLOR: '#1ec391', TEXT_COLOR: '#ffffff', DISPLAY: 'LINE' },
    { TEXT: '👎 Не то', COMMAND: 'feedback', COMMAND_PARAMS: `dislike ${jobId}`, BG_COLOR: '#f56b54', TEXT_COLOR: '#ffffff', DISPLAY: 'LINE' },
  ] };
}

// Текст результата по завершённому заданию (зеркалит страницу результата): успех со сделкой,
// «Без сделки» + причина (#192), либо ошибка. dealOf/problemOf — те же поля, что читает UI.
export function botResultText(job) {
  const files = Array.isArray(job?.files) ? job.files : [];
  const lines = files.map((f) => {
    if (f.status === 'error') return `• ${f.name}: ошибка — ${truncate(f.error, 200)}`;
    const deal = f.result && typeof f.result === 'object' && f.result.deal;
    if (deal && deal.dealId != null && String(deal.dealId).trim() !== '') {
      return `• ${f.name}: ✅ Сделка #${deal.dealId}`;
    }
    return `• ${f.name}: ⚠️ Без сделки${f.problem ? ` — ${truncate(f.problem, 200)}` : ''}`;
  });
  const head = files.length > 1 ? `Готово (${files.length} файлов):` : 'Готово:';
  return [head, ...lines].join('\n');
}

function truncate(v, n) {
  const str = s(v);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

const HINT_NO_FILE = 'Бросьте в чат файл счёта (PDF, скан/фото, XLSX/DOCX) — создам сделку и пришлю результат.';
const WELCOME = 'Привет! Бросьте сюда файл счёта поставщика (PDF/скан/Excel) — распознаю и создам сделку в «Закупках», затем пришлю результат с кнопками 👍/👎.';

/**
 * Оркестрация события бота. Весь I/O — через deps (инъекция → тестируемо без портала).
 *
 * deps = {
 *   downloadAndSaveFiles(files, {botToken}) → Promise<{ jobId, jobDir, fileEntries }>,
 *   createAndStartJob({jobId,jobDir,fileEntries,responsibleUserId,onDone}) → Promise,
 *   submitFeedback({kind, jobId, reporter}) → Promise,
 *   sendMessage({dialogId, text, keyboard?, botToken, botId}) → Promise,
 *   responsibleUserIdFor(userId) → string,   // маппинг автора → ответственный (+ фолбэк)
 *   log?(msg)
 * }
 * Возвращает строку-исход (для логов/тестов): 'started' | 'hint' | 'feedback' | 'welcome' | 'ignored:<why>'.
 */
export async function handleBotEvent(evt, deps) {
  const send = (text, keyboard) => deps.sendMessage({
    dialogId: evt.dialogId, text, keyboard, botToken: evt.bot.token, botId: evt.bot.id,
  }).catch((e) => deps.log?.(`[b24bot] sendMessage failed: ${e?.message}`));

  switch (evt.event) {
    case 'ONIMBOTV2MESSAGEADD': {
      if (evt.user.isBot) return 'ignored:from_bot'; // не реагируем на собственные/ботовые сообщения
      if (evt.message.files.length === 0) { await send(HINT_NO_FILE); return 'hint'; }
      // Тот же DoS-гард, что у /upload (лимит одновременных заданий): занято → просим повторить.
      if (deps.hasCapacity && !deps.hasCapacity()) { await send('Сейчас много задач в обработке — пришлите файл чуть позже.'); return 'ignored:busy'; }

      // Одно сообщение с N файлами → ОДНО задание с N файлами. Несколько сообщений (сценарий
      // «>1 сообщения на импорт») приходят отдельными событиями и обрабатываются независимо — каждое
      // создаёт своё задание; никакого общего состояния между событиями нет.
      const responsibleUserId = deps.responsibleUserIdFor(evt.user.id);
      let saved;
      try {
        saved = await deps.downloadAndSaveFiles(evt.message.files, { botToken: evt.bot.token });
      } catch (e) {
        deps.log?.(`[b24bot] download failed: ${e?.message}`);
        await send('Не удалось забрать файл из чата. Попробуйте ещё раз.');
        return 'ignored:download_failed';
      }
      if (!saved || saved.fileEntries.length === 0) { await send('Не нашёл подходящих файлов в сообщении.'); return 'ignored:no_valid_files'; }

      await send(saved.fileEntries.length > 1
        ? `Принял ${saved.fileEntries.length} файлов, обрабатываю…`
        : 'Принял, обрабатываю…');
      await deps.createAndStartJob({
        jobId: saved.jobId, jobDir: saved.jobDir, fileEntries: saved.fileEntries, responsibleUserId,
        onDone: (job) => send(botResultText(job), feedbackKeyboard(saved.jobId)),
      });
      return 'started';
    }

    case 'ONIMBOTV2COMMANDADD': {
      if (s(evt.command.name).replace(/^\//, '') !== 'feedback') return 'ignored:other_command';
      const fb = parseFeedbackParams(evt.command.params);
      if (!fb) return 'ignored:bad_feedback_params';
      await deps.submitFeedback({ kind: fb.kind, jobId: fb.jobId, reporter: `b24/user:${evt.user.id}` })
        .catch((e) => deps.log?.(`[b24bot] submitFeedback failed: ${e?.message}`));
      await send(fb.kind === 'positive' ? 'Спасибо за оценку! 👍' : 'Спасибо, учту. Что было не так — можно ответить сообщением.');
      return 'feedback';
    }

    case 'ONIMBOTV2JOINCHAT':
      await send(WELCOME);
      return 'welcome';

    case 'ONIMBOTV2DELETE':
      return 'ignored:bot_deleted'; // очистка состояния — на стороне роутера (если будет стор)

    default:
      return `ignored:${evt.event || 'empty'}`;
  }
}

// Утилита для роутера: собрать fileEntries из уже скачанных на диск файлов (та же форма, что в /upload).
export function buildJobPaths(uploadDir) {
  const jobId = uuidv4();
  const jobDir = path.join(uploadDir, jobId);
  return { jobId, jobDir };
}
