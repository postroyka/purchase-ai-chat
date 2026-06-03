import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || '';
const JOB_TTL_SECONDS = parseInt(process.env.JOB_TTL_HOURS || '24', 10) * 3600;

/**
 * Returns a jobs store backed by Redis if REDIS_URL is set, otherwise in-memory.
 * Both implementations expose the same async get/set interface.
 */
export function createJobsStore() {
  if (REDIS_URL) {
    return createRedisStore(REDIS_URL, JOB_TTL_SECONDS);
  }
  console.warn('[jobs-store] REDIS_URL not set — using in-memory store (data lost on restart)');
  return createMemoryStore(JOB_TTL_SECONDS);
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
        const job = JSON.parse(raw);
        // Basic schema validation — guard against corrupted or malicious Redis data
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
  };
}

function createMemoryStore(ttlSeconds) {
  const map = new Map();

  // Clean up expired entries every 10 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of map.entries()) {
      if (now - (entry.createdAt ?? 0) > ttlSeconds * 1000) {
        map.delete(id);
      }
    }
  }, 10 * 60 * 1000);

  return {
    async get(id) {
      return map.get(id) ?? null;
    },
    async set(id, job) {
      // Preserve original createdAt; set it only on first write
      const existing = map.get(id);
      map.set(id, { ...job, createdAt: existing?.createdAt ?? job.createdAt ?? Date.now() });
    },
  };
}
