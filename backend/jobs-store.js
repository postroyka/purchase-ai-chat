import Redis from 'ioredis';

/**
 * @param {{ redisUrl?: string, ttlHours?: number }} [config]
 * @returns {{ get(id: string): Promise<object|null>, set(id: string, job: object): Promise<void>, ping(): Promise<void> }}
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
  const client = new Redis(url, { lazyConnect: true, enableOfflineQueue: false });
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
    async ping() {
      await client.ping();
    },
  };
}

function createMemoryStore(ttlSeconds) {
  const map = new Map();

  // Evict expired entries every 10 min (lightweight TTL for in-memory/dev/test).
  // .unref() prevents this timer from keeping the Node.js process alive in tests.
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of map.entries()) {
      if (now - (entry.createdAt ?? 0) > ttlSeconds * 1000) {
        map.delete(id);
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
    async ping() {
      // in-memory store is always available
    },
  };
}
