import Redis from 'ioredis';

/**
 * @param {{ redisUrl?: string, ttlHours?: number }} [config]
 * @returns {{ get(id: string): Promise<object|null>, set(id: string, job: object): Promise<void>, markCancelled(id: string): Promise<void>, isCancelled(id: string): Promise<boolean>, ping(): Promise<void> }}
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
    async ping() {
      await client.ping();
    },
  };
}

function createMemoryStore(ttlSeconds) {
  const map = new Map();
  const cancelled = new Set();

  // Evict expired entries every 10 min (lightweight TTL for in-memory/dev/test).
  // .unref() prevents this timer from keeping the Node.js process alive in tests.
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of map.entries()) {
      if (now - (entry.createdAt ?? 0) > ttlSeconds * 1000) {
        map.delete(id);
        cancelled.delete(id);
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
    async ping() {
      // in-memory store is always available
    },
  };
}
