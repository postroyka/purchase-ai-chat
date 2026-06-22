// Чат-бот Битрикс24 (дизайн — docs/B24_BOT.md): чистая логика разбора/роутинга событий бота.
// Весь I/O (скачивание файла, отправка сообщения, запуск задания, отзыв) ИНЪЕКТИРУЕТСЯ через deps —
// поэтому модуль тестируется без живого портала. Боевые REST-вызовы — в b24-bot-api.js (граница,
// требующая портал-QA).
//
// ⚠️ LEGACY-режим (портал заказчика старый — imbot.v2.* → 404). Разбираем устаревшие события
// ONIMBOTMESSAGEADD / ONIMCOMMANDADD / ONIMBOTJOINCHAT / ONIMBOTDELETE с UPPERCASE-payload
// (data.BOT[id], data.PARAMS, auth). Версия для v2 (события ONIMBOTV2*) НЕ удалена — закомментирована
// блоками «=== v2 (вернуть при тираже) ===»; на новом портале вернёмся к ней.

import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

// Webhook-режим Б24 сериализует тело через http_build_query → ВСЕ скаляры приходят строками,
// ключи в PHP-виде (data[bot][id]); express.urlencoded({extended:true}) парсит их в объект.
const s = (v) => (v == null ? '' : String(v));

/**
 * Привести сырое тело LEGACY-вебхук-события к нормализованной форме.
 * Legacy-payload (сверено с офиц. докой): UPPERCASE-ключи —
 *   data.BOT[<botId>].{access_token, client_endpoint, application_token, AUTH{...}, BOT_CODE},
 *   data.PARAMS.{DIALOG_ID, MESSAGE, MESSAGE_ID, FROM_USER_ID, FILES, COMMAND, COMMAND_PARAMS},
 *   data.USER.{ID}, auth.{application_token, client_endpoint}.
 * @returns {{ event:string, applicationToken:string, bot:{id,code,token,restEndpoint}, dialogId:string,
 *   message:{id,text,files:Array<{id,name,urlDownload}>}, command:{name,params,context}, user:{id,isBot} }}
 */
export function parseBotEvent(body = {}) {
  const data = (body && typeof body.data === 'object' && body.data) || {};
  const params = (data.PARAMS && typeof data.PARAMS === 'object' && data.PARAMS) || {};
  const user = (data.USER && typeof data.USER === 'object' && data.USER) || {};
  const topAuth = (body.auth && typeof body.auth === 'object' && body.auth) || {};
  // BOT — объект, ключ = BOT_ID; берём указанного в PARAMS или единственного/первого.
  const botMap = (data.BOT && typeof data.BOT === 'object' && data.BOT) || {};
  const botId = s(params.BOT_ID || Object.keys(botMap)[0]);
  const botEntry = (botMap[botId] && typeof botMap[botId] === 'object' && botMap[botId])
    || (typeof Object.values(botMap)[0] === 'object' ? Object.values(botMap)[0] : {});
  const botAuth = (botEntry.AUTH && typeof botEntry.AUTH === 'object' && botEntry.AUTH) || {};

  // ⚠️ ПОРТАЛ-QA: форма файлов в legacy (data.PARAMS.FILES) зависит от версии портала — сверяем по
  // логу сырого события (#bot debug). Берём id + имя + ссылку скачивания под разными возможными ключами.
  const rawFiles = params.FILES;
  const fileList = Array.isArray(rawFiles) ? rawFiles
    : (rawFiles && typeof rawFiles === 'object' ? Object.values(rawFiles) : []);
  const files = fileList
    .map((f) => ({
      id: s(f && (f.id ?? f.ID ?? f.fileId)),
      name: s(f && (f.name ?? f.NAME ?? f.fileName)),
      urlDownload: s(f && (f.urlDownload ?? f.URL_DOWNLOAD ?? f.link ?? f.DOWNLOAD_URL ?? f.url)),
    }))
    .filter((f) => f.id !== '' || f.urlDownload !== '');

  const fromUserId = s(params.FROM_USER_ID || user.ID);

  return {
    event: s(body.event).toUpperCase(),
    applicationToken: s(topAuth.application_token || botEntry.application_token),
    // restEndpoint — база REST портала для обратных вызовов бота (client_endpoint токена бота).
    bot: {
      id: botId,
      code: s(botEntry.BOT_CODE || botEntry.code),
      token: s(botEntry.access_token || botAuth.access_token),
      restEndpoint: s(botEntry.client_endpoint || botAuth.client_endpoint || topAuth.client_endpoint),
    },
    dialogId: s(params.DIALOG_ID),
    message: { id: s(params.MESSAGE_ID), text: s(params.MESSAGE), files },
    // Команда (ONIMCOMMANDADD): legacy кладёт COMMAND/COMMAND_PARAMS в data или PARAMS — берём отовсюду.
    command: {
      name: s(data.COMMAND || params.COMMAND),
      params: s(data.COMMAND_PARAMS || params.COMMAND_PARAMS),
      context: s(data.COMMAND_CONTEXT || params.COMMAND_CONTEXT),
    },
    // isBot: сообщение от самого бота (автор == BOT_ID) — на него не реагируем.
    user: { id: fromUserId, isBot: fromUserId !== '' && fromUserId === botId },
  };
}

