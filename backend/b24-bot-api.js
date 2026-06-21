// ⚠️ ГРАНИЦА, ТРЕБУЮЩАЯ ПОРТАЛ-QA (docs/B24_BOT.md §10, «Осталось → Портал-QA»).
// Боевые REST-вызовы к Битрикс24 для чат-бота 2.0. Точные имена методов/полей (imbot.v2.File.download,
// imbot.message.add KEYBOARD) и форма ответа — СВЕРИТЬ на живом портале при реализации. Вся логика
// разбора/роутинга — в b24-bot.js (тестируется без портала); этот модуль инъектируется как deps.
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { validateSniffedMime, MIME_SNIFF_BYTES } from './file-validation.js';

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

  // OAuth-вызов REST портала токеном бота из события (auth в теле — сверить форму на портале).
  // redirect:'error' — не идём за редиректом (анти-SSRF-через-редирект, как в auth.js).
  async function rest(method, accessToken, params) {
    const url = `${cfg.restEndpoint.replace(/\/$/, '')}/${method}`;
    assertAllowed(url);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, auth: accessToken }),
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

  // imbot.v2.File.download(botId,fileId)→downloadUrl → скачать → проверить host/размер/ext → сохранить.
  async function downloadAndSaveFiles(files, { botToken, botId }) {
    const list = Array.isArray(files) ? files.slice(0, cfg.maxFiles ?? files.length) : []; // cap числа файлов
    const jobId = uuidv4();
    const jobDir = path.join(cfg.uploadDir, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const fileEntries = [];
    for (const f of list) {
      const ext = path.extname(f.name).slice(1).toLowerCase();
      if (!cfg.allowedExtensions.includes(ext)) continue; // тип не разрешён
      const dl = await rest('imbot.v2.File.download', botToken, { botId, fileId: f.id });
      const downloadUrl = dl && (dl.downloadUrl || dl.DOWNLOAD_URL);
      if (!downloadUrl) continue;
      assertAllowed(downloadUrl); // SSRF на downloadUrl (CDN портала)
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
}
