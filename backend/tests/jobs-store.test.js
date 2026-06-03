/**
 * Tests for the jobs store (backend/jobs-store.js).
 *
 * REDIS_URL is read into a module-scope constant when jobs-store.js is imported,
 * so each scenario sets the env var and then dynamically imports a fresh copy of
 * the module via vi.resetModules() + a cache-busting query string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

describe('createJobsStore — in-memory (no REDIS_URL)', () => {
  let store;

  beforeEach(async () => {
    vi.resetModules();
    process.env.REDIS_URL = '';
    const mod = await import('../jobs-store.js?inmem=' + Math.random());
    store = mod.createJobsStore();
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
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  afterEach(() => {
    vi.doUnmock('ioredis');
    process.env.REDIS_URL = '';
  });

  it('set serialises the job with setex under a job: key', async () => {
    const mod = await import('../jobs-store.js?redis=' + Math.random());
    const store = mod.createJobsStore();
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
    const mod = await import('../jobs-store.js?redis=' + Math.random());
    const store = mod.createJobsStore();
    const got = await store.get('r-2');
    expect(getMock).toHaveBeenCalledWith('job:r-2');
    expect(got.jobId).toBe('r-2');
  });

  it('get returns null for a missing key', async () => {
    getMock.mockResolvedValue(null);
    const mod = await import('../jobs-store.js?redis=' + Math.random());
    const store = mod.createJobsStore();
    const got = await store.get('missing');
    expect(got).toBeNull();
  });

  it('get returns null for schema-invalid stored data', async () => {
    getMock.mockResolvedValue(JSON.stringify({ jobId: 5, status: 'x' }));
    const mod = await import('../jobs-store.js?redis=' + Math.random());
    const store = mod.createJobsStore();
    const got = await store.get('bad');
    expect(got).toBeNull();
  });
});
