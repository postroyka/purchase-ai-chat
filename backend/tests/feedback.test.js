import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../index.js';
import { createMetrics } from '../metrics.js';
import {
  stripHostileChars,
  sanitizeComment,
  normalizeKind,
  buildIssue,
  buildAgentFeedbackIssue,
  formatIssueBody,
  createGithubIssue,
  checkRepoPrivacy,
  GithubFeedbackError,
  FEEDBACK_KINDS,
} from '../feedback.js';

vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

const TOKEN = 'feedback-test-token-xyz';
const GH_TOKEN = 'ghp_feedback_secret_token_value';
const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'procure-feedback-test-'));

// Build hostile inputs from code points so the test source itself never embeds invisible chars
// (which would itself be a Trojan Source vector). 0x202e = RIGHT-TO-LEFT OVERRIDE, 0x200b = ZWSP.
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const NUL = String.fromCharCode(0x00);

function appWith(extra = {}) {
  return createApp({
    token: TOKEN,
    uploadDir: UPLOAD_DIR,
    rateLimitMax: 0,
    githubFeedbackToken: GH_TOKEN,
    githubFeedbackRepo: 'owner/repo',
    feedbackRateLimitMax: 100,
    ...extra,
  });
}

// A fetch stub that records its call and returns a fixed GitHub-shaped response.
function fakeFetch({ ok = true, status = 201, json = { html_url: 'https://github.com/owner/repo/issues/7', number: 7 } } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => {
        if (json === '__throw__') throw new SyntaxError('not json');
        return json;
      },
    };
  });
  fn.calls = calls;
  return fn;
}

// ── Module: sanitisation ──────────────────────────────────────────────────────

describe('feedback sanitisation', () => {
  it('stripHostileChars removes bidi overrides, zero-widths and C0 controls but keeps tab/newline', () => {
    expect(stripHostileChars(`a${RLO}b${ZWSP}c${NUL}d`)).toBe('abcd');
    expect(stripHostileChars('line1\nline2\tend')).toBe('line1\nline2\tend');
    expect(stripHostileChars('обычный текст')).toBe('обычный текст');
  });

  it('sanitizeComment truncates past the 5000-char cap with a marker', () => {
    const long = 'x'.repeat(20000);
    const out = sanitizeComment(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.startsWith('x'.repeat(5000))).toBe(true); // first 5000 chars preserved
    expect(out).not.toContain('x'.repeat(5001)); // capped — never the full 20000
    expect(out).toContain('[truncated to 5000 characters]');
  });

  it('normalizeKind accepts only the three canonical kinds', () => {
    expect(normalizeKind('positive')).toBe('positive');
    expect(normalizeKind('problem')).toBe('problem');
    expect(normalizeKind('suggestion')).toBe('suggestion');
    expect(normalizeKind('bug')).toBeNull();
    expect(normalizeKind('__proto__')).toBeNull();
    expect(normalizeKind(undefined)).toBeNull();
  });
});

// ── Module: issue shaping ─────────────────────────────────────────────────────

describe('buildIssue / formatIssueBody', () => {
  it('produces stable labels and a prefixed, capped title', () => {
    const { title, labels } = buildIssue({ kind: 'problem', comment: 'supplier matched wrong' });
    expect(labels).toEqual(['user-feedback', 'feedback:problem']);
    expect(title.startsWith('[Обратная связь]')).toBe(true);
    expect(title).toContain('supplier matched wrong');
    expect(title.length).toBeLessThanOrEqual(120);
  });

  it('renders the comment inside <pre><code> with HTML escaped (Markdown/HTML inert)', () => {
    const { body } = buildIssue({ kind: 'problem', comment: '<script>alert(1)</script> & <b>x</b>' });
    expect(body).toContain('<pre><code>');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;x&lt;/b&gt;');
    expect(body).not.toContain('<script>alert(1)</script>');
  });

  it('includes only the context fields that are present', () => {
    const body = formatIssueBody({
      kind: 'problem',
      comment: 'x',
      context: { jobId: 'job-1', dealId: '42', reporter: 'b24:portal.bitrix24.by' },
    });
    expect(body).toContain('Задача (jobId):** job-1');
    expect(body).toContain('Сделка:** #42');
    expect(body).toContain('Кто сообщил:** b24:portal.bitrix24.by');
    expect(body).not.toContain('User-Agent'); // not provided → no blank row
  });

  it('strips hostile chars from the title too (Trojan Source defence)', () => {
    const { title } = buildIssue({ kind: 'problem', comment: `a${RLO}b` });
    expect(title).toContain('ab');
    expect(title).not.toContain(RLO);
  });

  it('formatIssueBody strips hostile chars from the comment even when called directly (raw input)', () => {
    // formatIssueBody is exported and may be called without buildIssue's sanitizeComment, so it must
    // neutralise Trojan-Source/zero-widths on its own.
    const body = formatIssueBody({ kind: 'problem', comment: `a${RLO}b${ZWSP}c` });
    expect(body).toContain('abc');
    expect(body).not.toContain(RLO);
    expect(body).not.toContain(ZWSP);
  });
});

