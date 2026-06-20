// ⚠️ ГРАНИЦА, ТРЕБУЮЩАЯ ПОРТАЛ-QA (docs/B24_BOT.md, §10 шаг 6).
// Боевые REST-вызовы к Битрикс24 для чат-бота 2.0. Точные имена методов/полей (imbot.v2.File.download,
// imbot.message.add KEYBOARD) и форма ответа — СВЕРИТЬ на живом портале при реализации. Вся логика
// разбора/роутинга — в b24-bot.js (тестируется без портала); этот модуль инъектируется как deps.
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

/**
 * Фабрика боевого botApi. restEndpoint/accessToken берутся из самого события (per-request).
 * @param {{ restEndpoint:string, fetchImpl?:Function, uploadDir:string,
 *           allowedExtensions:string[], maxBytes:number, timeoutMs?:number }} cfg
 */
export function makeBotApi(cfg) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 15000;

  // OAuth-вызов REST портала токеном бота из события. (Форму передачи auth сверить на портале —
  // обычно auth-параметр в теле/квери.)
  async function rest(method, accessToken, params) {
    const url = `${cfg.restEndpoint.replace(/\/$/, '')}/${method}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, auth: accessToken }),
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

  // imbot.v2.File.download(botId,fileId)→downloadUrl → скачать → проверить ext/размер → сохранить в uploads.
  async function downloadAndSaveFiles(files, { botToken, botId }) {
    const jobId = uuidv4();
    const jobDir = path.join(cfg.uploadDir, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const fileEntries = [];
    for (const f of files) {
      const ext = path.extname(f.name).slice(1).toLowerCase();
      if (!cfg.allowedExtensions.includes(ext)) continue; // тип не разрешён — пропускаем
      const dl = await rest('imbot.v2.File.download', botToken, { botId, fileId: f.id });
      const downloadUrl = dl && (dl.downloadUrl || dl.DOWNLOAD_URL);
      if (!downloadUrl) continue;
      const fileResp = await fetchImpl(downloadUrl);
      const buf = Buffer.from(await fileResp.arrayBuffer());
      if (buf.length > cfg.maxBytes) continue; // больше лимита — пропускаем
      const destPath = path.join(jobDir, `${uuidv4()}.${ext}`);
      fs.writeFileSync(destPath, buf);
      fileEntries.push({ name: path.basename(f.name), path: destPath, status: 'pending', result: null, error: null });
    }
    if (fileEntries.length === 0) fs.rmSync(jobDir, { recursive: true, force: true });
    return { jobId, jobDir, fileEntries };
  }

  return { sendMessage, downloadAndSaveFiles };
}
