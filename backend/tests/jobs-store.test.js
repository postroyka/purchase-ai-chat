import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createJobsStore, recoverStuckJobs } from '../jobs-store.js';

// Suppress expected store noise — warn (in-memory) and error (Redis parse/schema failures)
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

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

  it('#282: markFileCancelled / cancelledFiles — множество имён на задание, с дедупом', async () => {
    await store.markFileCancelled('j', 'a.pdf');
    await store.markFileCancelled('j', 'b.pdf');
    await store.markFileCancelled('j', 'a.pdf'); // повтор — дедуп
    expect((await store.cancelledFiles('j')).sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(await store.cancelledFiles('other-job')).toEqual([]); // изоляция по заданию
  });
});

describe('recoverStuckJobs — #44 recovery «зомби»-заданий при старте', () => {
  let store;
  beforeEach(() => { store = createJobsStore({ redisUrl: '' }); });

  it('помечает processing-задание и его незавершённые файлы как error', async () => {
    await store.set('z1', {
      jobId: 'z1', status: 'processing', responsibleUserId: null, dir: '/tmp/z1', createdAt: Date.now(),
      files: [
        { name: 'a.pdf', status: 'done', result: { ok: true }, error: null },
        { name: 'b.pdf', status: 'processing', result: null, error: null },
        { name: 'c.pdf', status: 'pending', result: null, error: null },
      ],
    });
    const res = await recoverStuckJobs(store);
    expect(res.recovered).toBe(1);
    const got = await store.get('z1');
    expect(got.status).toBe('error');
    expect(got.error).toMatch(/перезапущ/i);
    expect(got.files[0].status).toBe('done');      // завершённый файл не трогаем
    expect(got.files[1].status).toBe('error');     // processing → error
    expect(got.files[2].status).toBe('error');     // pending → error
  });

  it('помечает и pending-задание (создано, но не стартовало)', async () => {
    await store.set('z2', {
      jobId: 'z2', status: 'pending', responsibleUserId: null, dir: '/tmp/z2', createdAt: Date.now(),
      files: [{ name: 'a.pdf', status: 'pending', result: null, error: null }],
    });
    const res = await recoverStuckJobs(store);
    expect(res.recovered).toBe(1);
    expect((await store.get('z2')).status).toBe('error');
  });

  it('НЕ трогает завершённые задания (done/error/cancelled)', async () => {
    for (const st of ['done', 'error', 'cancelled']) {
      await store.set(st, {
        jobId: st, status: st, responsibleUserId: null, dir: '/tmp/' + st, createdAt: Date.now(),
        files: [{ name: 'a.pdf', status: st === 'done' ? 'done' : 'error', result: null, error: null }],
      });
    }
    const res = await recoverStuckJobs(store);
    expect(res.recovered).toBe(0);
    expect((await store.get('done')).status).toBe('done');
    expect((await store.get('cancelled')).status).toBe('cancelled');
  });

  it('идемпотентна: повторный вызов уже ничего не меняет', async () => {
    await store.set('z3', {
      jobId: 'z3', status: 'processing', responsibleUserId: null, dir: '/tmp/z3', createdAt: Date.now(),
      files: [{ name: 'a.pdf', status: 'processing', result: null, error: null }],
    });
    expect((await recoverStuckJobs(store)).recovered).toBe(1);
    expect((await recoverStuckJobs(store)).recovered).toBe(0);
  });

  it('пустой стор → recovered: 0, без ошибок', async () => {
    const res = await recoverStuckJobs(store);
    expect(res).toEqual({ recovered: 0, ids: [] });
  });

  it('processing-задание без массива files не падает', async () => {
    await store.set('nofiles', {
      jobId: 'nofiles', status: 'processing', responsibleUserId: null, dir: '/tmp/nf', createdAt: Date.now(),
      files: [], // стор требует массив; проверяем устойчивость к пустому
    });
    const res = await recoverStuckJobs(store);
    expect(res.recovered).toBe(1);
    expect((await store.get('nofiles')).status).toBe('error');
  });

  it('стор без listJobIds → безопасный no-op', async () => {
    const res = await recoverStuckJobs({ get: async () => null, set: async () => {} });
    expect(res).toEqual({ recovered: 0, ids: [] });
  });

  it('сохраняет исходную причину файла/задания, если она уже задана', async () => {
    await store.set('z4', {
      jobId: 'z4', status: 'processing', responsibleUserId: null, dir: '/tmp/z4', createdAt: Date.now(),
      error: 'исходная причина',
      files: [{ name: 'a.pdf', status: 'processing', result: null, error: 'файл-причина' }],
    });
    await recoverStuckJobs(store);
    const got = await store.get('z4');
    expect(got.error).toBe('исходная причина');
    expect(got.files[0].error).toBe('файл-причина');
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
