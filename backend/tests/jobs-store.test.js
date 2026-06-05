import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createJobsStore } from '../jobs-store.js';

// Suppress expected in-memory store warnings — not a test concern
vi.spyOn(console, 'warn').mockImplementation(() => {});

function makeJob(id) {
  return {
    jobId: id,
    status: 'pending',
    responsibleUserId: null,
    files: [{ name: 'a.pdf', status: 'pending', result: null, error: null }],
    dir: '/tmp/' + id,
    createdAt: Date.now(),
  };
}

describe('createJobsStore — in-memory (no redisUrl)', () => {
  let store;

  beforeEach(() => {
    store = createJobsStore({ redisUrl: '' });
  });

  it('set then get returns the stored job', async () => {
    const job = makeJob('job-1');
    await store.set('job-1', job);
    const got = await store.get('job-1');
    expect(got).toBeTruthy();
    expect(got.jobId).toBe('job-1');
    expect(got.status).toBe('pending');
    expect(got.files).toHaveLength(1);
  });

  it('get of a non-existent id returns null', async () => {
    const got = await store.get('does-not-exist');
    expect(got).toBeNull();
  });

  // createdAt must be fixed at first write — subsequent set() calls must not
  // update it, otherwise repeated status updates would reset the TTL clock.
  it('preserves original createdAt across updates', async () => {
    const job = makeJob('job-2');
    job.createdAt = 1000;
    await store.set('job-2', job);
    await store.set('job-2', { ...job, status: 'processing', createdAt: 9999 });
    const got = await store.get('job-2');
    expect(got.status).toBe('processing');
    expect(got.createdAt).toBe(1000);
  });
});

describe('createJobsStore — Redis path (mocked ioredis)', () => {
  let setexMock;
  let getMock;

  beforeEach(() => {
    setexMock = vi.fn().mockResolvedValue('OK');
    getMock = vi.fn();
    vi.resetModules();
    vi.doMock('ioredis', () => {
      class FakeRedis {
        constructor() {}
        connect() { return Promise.resolve(); }
        on() {}
        get(...args) { return getMock(...args); }
        setex(...args) { return setexMock(...args); }
      }
      return { default: FakeRedis };
    });
  });

  afterEach(() => {
    vi.doUnmock('ioredis');
  });

  async function makeRedisStore() {
    const mod = await import('../jobs-store.js?mock=' + Math.random());
    return mod.createJobsStore({ redisUrl: 'redis://localhost:6379' });
  }

  it('set serialises the job with setex under a job: key', async () => {
    const store = await makeRedisStore();
    const job = makeJob('r-1');
    await store.set('r-1', job);
    expect(setexMock).toHaveBeenCalledTimes(1);
    const [key, ttl, payload] = setexMock.mock.calls[0];
    expect(key).toBe('job:r-1');
    expect(typeof ttl).toBe('number');
    expect(JSON.parse(payload).jobId).toBe('r-1');
  });

  it('get parses and validates a well-formed job', async () => {
    getMock.mockResolvedValue(JSON.stringify(makeJob('r-2')));
    const store = await makeRedisStore();
    const got = await store.get('r-2');
    expect(getMock).toHaveBeenCalledWith('job:r-2');
    expect(got.jobId).toBe('r-2');
  });

  it('get returns null for a missing key', async () => {
    getMock.mockResolvedValue(null);
    const store = await makeRedisStore();
    const got = await store.get('missing');
    expect(got).toBeNull();
  });

  it('get returns null (does not throw) when Redis returns invalid JSON', async () => {
    getMock.mockResolvedValue('not valid json');
    const store = await makeRedisStore();
    const got = await store.get('corrupted');
    expect(got).toBeNull();
  });

  it('get returns null for schema-invalid stored data', async () => {
    getMock.mockResolvedValue(JSON.stringify({ jobId: 5, status: 'x' }));
    const store = await makeRedisStore();
    const got = await store.get('bad');
    expect(got).toBeNull();
  });
});
