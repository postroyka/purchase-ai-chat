import Redis from 'ioredis';

/**
 * @param {{ redisUrl?: string, ttlHours?: number }} [config]
 * @returns {{ get(id: string): Promise<object|null>, set(id: string, job: object): Promise<void>, markCancelled(id: string): Promise<void>, isCancelled(id: string): Promise<boolean>, markFileCancelled(id: string, fileName: string): Promise<void>, cancelledFiles(id: string): Promise<string[]>, ping(): Promise<void>, listJobIds(): Promise<string[]> }}
 */
export function createJobsStore(config = {}) {
  const redisUrl = config.redisUrl ?? process.env.REDIS_URL ?? '';
  const ttlSeconds = (config.ttlHours ?? parseInt(process.env.JOB_TTL_HOURS ?? '24', 10)) * 3600;

  if (redisUrl) {
    return createRedisStore(redisUrl, ttlSeconds);
  }
  console.warn('[jobs-store] REDIS_URL not set — using in-memory store (data lost on restart)');
  return createMemoryStore(ttlSeconds);
}

function createRedisStore(url, ttlSeconds) {
  const client = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, commandTimeout: 3000 });
  client.connect().catch((e) => console.error('[jobs-store] Redis connect error:', e));
  client.on('error', (e) => console.error('[jobs-store] Redis error:', e));

  return {
    async get(id) {
      try {
        const raw = await client.get(`job:${id}`);
        if (!raw) return null;
        let job;
        try {
          job = JSON.parse(raw);
        } catch (parseErr) {
          console.error(`[jobs-store] JSON.parse error for job:${id}:`, parseErr);
          return null;
        }
        if (typeof job !== 'object' || job === null) return null;
        if (typeof job.jobId !== 'string' || typeof job.status !== 'string') return null;
        if (!Array.isArray(job.files)) return null;
        return job;
      } catch (e) {
        console.error(`[jobs-store] Redis get error for job:${id}:`, e);
        throw e;
      }
    },
    async set(id, job) {
      try {
        await client.setex(`job:${id}`, ttlSeconds, JSON.stringify(job));
      } catch (e) {
        console.error(`[jobs-store] Redis set error for job:${id}:`, e);
        throw e;
      }
    },
    // Отмена импорта (#cancel) хранится ОТДЕЛЬНЫМ ключом, а не полем job: processJob многократно
    // перезаписывает весь job через set(), и флаг в самом объекте затёрся бы гонкой. Отдельный ключ
    // живёт тот же TTL и читается processJob между файлами.
    async markCancelled(id) {
      try {
        await client.setex(`job:${id}:cancel`, ttlSeconds, '1');
      } catch (e) {
        console.error(`[jobs-store] Redis markCancelled error for job:${id}:`, e);
        throw e;
      }
    },
    async isCancelled(id) {
      try {
        return (await client.get(`job:${id}:cancel`)) === '1';
      } catch (e) {
        // Best-effort: на ошибке чтения флага НЕ отменяем (продолжаем обработку), чтобы сбой Redis
        // не ронял импорт.
        console.error(`[jobs-store] Redis isCancelled error for job:${id}:`, e);
        return false;
      }
    },
    // #282: per-file отмена — пользователь убрал ОДИН ещё не начатый (pending) файл из очереди.
    // Храним именами в SET (отдельный ключ, как и отмена всего задания) — processJob пропускает
    // помеченные файлы, а GET /status показывает их 'cancelled' сразу.
    async markFileCancelled(id, fileName) {
      try {
        await client.sadd(`job:${id}:filecancel`, fileName);
        await client.expire(`job:${id}:filecancel`, ttlSeconds);
      } catch (e) {
        console.error(`[jobs-store] Redis markFileCancelled error for job:${id}:`, e);
        throw e;
      }
    },
    async cancelledFiles(id) {
      try {
        return await client.smembers(`job:${id}:filecancel`);
      } catch (e) {
        console.error(`[jobs-store] Redis cancelledFiles error for job:${id}:`, e);
        return []; // best-effort: на сбое не отменяем файлы
      }
    },
    async ping() {
      await client.ping();
    },
    // #44 (P1): перечислить id всех заданий для recovery «зомби» при старте. SCAN (не KEYS) —
    // не блокирует Redis на больших наборах; ключи отмены (`job:<id>:cancel`) пропускаем.
    async listJobIds() {
      const ids = [];
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', 'job:*', 'COUNT', 200);
        cursor = next;
        for (const key of keys) {
          if (key.endsWith(':cancel') || key.endsWith(':filecancel')) continue; // #cancel / #282 per-file
          ids.push(key.slice('job:'.length));
        }
      } while (cursor !== '0');
      return ids;
    },
  };
}

