import { describe, it, expect, vi } from 'vitest';
import {
  uploadFeedbackFile, buildFeedbackFilePath, sanitizePathSegment, FeedbackFileStoreError,
} from '../feedback-file-store.js';

const okFetch = (htmlUrl = 'https://github.com/acme/fb/blob/main/feedback-files/job-1/invoice.pdf') =>
  vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ content: { html_url: htmlUrl } }) }));

const base = {
  repo: 'acme/fb', token: 'tok', repoPrivate: true, jobId: 'job-1',
  fileName: 'invoice.pdf', content: Buffer.from('PDFDATA'),
};

describe('feedback-file-store (#332)', () => {
  describe('sanitizePathSegment / buildFeedbackFilePath', () => {
    it('оставляет безопасные символы, чистит опасные', () => {
      expect(sanitizePathSegment('invoice.pdf')).toBe('invoice.pdf');
      expect(sanitizePathSegment('счёт 2025.xlsx')).toMatch(/^_+2025\.xlsx$|^[_0-9.a-z]+\.xlsx$/i);
      expect(sanitizePathSegment('../../etc/passwd')).not.toContain('..');
      expect(sanitizePathSegment('a/b\\c')).not.toMatch(/[/\\]/);
      expect(sanitizePathSegment('')).toBe('file');
      expect(sanitizePathSegment('...')).toBe('file'); // только точки → fallback
    });
    it('строит путь feedback-files/<jobId>/<fileName>', () => {
      expect(buildFeedbackFilePath('job-1', 'invoice.pdf')).toBe('feedback-files/job-1/invoice.pdf');
    });
  });

  describe('приватность — fail-closed (КРИТИЧНО)', () => {
    it('repoPrivate=false → отказ NOT_PRIVATE, fetch НЕ вызывается', async () => {
      const fetchImpl = okFetch();
      await expect(uploadFeedbackFile({ ...base, repoPrivate: false, fetchImpl }))
        .rejects.toMatchObject({ code: 'NOT_PRIVATE' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('repoPrivate=null (не подтверждено) → отказ NOT_PRIVATE, fetch НЕ вызывается', async () => {
      const fetchImpl = okFetch();
      await expect(uploadFeedbackFile({ ...base, repoPrivate: null, fetchImpl }))
        .rejects.toMatchObject({ code: 'NOT_PRIVATE' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it('успешная загрузка приватного репо → { url }, PUT на contents API (путь с hash-префиксом)', async () => {
    const fetchImpl = okFetch();
    const r = await uploadFeedbackFile({ ...base, fetchImpl });
    expect(r.url).toContain('invoice.pdf');
    // #332-review #15: путь = feedback-files/<jobId>/<hash8>-<имя> (развод коллизий по содержимому).
    expect(r.path).toMatch(/^feedback-files\/job-1\/[0-9a-f]{8}-invoice\.pdf$/);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/^https:\/\/api\.github\.com\/repos\/acme\/fb\/contents\/feedback-files\/job-1\/[0-9a-f]{8}-invoice\.pdf$/);
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body).content).toBe(Buffer.from('PDFDATA').toString('base64'));
  });

  it('#332-review #15: разное содержимое с тем же именем → разные пути; то же содержимое → тот же путь', async () => {
    const f1 = okFetch(), f2 = okFetch(), f3 = okFetch();
    const p1 = (await uploadFeedbackFile({ ...base, content: Buffer.from('AAA'), fetchImpl: f1 })).path;
    const p2 = (await uploadFeedbackFile({ ...base, content: Buffer.from('BBB'), fetchImpl: f2 })).path;
    const p1again = (await uploadFeedbackFile({ ...base, content: Buffer.from('AAA'), fetchImpl: f3 })).path;
    expect(p1).not.toBe(p2);
    expect(p1).toBe(p1again);
  });

  it('#332-review #18: html_url не с github.com → UPSTREAM (защита тела issue)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ content: { html_url: 'https://evil.example/x' } }) }));
    await expect(uploadFeedbackFile({ ...base, fetchImpl })).rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('нет токена/репо → NOT_CONFIGURED', async () => {
    await expect(uploadFeedbackFile({ ...base, token: '' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(uploadFeedbackFile({ ...base, repo: '' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('кривой slug → NOT_CONFIGURED, fetch НЕ вызывается', async () => {
    const fetchImpl = okFetch();
    await expect(uploadFeedbackFile({ ...base, repo: '../../users/x', fetchImpl }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('превышение лимита размера → TOO_LARGE', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 1); // 2MB
    await expect(uploadFeedbackFile({ ...base, content: big, maxUploadMb: 1 }))
      .rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('пустой контент → NOT_CONFIGURED', async () => {
    await expect(uploadFeedbackFile({ ...base, content: Buffer.alloc(0) }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('401/403 → UPSTREAM (не ретраится)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    await expect(uploadFeedbackFile({ ...base, fetchImpl }))
      .rejects.toMatchObject({ code: 'UPSTREAM', retryable: false });
  });

  it('5xx → UPSTREAM retryable; 429 → retryable', async () => {
    for (const status of [500, 429]) {
      const fetchImpl = vi.fn(async () => ({ ok: false, status, json: async () => ({}) }));
      await expect(uploadFeedbackFile({ ...base, fetchImpl }))
        .rejects.toMatchObject({ code: 'UPSTREAM', retryable: true });
    }
  });

  it('сетевой сбой → NETWORK retryable, без утечки причины', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('connect ECONNREFUSED token=secret'); });
    const err = await uploadFeedbackFile({ ...base, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(FeedbackFileStoreError);
    expect(err.code).toBe('NETWORK');
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain('secret'); // причина проглочена
  });

  it('422 (путь уже есть) → идемпотентно достаёт существующий url через GET', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}) })           // PUT → 422
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ html_url: 'https://github.com/acme/fb/blob/main/feedback-files/job-1/invoice.pdf' }) }); // GET
    const r = await uploadFeedbackFile({ ...base, fetchImpl });
    expect(r.url).toContain('invoice.pdf');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('#332-review #11: 422 + GET без url → UPSTREAM retryable; 422 + GET бросает → тоже UPSTREAM', async () => {
    const noUrl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) }); // GET не дал url
    await expect(uploadFeedbackFile({ ...base, fetchImpl: noUrl }))
      .rejects.toMatchObject({ code: 'UPSTREAM', retryable: true });
    const getThrows = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({}) })
      .mockRejectedValueOnce(new Error('boom token=secret'));
    const err = await uploadFeedbackFile({ ...base, fetchImpl: getThrows }).catch((e) => e);
    expect(err.code).toBe('UPSTREAM');
    expect(err.message).not.toContain('secret');
  });

  it('#332-review #12: сообщения об ошибке не содержат ЗНАЧЕНИЕ токена/URL', async () => {
    const SECRET = 'ghp_SUPERSECRETVALUE123';
    for (const status of [403, 404, 500]) {
      const fetchImpl = vi.fn(async () => ({ ok: false, status, json: async () => ({}) }));
      const err = await uploadFeedbackFile({ ...base, token: SECRET, fetchImpl }).catch((e) => e);
      expect(err.message).not.toContain(SECRET);       // значение токена не утекает
      expect(err.message).not.toContain('api.github'); // URL запроса не светится
    }
  });

  it('#332-review #13: sanitizePathSegment режет длину ≤100 и не оставляет traversal', () => {
    const long = 'a'.repeat(500) + '.pdf';
    expect(sanitizePathSegment(long).length).toBeLessThanOrEqual(100);
    expect(buildFeedbackFilePath('../../x', 'y')).toMatch(/^feedback-files\//);
    expect(buildFeedbackFilePath('../../x', 'y')).not.toContain('..');
    // zero-width / управляющие символы → схлопнуты в безопасные
    expect(sanitizePathSegment('a​b c')).not.toMatch(/[​ ]/);
  });
});
