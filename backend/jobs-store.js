import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || '';
const JOB_TTL_SECONDS = parseInt(process.env.JOB_TTL_HOURS || '24', 10) * 3600;

/**
 * Returns a jobs store backed by Redis if REDIS_URL is set, otherwise in-memory.
 * Both implementations expose the same async get/set interface so callers
 * don't need to know which backend is active.
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
      const raw = await client.get(`job:${id}`);
      return raw ? JSON.parse(raw) : null;
    },
    async set(id, job) {
      await client.setex(`job:${id}`, ttlSeconds, JSON.stringify(job));
    },
  };
}

function createMemoryStore(ttlSeconds) {
  const map = new Map();

  // Clean up expired entries every hour
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of map.entries()) {
      if (now - entry.createdAt > ttlSeconds * 1000) {
        map.delete(id);
      }
    }
  }, 60 * 60 * 1000);

  return {
    async get(id) {
      return map.get(id) ?? null;
    },
    async set(id, job) {
      map.set(id, job);
    },
  };
}