// === v2 parseBotEvent (вернуть при тираже — #229; события ONIMBOTV2*, payload в нижнем регистре) =====
// export function parseBotEvent(body = {}) {
//   const data = (body && typeof body.data === 'object' && body.data) || {};
//   const bot = (data.bot && typeof data.bot === 'object' && data.bot) || {};
//   const botAuth = (bot.auth && typeof bot.auth === 'object' && bot.auth) || {};
//   const msg = (data.message && typeof data.message === 'object' && data.message) || {};
//   const cmd = (data.command && typeof data.command === 'object' && data.command) || {};
//   const user = (data.user && typeof data.user === 'object' && data.user) || {};
//   const topAuth = (body.auth && typeof body.auth === 'object' && body.auth) || {};
//   const rawFiles = Array.isArray(msg.files) ? msg.files
//     : (msg.files && typeof msg.files === 'object' ? Object.values(msg.files) : []);
//   const files = rawFiles.map((f) => ({ id: s(f && f.id), name: s(f && (f.name ?? f.fileName)) })).filter((f) => f.id !== '');
//   return {
//     event: s(body.event).toUpperCase(),
//     applicationToken: s(topAuth.application_token),
//     bot: { id: s(bot.id), code: s(bot.code), token: s(botAuth.access_token), restEndpoint: s(botAuth.client_endpoint || topAuth.client_endpoint) },
//     dialogId: s(data.dialogId || msg.dialogId),
//     message: { id: s(msg.id), text: s(msg.text), files },
//     command: { name: s(cmd.command), params: s(cmd.params), context: s(cmd.context) },
//     user: { id: s(user.id), isBot: s(user.bot) === '1' || s(user.bot).toLowerCase() === 'true' },
//   };
// }
// ===================================================================================================

/**
 * Привести сырое тело APP-события (ONAPPINSTALL/ONAPPUPDATE/ONAPPUNINSTALL) к нормализованной форме (#217).
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
// зарегистрирована imbot.command.register, чтобы клик породил ONIMCOMMANDADD).
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
    case 'ONIMBOTMESSAGEADD': { // v2: ONIMBOTV2MESSAGEADD (вернуть при тираже)
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

    case 'ONIMCOMMANDADD': { // v2: ONIMBOTV2COMMANDADD (вернуть при тираже)
      if (s(evt.command.name).replace(/^\//, '') !== 'feedback') return 'ignored:other_command';
      const fb = parseFeedbackParams(evt.command.params);
      if (!fb) return 'ignored:bad_feedback_params';
      await deps.submitFeedback({ kind: fb.kind, jobId: fb.jobId, reporter: `b24/user:${evt.user.id}` })
        .catch((e) => deps.log?.(`[b24bot] submitFeedback failed: ${e?.message}`));
      await send(fb.kind === 'positive' ? 'Спасибо за оценку! 👍' : 'Спасибо, учту. Что было не так — можно ответить сообщением.');
      return 'feedback';
    }

    case 'ONIMBOTJOINCHAT': // v2: ONIMBOTV2JOINCHAT (вернуть при тираже)
      await send(WELCOME);
      return 'welcome';

    case 'ONIMBOTDELETE': // v2: ONIMBOTV2DELETE (вернуть при тираже)
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
