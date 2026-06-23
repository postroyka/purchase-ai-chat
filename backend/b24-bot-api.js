// ⚠️ ГРАНИЦА, ТРЕБУЮЩАЯ ПОРТАЛ-QA (docs/B24_BOT.md §10, «Осталось → Портал-QA»).
// Боевые REST-вызовы к Битрикс24 для чат-бота. Вся логика разбора/роутинга — в b24-bot.js (тестируется
// без портала); этот модуль инъектируется как deps.
//
// ⚠️ LEGACY-режим (портал заказчика старый — imbot.v2.* → 404):
//   • отправка ответа — imbot.message.add (он И ТАК legacy — не меняется);
//   • скачивание файла — НЕ через imbot.v2.File.download (его нет), а по ссылке из самого события
//     (data.PARAMS.FILES[].urlDownload), с авторизацией токеном бота. ⚠️ ТОЧНАЯ форма ссылки на старом
//     портале зависит от версии — снимаем сырой payload события в логе (#bot debug) и при необходимости
//     правим resolveDownloadUrl. Версия для v2 (imbot.v2.File.download) закомментирована ниже.
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { validateSniffedMime, MIME_SNIFF_BYTES } from './file-validation.js';

// Сериализация параметров REST в form-urlencoded в PHP-нотации (как http_build_query): вложенные
// объекты/массивы → key[sub][0]=…. Старый портал Битрикс24 читает параметры и auth из $_REQUEST
// (query/form), а НЕ из JSON-тела — JSON давал NO_AUTH_FOUND и терял параметры (#241, портал-QA).
function toFormBody(params, sp = new URLSearchParams(), prefix = '') {
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') toFormBody(v, sp, key);
    else sp.append(key, String(v));
  }
  return sp;
}

/**
 * Фабрика боевого botApi. restEndpoint/accessToken берутся из самого события (per-request).
 * @param {{ restEndpoint:string, fetchImpl?:Function, uploadDir:string, allowedExtensions:string[],
 *           maxBytes:number, maxFiles?:number, isAllowedHost?:(host:string)=>boolean, timeoutMs?:number }} cfg
 */
export function makeBotApi(cfg) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 15000;

  // SSRF-гард: исходящие бота ходят только на разрешённые домены портала (тот же allowlist, что у
  // /session/b24, из B24_FRAME_ANCESTORS). restEndpoint и downloadUrl приходят из события — недоверенные.
  function assertAllowed(u) {
    let host;
    try { host = new URL(u).host; } catch { throw new Error('bad url'); }
    if (cfg.isAllowedHost && !cfg.isAllowedHost(host)) {
      throw new Error('outbound host not allowed (SSRF guard)');
    }
  }

  // OAuth-вызов REST портала токеном бота из события. Старый портал читает auth/параметры из $_REQUEST
  // (query/form), а НЕ из JSON-тела → JSON давал NO_AUTH_FOUND (портал-QA #241). Поэтому: auth — в query
  // (как рабочий app.info в auth.js), параметры — form-urlencoded (PHP-нотация через toFormBody).
  // redirect:'error' — не идём за редиректом (анти-SSRF-через-редирект, как в auth.js).
  async function rest(method, accessToken, params) {
    const base = `${cfg.restEndpoint.replace(/\/$/, '')}/${method}`;
    const url = `${base}?auth=${encodeURIComponent(accessToken)}`;
    assertAllowed(url); // host из query не зависит — SSRF-гард по домену сохраняется
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: toFormBody(params).toString(),
        redirect: 'error',
        signal: ac.signal,
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || json.error) {
        throw new Error(`B24 ${method} failed: ${resp.status} ${json.error || ''}`.trim());
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  // imbot.message.add — текст + клавиатура 👍/👎 в тот же диалог.
  async function sendMessage({ dialogId, text, keyboard, botToken, botId }) {
    const params = { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: text };
    if (keyboard) params.KEYBOARD = keyboard;
    return rest('imbot.message.add', botToken, params);
  }

  // LEGACY: ссылка на файл уже в событии (data.PARAMS.FILES[].urlDownload). Привести к абсолютному URL
  // (на старом портале часто относительный путь im_disk.php) и добавить auth токеном бота.
  // ⚠️ ПОРТАЛ-QA: точная форма/необходимость auth зависят от версии портала — сверить по логу события.
  function resolveDownloadUrl(raw, botToken) {
    if (!raw) return '';
    let url = String(raw);
    if (url.startsWith('/')) {
      let origin;
      try { origin = new URL(cfg.restEndpoint).origin; } catch { return ''; }
      url = origin + url;
    }
    if (botToken && !/[?&]auth=/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + `auth=${encodeURIComponent(botToken)}`;
    }
    return url;
  }

  // Скачать файл(ы) из чата по ссылке из события → проверить host/размер/ext/MIME → сохранить.
  async function downloadAndSaveFiles(files, { botToken }) {
    const list = Array.isArray(files) ? files.slice(0, cfg.maxFiles ?? files.length) : []; // cap числа файлов
    const jobId = uuidv4();
    const jobDir = path.join(cfg.uploadDir, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const fileEntries = [];
    for (const f of list) {
      const ext = path.extname(f.name).slice(1).toLowerCase();
      if (!cfg.allowedExtensions.includes(ext)) continue; // тип не разрешён
      const downloadUrl = resolveDownloadUrl(f.urlDownload, botToken);
      if (!downloadUrl) continue;
      assertAllowed(downloadUrl); // SSRF на downloadUrl (диск портала)
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let buf;
      try {
        const fileResp = await fetchImpl(downloadUrl, { redirect: 'error', signal: ac.signal });
        const len = Number(fileResp.headers?.get?.('content-length'));
        if (Number.isFinite(len) && len > cfg.maxBytes) continue; // pre-check по Content-Length
        buf = Buffer.from(await fileResp.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
      if (buf.length > cfg.maxBytes) continue; // размер сверх лимита — пропускаем
      // MIME по «магическим байтам» — тот же контроль, что в /upload (#216): расширения+размера мало,
      // т.к. файл приходит из недоверенного чата. Проверяем содержимое до записи на диск/передачи агенту.
      const verdict = await validateSniffedMime(buf.subarray(0, MIME_SNIFF_BYTES), ext);
      if (!verdict.ok) continue; // содержимое не соответствует разрешённым типам — пропускаем
      const destPath = path.join(jobDir, `${uuidv4()}.${ext}`);
      fs.writeFileSync(destPath, buf);
      fileEntries.push({ name: path.basename(f.name), path: destPath, status: 'pending', result: null, error: null });
    }
    if (fileEntries.length === 0) fs.rmSync(jobDir, { recursive: true, force: true });
    return { jobId, jobDir, fileEntries };
  }

  return { sendMessage, downloadAndSaveFiles };

  // === v2 скачивание файла (вернуть при тираже — #243; на старом портале imbot.v2.File.download → 404):
  //   const dl = await rest('imbot.v2.File.download', botToken, { botId, fileId: f.id });
  //   const downloadUrl = dl && (dl.downloadUrl || dl.DOWNLOAD_URL);
  // …далее как в legacy (assertAllowed → fetch → size/MIME → write). Тогда же вернуть botId в сигнатуру.
}