function createMemoryStore(ttlSeconds) {
  const map = new Map();
  const cancelled = new Set();
  const fileCancels = new Map(); // #282: jobId → Set<fileName>

  // Evict expired entries every 10 min (lightweight TTL for in-memory/dev/test).
  // .unref() prevents this timer from keeping the Node.js process alive in tests.
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of map.entries()) {
      if (now - (entry.createdAt ?? 0) > ttlSeconds * 1000) {
        map.delete(id);
        cancelled.delete(id);
        fileCancels.delete(id);
      }
    }
  }, 10 * 60 * 1000).unref();

  return {
    async get(id) {
      return map.get(id) ?? null;
    },
    async set(id, job) {
      const existing = map.get(id);
      // Deep-copy files array so callers cannot mutate stored entries by reference.
      map.set(id, {
        ...job,
        files: job.files.map((f) => ({ ...f })),
        createdAt: existing?.createdAt ?? job.createdAt ?? Date.now(),
      });
    },
    // Отмена импорта (#cancel) — отдельным множеством (как отдельный ключ в Redis), не полем job.
    async markCancelled(id) {
      cancelled.add(id);
    },
    async isCancelled(id) {
      return cancelled.has(id);
    },
    // #282: per-file отмена — отдельным множеством имён на задание.
    async markFileCancelled(id, fileName) {
      let set = fileCancels.get(id);
      if (!set) { set = new Set(); fileCancels.set(id, set); }
      set.add(fileName);
    },
    async cancelledFiles(id) {
      return [...(fileCancels.get(id) ?? [])];
    },
    async ping() {
      // in-memory store is always available
    },
    // #44: для symmetry с Redis-стором. У in-memory данные не переживают рестарт, поэтому
    // «зомби»-заданий после рестарта тут не бывает — но метод нужен для тестов recoverStuckJobs().
    async listJobIds() {
      return [...map.keys()];
    },
  };
}

/**
 * #44 (P1) — Recovery «зомби»-заданий при старте сервера.
 *
 * При краше/деплое контейнера задание могло остаться в статусе `processing` (или `pending`):
 * процесс, который его вёл, умер, файлы уже могли быть удалены, и клиент завис бы на бесконечном
 * «обрабатывается». При старте помечаем такие задания (и их незавершённые файлы) как `error` с
 * понятной причиной, чтобы клиент получил определённый ответ. Завершённые файлы (`done`) не трогаем.
 *
 * Best-effort и идемпотентно: ошибки чтения/записи отдельных заданий логируются и не прерывают
 * остальные. На in-memory сторе всегда no-op (нет переживающего рестарт состояния).
 *
 * @param {{ get: Function, set: Function, listJobIds: Function }} jobs
 * @param {{ reason?: string }} [opts]
 * @returns {Promise<{ recovered: number, ids: string[] }>}
 */
export async function recoverStuckJobs(jobs, opts = {}) {
  const reason = opts.reason
    ?? 'Сервер был перезапущен во время обработки — задание прервано, загрузите файл повторно';
  if (typeof jobs.listJobIds !== 'function') return { recovered: 0, ids: [] };

  let ids;
  try {
    ids = await jobs.listJobIds();
  } catch (e) {
    console.error('[jobs-store] recoverStuckJobs: listJobIds failed:', e);
    return { recovered: 0, ids: [] };
  }

  const recovered = [];
  for (const id of ids) {
    let job;
    try {
      job = await jobs.get(id);
    } catch (e) {
      console.error(`[jobs-store] recoverStuckJobs: get failed for ${id}:`, e);
      continue;
    }
    if (!job || (job.status !== 'processing' && job.status !== 'pending')) continue;

    job.status = 'error';
    if (job.error == null) job.error = reason;
    if (Array.isArray(job.files)) {
      for (const f of job.files) {
        if (f && (f.status === 'processing' || f.status === 'pending')) {
          f.status = 'error';
          if (f.error == null) f.error = reason;
        }
      }
    }
    try {
      await jobs.set(id, job);
      recovered.push(id);
    } catch (e) {
      console.error(`[jobs-store] recoverStuckJobs: set failed for ${id}:`, e);
    }
  }

  if (recovered.length) {
    console.log(`[jobs-store] #44 recovery: ${recovered.length} зависших задани(й) помечены error после рестарта: ${recovered.join(', ')}`);
  }
  return { recovered: recovered.length, ids: recovered };
}