// ── Module: createGithubIssue ─────────────────────────────────────────────────

describe('createGithubIssue', () => {
  it('POSTs to the right repo with a Bearer token and returns url+number', async () => {
    const fetchImpl = fakeFetch();
    const res = await createGithubIssue({
      repo: 'owner/repo', token: GH_TOKEN, title: 't', body: 'b', labels: ['user-feedback'], fetchImpl,
    });
    expect(res).toEqual({ url: 'https://github.com/owner/repo/issues/7', number: 7 });
    const { url, init } = fetchImpl.calls[0];
    expect(url).toBe('https://api.github.com/repos/owner/repo/issues');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${GH_TOKEN}`);
    expect(init.headers.Accept).toBe('application/vnd.github+json');
    expect(JSON.parse(init.body)).toMatchObject({ title: 't', body: 'b', labels: ['user-feedback'] });
  });

  it('throws NOT_CONFIGURED when the token is missing', async () => {
    await expect(createGithubIssue({ repo: 'owner/repo', token: '', title: 't', body: 'b' }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('throws NOT_CONFIGURED for a malformed repo slug (no path traversal into the API)', async () => {
    const fetchImpl = fakeFetch();
    await expect(createGithubIssue({ repo: '../../users/x', token: GH_TOKEN, title: 't', body: 'b', fetchImpl }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled(); // guarded BEFORE any network call
  });

  it('maps 401/403 and 404 to UPSTREAM', async () => {
    await expect(createGithubIssue({ repo: 'owner/repo', token: GH_TOKEN, title: 't', body: 'b', fetchImpl: fakeFetch({ ok: false, status: 401 }) }))
      .rejects.toMatchObject({ code: 'UPSTREAM' });
    await expect(createGithubIssue({ repo: 'owner/repo', token: GH_TOKEN, title: 't', body: 'b', fetchImpl: fakeFetch({ ok: false, status: 404 }) }))
      .rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('maps a thrown fetch (network) to NETWORK', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED https://api.github.com ... Bearer leak?'); });
    const err = await createGithubIssue({ repo: 'owner/repo', token: GH_TOKEN, title: 't', body: 'b', fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubFeedbackError);
    expect(err.code).toBe('NETWORK');
    // SECURITY: the thrown message must never echo the token (Node fetch errors can include headers).
    expect(err.message).not.toContain(GH_TOKEN);
  });

  it('maps a non-JSON / malformed payload to UPSTREAM', async () => {
    await expect(createGithubIssue({ repo: 'owner/repo', token: GH_TOKEN, title: 't', body: 'b', fetchImpl: fakeFetch({ json: '__throw__' }) }))
      .rejects.toMatchObject({ code: 'UPSTREAM' });
    await expect(createGithubIssue({ repo: 'owner/repo', token: GH_TOKEN, title: 't', body: 'b', fetchImpl: fakeFetch({ json: { number: 1 } }) }))
      .rejects.toMatchObject({ code: 'UPSTREAM' }); // missing html_url
  });

  it('maps a non-401/404 error status (e.g. 500) to UPSTREAM (generic branch)', async () => {
    await expect(createGithubIssue({ repo: 'owner/repo', token: GH_TOKEN, title: 't', body: 'b', fetchImpl: fakeFetch({ ok: false, status: 500 }) }))
      .rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('rejects a repo slug with . or .. segments BEFORE any network call (path-traversal defence)', async () => {
    const fetchImpl = fakeFetch();
    await expect(createGithubIssue({ repo: 'owner/..', token: GH_TOKEN, title: 't', body: 'b', fetchImpl }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(createGithubIssue({ repo: './repo', token: GH_TOKEN, title: 't', body: 'b', fetchImpl }))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps an aborted (timed-out) request to NETWORK', async () => {
    // fetchImpl that never resolves but rejects when the injected AbortSignal fires — exercises the
    // real timeout→abort→NETWORK path (distinct from a synchronous throw). Small timeoutMs = fast test.
    const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const err = await createGithubIssue({ repo: 'owner/repo', token: GH_TOKEN, title: 't', body: 'b', fetchImpl, timeoutMs: 5 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GithubFeedbackError);
    expect(err.code).toBe('NETWORK');
  });
});

// ── Module: checkRepoPrivacy (#190 — warn if the feedback repo is public) ──────

describe('checkRepoPrivacy', () => {
  it('reports a PRIVATE repo as private:true and hits GET /repos/{repo}', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, json: { private: true } });
    const r = await checkRepoPrivacy({ repo: 'owner/repo', token: GH_TOKEN, fetchImpl });
    expect(r).toEqual({ ok: true, private: true, status: 200 });
    expect(fetchImpl.calls[0].url).toBe('https://api.github.com/repos/owner/repo');
    expect(fetchImpl.calls[0].init.method ?? 'GET').toBe('GET'); // a read, not a POST
  });

  it('reports a PUBLIC repo as private:false (the case the startup warning fires on)', async () => {
    const r = await checkRepoPrivacy({ repo: 'owner/repo', token: GH_TOKEN, fetchImpl: fakeFetch({ ok: true, status: 200, json: { private: false } }) });
    expect(r).toEqual({ ok: true, private: false, status: 200 });
  });

  it('returns ok:false / private:null on 404, network error, and bad JSON (never throws)', async () => {
    expect(await checkRepoPrivacy({ repo: 'owner/repo', token: GH_TOKEN, fetchImpl: fakeFetch({ ok: false, status: 404 }) }))
      .toEqual({ ok: false, private: null, status: 404 });
    const thrower = vi.fn(async () => { throw new Error(`ECONNREFUSED ... Bearer ${GH_TOKEN}`); });
    expect(await checkRepoPrivacy({ repo: 'owner/repo', token: GH_TOKEN, fetchImpl: thrower }))
      .toEqual({ ok: false, private: null, status: 0 });
    expect(await checkRepoPrivacy({ repo: 'owner/repo', token: GH_TOKEN, fetchImpl: fakeFetch({ ok: true, status: 200, json: '__throw__' }) }))
      .toEqual({ ok: false, private: null, status: 200 });
  });

  it('skips the call for a missing token or a malformed repo slug (no network)', async () => {
    const fetchImpl = fakeFetch({ json: { private: true } });
    expect(await checkRepoPrivacy({ repo: 'owner/repo', token: '', fetchImpl })).toEqual({ ok: false, private: null, status: 0 });
    expect(await checkRepoPrivacy({ repo: '../../users/x', token: GH_TOKEN, fetchImpl })).toEqual({ ok: false, private: null, status: 0 });
    expect(await checkRepoPrivacy({ repo: 'owner/..', token: GH_TOKEN, fetchImpl })).toEqual({ ok: false, private: null, status: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ── Module: agent-feedback issue builder (channel «агент») ────────────────────

describe('buildAgentFeedbackIssue', () => {
  it('builds an [Агент]-prefixed issue with tool + first line in the title and agent labels', () => {
    const { title, labels, kind } = buildAgentFeedbackIssue({
      kind: 'suggestion',
      tool: 'b24_pst_crm_find_contract',
      note: 'Нет способа выбрать договор по сумме\nвторая строка',
      context: { jobId: 'job-7', fileName: 'p.xlsx' },
    });
    expect(kind).toBe('suggestion');
    expect(title.startsWith('[Агент] ')).toBe(true);
    expect(title).toContain('b24_pst_crm_find_contract');
    expect(title).toContain('Нет способа выбрать договор по сумме');
    expect(title).not.toContain('вторая строка');            // first line only
    expect(labels).toEqual(['agent-feedback', 'feedback:suggestion']);
  });

  it('defaults an unknown kind to problem and drops a malformed tool name', () => {
    const { title, labels } = buildAgentFeedbackIssue({ kind: 'nonsense', tool: 'bad tool!', note: 'x' });
    expect(labels).toEqual(['agent-feedback', 'feedback:problem']);
    expect(title).not.toContain('bad tool!');                 // invalid tool name not echoed
  });

  it('hostile-strips the title and HTML-escapes the note + carries context', () => {
    const { title, body } = buildAgentFeedbackIssue({
      kind: 'problem',
      tool: 'b24_pst_crm_find_product',
      note: `a${RLO}b <script>alert(1)</script> ${ZWSP}c`,
      context: { jobId: 'job-9', fileName: 'scan.pdf' },
    });
    expect(title).not.toContain(RLO);
    expect(body).not.toContain(RLO);
    expect(body).not.toContain(ZWSP);
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('job-9');
    expect(body).toContain('scan.pdf');
  });
});

// ── Route: GET /feedback/config ───────────────────────────────────────────────

describe('GET /feedback/config', () => {
  it('reports enabled:true when a token is configured (open, no auth)', async () => {
    const res = await request(appWith()).get('/feedback/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it('reports enabled:false when no token is configured', async () => {
    const res = await request(appWith({ githubFeedbackToken: '' })).get('/feedback/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });
});

// ── Route: POST /feedback ─────────────────────────────────────────────────────

describe('POST /feedback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(appWith()).post('/feedback').send({ kind: 'positive', comment: 'ok' });
    expect(res.status).toBe(401);
  });

  it('creates an issue (Bearer auth) and returns the url + number', async () => {
    const fetchImpl = fakeFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const res = await request(appWith())
      .post('/feedback')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'problem', comment: 'article not found but exists', context: { jobId: 'job-abc', dealId: '99' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, url: 'https://github.com/owner/repo/issues/7', number: 7 });

    // Verify the GitHub call targeted the configured repo and carried the context in the body.
    expect(fetchImpl.calls[0].url).toBe('https://api.github.com/repos/owner/repo/issues');
    const payload = JSON.parse(fetchImpl.calls[0].init.body);
    expect(payload.labels).toEqual(['user-feedback', 'feedback:problem']);
    expect(payload.body).toContain('job-abc');
    expect(payload.body).toContain('#99');
    expect(payload.body).toContain('api-token'); // reporter for a Bearer caller
  });

  it('accepts an app session cookie + X-PAI-Auth (in-browser UI)', async () => {
    vi.stubGlobal('fetch', fakeFetch());
    const app = appWith({ basicAuthUser: 'op', basicAuthPass: 'secret-pass' });
    const cookie = (await request(app).post('/login').set('X-PAI-Auth', '1')
      .send({ username: 'op', password: 'secret-pass' })).headers['set-cookie'];
    const res = await request(app).post('/feedback').set('Cookie', cookie).set('X-PAI-Auth', '1')
      .send({ kind: 'positive', comment: 'всё отлично' });
    expect(res.status).toBe(201);
  });

  it('returns 400 for an invalid kind and for an empty comment', async () => {
    vi.stubGlobal('fetch', fakeFetch());
    const bad = await request(appWith()).post('/feedback').set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'bug', comment: 'x' });
    expect(bad.status).toBe(400);
    const empty = await request(appWith()).post('/feedback').set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'problem', comment: '   ' });
    expect(empty.status).toBe(400);
  });

  it('returns 503 when the feedback channel is not configured', async () => {
    const res = await request(appWith({ githubFeedbackToken: '' })).post('/feedback')
      .set('Authorization', `Bearer ${TOKEN}`).send({ kind: 'positive', comment: 'ok' });
    expect(res.status).toBe(503);
  });

  it('maps a GitHub failure to 502 WITHOUT leaking the feedback token in the response', async () => {
    vi.stubGlobal('fetch', fakeFetch({ ok: false, status: 401 }));
    const res = await request(appWith()).post('/feedback').set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'problem', comment: 'boom' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(GH_TOKEN);
  });

  it('drops malformed context fields but still creates the issue (201)', async () => {
    const fetchImpl = fakeFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const res = await request(appWith())
      .post('/feedback')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'problem', comment: 'x', context: { jobId: 'bad id!', dealId: 'NaN', fileName: 'f'.repeat(500) } });
    expect(res.status).toBe(201);
    const payload = JSON.parse(fetchImpl.calls[0].init.body);
    // Bad jobId/dealId fail the charset regexes → dropped → their context lines are absent entirely.
    expect(payload.body).not.toContain('bad id!');
    expect(payload.body).not.toContain('Задача (jobId)');
    expect(payload.body).not.toContain('Сделка');
    // fileName is kept but capped at 300 chars (not the full 500).
    expect(payload.body).toContain('f'.repeat(300));
    expect(payload.body).not.toContain('f'.repeat(301));
  });

  it('records the cookie session sub as the issue reporter (drives the real verify→sub path)', async () => {
    const fetchImpl = fakeFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const app = appWith({ basicAuthUser: 'jane-operator', basicAuthPass: 'secret-pass' });
    const cookie = (await request(app).post('/login').set('X-PAI-Auth', '1')
      .send({ username: 'jane-operator', password: 'secret-pass' })).headers['set-cookie'];
    const res = await request(app).post('/feedback').set('Cookie', cookie).set('X-PAI-Auth', '1')
      .send({ kind: 'positive', comment: 'ok' });
    expect(res.status).toBe(201);
    const payload = JSON.parse(fetchImpl.calls[0].init.body);
    expect(payload.body).toContain('jane-operator'); // «Кто сообщил: jane-operator»
  });

  it('a FAILED GitHub attempt still consumes a rate-limit slot (discourages retry loops)', async () => {
    vi.stubGlobal('fetch', fakeFetch({ ok: false, status: 500 })); // every GitHub call fails → 502
    const app = appWith({ feedbackRateLimitMax: 1 });
    const first = await request(app).post('/feedback').set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'problem', comment: 'one' });
    expect(first.status).toBe(502); // GitHub failed
    const second = await request(app).post('/feedback').set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'problem', comment: 'two' });
    expect(second.status).toBe(429); // the failed first attempt already burned the only slot
  });

  it('enforces the per-client rate limit (default counts attempts)', async () => {
    vi.stubGlobal('fetch', fakeFetch());
    const app = appWith({ feedbackRateLimitMax: 1 });
    const first = await request(app).post('/feedback').set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'positive', comment: 'one' });
    expect(first.status).toBe(201);
    const second = await request(app).post('/feedback').set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'positive', comment: 'two' });
    expect(second.status).toBe(429);
  });

  it('counts a successful user submission in /metrics (recordFeedback source=user)', async () => {
    vi.stubGlobal('fetch', fakeFetch());
    const metrics = createMetrics({ redisUrl: '' });
    const spy = vi.spyOn(metrics, 'recordFeedback');
    const app = appWith({ metrics });
    const res = await request(app).post('/feedback').set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'problem', comment: 'article wrong' });
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledWith({ source: 'user', kind: 'problem' });
  });

  it('does NOT count feedback on a 400 or a 502 (counts successful submits, not attempts)', async () => {
    const metrics = createMetrics({ redisUrl: '' });
    const spy = vi.spyOn(metrics, 'recordFeedback');
    // 400 — bad kind, rejected before the GitHub call
    const bad = await request(appWith({ metrics })).post('/feedback').set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'nope', comment: 'x' });
    expect(bad.status).toBe(400);
    // 502 — GitHub fails, count line sits after createGithubIssue so it never runs
    vi.stubGlobal('fetch', fakeFetch({ ok: false, status: 500 }));
    const fail = await request(appWith({ metrics })).post('/feedback').set('Authorization', `Bearer ${TOKEN}`)
      .send({ kind: 'problem', comment: 'x' });
    expect(fail.status).toBe(502);
    expect(spy).not.toHaveBeenCalled();
  });
});

// Keep FEEDBACK_KINDS in lockstep with the UI widget's options.
describe('FEEDBACK_KINDS contract', () => {
  it('exposes exactly positive/problem/suggestion', () => {
    expect(Object.keys(FEEDBACK_KINDS).sort()).toEqual(['positive', 'problem', 'suggestion']);
  });
});
