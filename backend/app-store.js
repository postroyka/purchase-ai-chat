// Стор «приложения» для чат-бота Битрикс24 (issue #217, дизайн docs/B24_BOT.md §2.1).
//
// Захватывает и хранит `application_token` портала, пойманный из серверного события ONAPPINSTALL
// (iframe-установка токен НЕ отдаёт — он приходит только в этом событии и в каждом последующем).
// Этим токеном /b24/bot/event проверяет ПОДЛИННОСТЬ входящих событий бота.
//
// БЕЗОПАСНОСТЬ: храним ТОЛЬКО sha256-хеш токена, а не сам токен. Для валидации нужна лишь проверка
// принадлежности (знаем ли мы такой токен), сам токен наружу никогда не отдаётся (обратные вызовы
// бота авторизуются OAuth-токеном из события, а не application_token). Дамп Redis токен не раскроет.
//
// Хранилище — Redis (NO-TTL, переживает рестарт; ключ — member_id портала) с фолбэком в память
// (dev/тесты). Best-effort: ошибка Redis не должна ронять обработчик — но валидация при сбое
// fail-closed (неизвестный токен), чтобы сбой стора не открывал эндпоинт.
import Redis from 'ioredis';
import { createHash } from 'node:crypto';

const TOKENS_KEY = 'b24app:tokens';     // SET sha256(application_token) — множество валидных токенов
const INSTALLS_KEY = 'b24app:installs'; // HASH member_id → JSON { tokenHash, domain, installedAt }

const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');

/**
 * @param {{ redisUrl?: string }} [config]
 * @returns {{
 *   recordInstall(arg: { memberId: string, applicationToken: string, domain?: string }): Promise<boolean>,
 *   removeInstall(arg: { memberId: string, applicationToken?: string }): Promise<boolean>,
 *   isKnownToken(applicationToken: string): Promise<boolean>,
 * }}
 */
export function createAppStore(config = {}) {
  const redisUrl = config.redisUrl ?? process.env.REDIS_URL ?? '';
  const backend = config.backend ?? (redisUrl ? redisBackend(redisUrl) : memoryBackend());

  // Записать/обновить установку: член портала member_id ↔ хеш его application_token. Идемпотентно;
  // при ротации токена (повтор установки с другим токеном) старый хеш убираем из множества.
  async function recordInstall({ memberId, applicationToken, domain = '' } = {}) {
    const id = String(memberId ?? '').trim();
    const token = String(applicationToken ?? '');
    if (!id || !token) return false;
    const tokenHash = sha256hex(token);
    try {
      const prev = await backend.hget(INSTALLS_KEY, id);
      if (prev) {
        try {
          const old = JSON.parse(prev);
          if (old?.tokenHash && old.tokenHash !== tokenHash) await backend.srem(TOKENS_KEY, old.tokenHash);
        } catch { /* битая запись — перезапишем ниже */ }
      }
      await backend.hset(INSTALLS_KEY, id, JSON.stringify({ tokenHash, domain: String(domain || ''), installedAt: Date.now() }));
      await backend.sadd(TOKENS_KEY, tokenHash);
      return true;
    } catch (e) {
      console.warn(`[app-store] recordInstall failed: ${e?.message ?? e}`);
      return false;
    }
  }

  // Удалить установку (ONAPPUNINSTALL). Если передан токен — снимаем ТОЛЬКО при совпадении с
  // сохранённым (чтобы подделанный uninstall без валидного токена не стёр установку).
  async function removeInstall({ memberId, applicationToken } = {}) {
    const id = String(memberId ?? '').trim();
    if (!id) return false;
    try {
      const rec = await backend.hget(INSTALLS_KEY, id);
      if (!rec) return false;
      let stored;
      try { stored = JSON.parse(rec); } catch { stored = null; }
      if (applicationToken != null && stored?.tokenHash && sha256hex(applicationToken) !== stored.tokenHash) {
        return false; // токен не совпал — не наш uninstall
      }
      if (stored?.tokenHash) await backend.srem(TOKENS_KEY, stored.tokenHash);
      await backend.hdel(INSTALLS_KEY, id);
      return true;
    } catch (e) {
      console.warn(`[app-store] removeInstall failed: ${e?.message ?? e}`);
      return false;
    }
  }

  // Знаем ли мы такой application_token (по хешу). Fail-closed при сбое Redis: лучше отвергнуть
  // событие, чем принять при недоступном сторе. Пустой токен — всегда false.
  async function isKnownToken(applicationToken) {
    const token = String(applicationToken ?? '');
    if (!token) return false;
    try {
      return Boolean(await backend.sismember(TOKENS_KEY, sha256hex(token)));
    } catch (e) {
      console.warn(`[app-store] isKnownToken failed (fail-closed): ${e?.message ?? e}`);
      return false;
    }
  }

  return { recordInstall, removeInstall, isKnownToken };
}

// ── backends ───────────────────────────────────────────────────────────────────
function redisBackend(url) {
  const client = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, commandTimeout: 3000 });
  client.connect().catch((e) => console.error('[app-store] Redis connect error:', e.message));
  client.on('error', (e) => console.error('[app-store] Redis error:', e.message));
  return {
    hget: (k, f) => client.hget(k, f),
    hset: (k, f, v) => client.hset(k, f, v),
    hdel: (k, f) => client.hdel(k, f),
    sadd: (k, m) => client.sadd(k, m),
    srem: (k, m) => client.srem(k, m),
    sismember: (k, m) => client.sismember(k, m),
  };
}

function memoryBackend() {
  const hashes = new Map(); // key → Map(field → value)
  const sets = new Map();   // key → Set(member)
  const h = (k) => { let m = hashes.get(k); if (!m) { m = new Map(); hashes.set(k, m); } return m; };
  const s = (k) => { let m = sets.get(k); if (!m) { m = new Set(); sets.set(k, m); } return m; };
  return {
    async hget(k, f) { return h(k).get(f) ?? null; },
    async hset(k, f, v) { h(k).set(f, v); },
    async hdel(k, f) { h(k).delete(f); },
    async sadd(k, m) { s(k).add(m); },
    async srem(k, m) { s(k).delete(m); },
    async sismember(k, m) { return s(k).has(m) ? 1 : 0; },
  };
}
