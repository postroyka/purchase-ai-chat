import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createSessionAuth, parseCookies } from '../auth.js';

// Unit tests for the dependency-free signed-cookie session module (backend/auth.js). These never
// touch the network: appInfo is injected as a spy so the SSRF allowlist can be asserted to gate
// the call BEFORE any fetch. A controllable clock (now) exercises issue/verify expiry.

const SECRET = 'unit-test-secret-key';
const USER = 'op';
const PASS = 'super-secret';

// Build an auth instance with a movable clock. clock.t is the "current" epoch ms.
function makeAuth(over = {}) {
  const clock = { t: 1_700_000_000_000 };
  const auth = createSessionAuth({
    secret: SECRET,
    user: USER,
    pass: PASS,
    ttlMs: 1000 * 60, // 1 minute
    secure: false,
    portalDomains: ['*.bitrix24.by', 'portal.example.com'],
    now: () => clock.t,
    ...over,
  });
  return { auth, clock };
}

// Minimal Express-ish res double capturing status / json / cookie / end.
function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { this.ended = true; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  };
}

const setCookieOf = (res) => res.headers['set-cookie'] ?? '';

describe('parseCookies', () => {
  it('parses a multi-cookie header into an object', () => {
    expect(parseCookies('a=1; b=2; pai_sess=xyz.abc')).toEqual({ a: '1', b: '2', pai_sess: 'xyz.abc' });
  });

  it('handles values containing "=" (splits on first =)', () => {
    expect(parseCookies('t=ab=cd==')).toEqual({ t: 'ab=cd==' });
  });

  it('returns {} for missing / empty / garbage headers', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('novalue')).toEqual({});
  });

  it('first occurrence of a duplicate name wins (no attacker override)', () => {
    expect(parseCookies('pai_sess=good; pai_sess=evil').pai_sess).toBe('good');
  });
});

describe('issue / verify round-trip', () => {
  it('verifies a freshly issued token and returns its payload', () => {
    const { auth, clock } = makeAuth();
    const token = auth.issue('alice');
    const payload = auth.verify(token);
    expect(payload).toMatchObject({ sub: 'alice', iat: clock.t, exp: clock.t + 60_000 });
  });

  it('rejects an expired token (now > exp)', () => {
    const { auth, clock } = makeAuth();
    const token = auth.issue('bob');
    expect(auth.verify(token)).not.toBeNull(); // valid now
    clock.t += 60_001; // advance just past the 60s TTL
    expect(auth.verify(token)).toBeNull();
  });

  it('rejects a token with a tampered HMAC signature', () => {
    const { auth } = makeAuth();
    const token = auth.issue('carol');
    const [body] = token.split('.');
    const forged = `${body}.${'A'.repeat(43)}`; // wrong signature
    expect(auth.verify(forged)).toBeNull();
  });

  it('rejects a token whose payload was tampered (signature no longer matches)', () => {
    const { auth } = makeAuth();
    const token = auth.issue('dave');
    const [, sig] = token.split('.');
    const evilBody = Buffer.from(JSON.stringify({ sub: 'admin', iat: 0, exp: 9e15 })).toString('base64url');
    expect(auth.verify(`${evilBody}.${sig}`)).toBeNull();
  });

  it('rejects garbage / structurally-invalid tokens', () => {
    const { auth } = makeAuth();
    for (const t of ['', 'noseparator', 'a.b.c', '.', 'x.', '.y', undefined, null, 123]) {
      expect(auth.verify(t)).toBeNull();
    }
  });

  it('a token signed with a different secret does not verify', () => {
    const { auth: a1 } = makeAuth({ secret: 'secret-1' });
    const { auth: a2 } = makeAuth({ secret: 'secret-2' });
    expect(a2.verify(a1.issue('eve'))).toBeNull();
  });
});

describe('hasValidSession / requireSession / csrfOk', () => {
  it('hasValidSession reads the pai_sess cookie from the request', () => {
    const { auth } = makeAuth();
    const token = auth.issue('u');
    expect(auth.hasValidSession({ headers: { cookie: `pai_sess=${token}` } })).toBe(true);
    expect(auth.requireSession({ headers: { cookie: `pai_sess=${token}` } })).toBe(true);
    expect(auth.hasValidSession({ headers: { cookie: 'pai_sess=garbage' } })).toBe(false);
    expect(auth.hasValidSession({ headers: {} })).toBe(false);
  });

  it('csrfOk requires a non-empty x-pai-auth header', () => {
    const { auth } = makeAuth();
    expect(auth.csrfOk({ headers: { 'x-pai-auth': '1' } })).toBe(true);
    expect(auth.csrfOk({ headers: { 'x-pai-auth': '' } })).toBe(false);
    expect(auth.csrfOk({ headers: {} })).toBe(false);
  });
});

describe('loginHandler', () => {
  it('sets a session cookie and returns 200 on valid credentials', () => {
    const { auth } = makeAuth();
    const res = mockRes();
    auth.loginHandler({ body: { username: USER, password: PASS } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const cookie = setCookieOf(res);
    expect(cookie).toMatch(/pai_sess=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/); // secure:false → Lax, no Secure
    expect(cookie).not.toMatch(/Secure/);
  });

  it('returns 401 (no cookie) on a wrong password', () => {
    const { auth } = makeAuth();
    const res = mockRes();
    auth.loginHandler({ body: { username: USER, password: 'nope' } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect(setCookieOf(res)).toBe('');
  });

  it('returns 401 on a wrong username', () => {
    const { auth } = makeAuth();
    const res = mockRes();
    auth.loginHandler({ body: { username: 'intruder', password: PASS } }, res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 503 when no password is configured (service not configured)', () => {
    const { auth } = makeAuth({ pass: '' });
    const res = mockRes();
    auth.loginHandler({ body: { username: USER, password: PASS } }, res);
    expect(res.statusCode).toBe(503);
  });

  it('sets Secure + SameSite=None when secure:true (prod/HTTPS)', () => {
    const { auth } = makeAuth({ secure: true });
    const res = mockRes();
    auth.loginHandler({ body: { username: USER, password: PASS } }, res);
    const cookie = setCookieOf(res);
    expect(cookie).toMatch(/SameSite=None/);
    expect(cookie).toMatch(/Secure/);
  });
});

describe('sessionHandler / logoutHandler', () => {
  it('sessionHandler reports authenticated:false without a cookie, true with one', () => {
    const { auth } = makeAuth();
    const r1 = mockRes();
    auth.sessionHandler({ headers: {} }, r1);
    expect(r1.body).toEqual({ authenticated: false });

    const token = auth.issue('u');
    const r2 = mockRes();
    auth.sessionHandler({ headers: { cookie: `pai_sess=${token}` } }, r2);
    expect(r2.body).toEqual({ authenticated: true });
  });

  it('logoutHandler (with CSRF header) clears the cookie (Max-Age=0, Path=/) and returns 204', () => {
    const { auth } = makeAuth();
    const res = mockRes();
    auth.logoutHandler({ headers: { 'x-pai-auth': '1' } }, res);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(setCookieOf(res)).toMatch(/pai_sess=;.*Max-Age=0/);
    expect(setCookieOf(res)).toMatch(/Path=\//); // matching Path is required for the browser to drop it
  });

  it('logoutHandler rejects without the CSRF header (403) — blocks forced cross-site logout', () => {
    const { auth } = makeAuth();
    const res = mockRes();
    auth.logoutHandler({ headers: {} }, res);
    expect(res.statusCode).toBe(403);
  });
});

describe('b24SessionHandler — SSRF allowlist + app.info', () => {
  it('REJECTS a non-allowlisted domain WITHOUT calling appInfo (the SSRF sink)', async () => {
    const appInfo = vi.fn(async () => true);
    const { auth } = makeAuth({ appInfo });
    const res = mockRes();
    await auth.b24SessionHandler({ body: { domain: 'evil.attacker.com', authId: 'x' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'domain not allowed' });
    expect(appInfo).not.toHaveBeenCalled(); // critical: no outbound request was attempted
    expect(setCookieOf(res)).toBe('');
  });

  it('rejects an internal/SSRF target (e.g. localhost / 169.254.x) without calling appInfo', async () => {
    const appInfo = vi.fn(async () => true);
    const { auth } = makeAuth({ appInfo });
    for (const domain of ['localhost', '127.0.0.1', '169.254.169.254', 'http://127.0.0.1:6379/']) {
      const res = mockRes();
      await auth.b24SessionHandler({ body: { domain, authId: 'x' } }, res);
      expect(res.statusCode).toBe(400);
    }
    expect(appInfo).not.toHaveBeenCalled();
  });

  it('accepts a wildcard subdomain match and validates via appInfo', async () => {
    const appInfo = vi.fn(async () => true);
    const { auth } = makeAuth({ appInfo });
    const res = mockRes();
    await auth.b24SessionHandler({ body: { domain: 'acme.bitrix24.by', authId: 'AUTH123' } }, res);
    expect(appInfo).toHaveBeenCalledWith('acme.bitrix24.by', 'AUTH123');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(setCookieOf(res)).toMatch(/pai_sess=/);
  });

  it('normalises a full origin URL to the bare host before matching', async () => {
    const appInfo = vi.fn(async () => true);
    const { auth } = makeAuth({ appInfo });
    const res = mockRes();
    await auth.b24SessionHandler({ body: { domain: 'https://acme.bitrix24.by/path?x=1', authId: 'A' } }, res);
    expect(appInfo).toHaveBeenCalledWith('acme.bitrix24.by', 'A');
    expect(res.statusCode).toBe(200);
  });

  it('rejects a multi-label subdomain against a single-label wildcard', async () => {
    const appInfo = vi.fn(async () => true);
    const { auth } = makeAuth({ appInfo });
    const res = mockRes();
    await auth.b24SessionHandler({ body: { domain: 'a.b.bitrix24.by', authId: 'A' } }, res);
    expect(res.statusCode).toBe(400);
    expect(appInfo).not.toHaveBeenCalled();
  });

  it('accepts an exact (non-wildcard) allowlist entry', async () => {
    const appInfo = vi.fn(async () => true);
    const { auth } = makeAuth({ appInfo });
    const res = mockRes();
    await auth.b24SessionHandler({ body: { domain: 'portal.example.com', authId: 'A' } }, res);
    expect(res.statusCode).toBe(200);
  });

  it('returns 401 (no cookie) when appInfo reports the portal auth is invalid', async () => {
    const appInfo = vi.fn(async () => false);
    const { auth } = makeAuth({ appInfo });
    const res = mockRes();
    await auth.b24SessionHandler({ body: { domain: 'acme.bitrix24.by', authId: 'bad' } }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'b24 auth failed' });
    expect(setCookieOf(res)).toBe('');
  });

  it('returns 401 when appInfo throws (network/abort) — never leaks the error', async () => {
    const appInfo = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const { auth } = makeAuth({ appInfo });
    const res = mockRes();
    await auth.b24SessionHandler({ body: { domain: 'acme.bitrix24.by', authId: 'A' } }, res);
    expect(res.statusCode).toBe(401);
  });
});

// ── New tests added for PR #173 ──────────────────────────────────────────────

describe('verify() — expiry boundary (injectable clock)', () => {
  it('at now===exp the token is still valid; at now===exp+1 it is rejected', () => {
    const { auth, clock } = makeAuth();
    const token = auth.issue('grace');
    // issue() uses clock.t as iat, exp = iat + ttlMs (60_000 ms)
    const exp = clock.t + 60_000;

    // Exactly at the expiry moment: now() > exp is false (60_000 > 60_000 is false) → valid.
    clock.t = exp;
    expect(auth.verify(token)).not.toBeNull();

    // One millisecond past expiry: now() > exp is true → invalid.
    clock.t = exp + 1;
    expect(auth.verify(token)).toBeNull();
  });
});

describe('verify() — rejects tokens without `sub`', () => {
  it('a structurally-valid signed token with no sub field returns null', () => {
    // Build the token manually with the same SECRET as makeAuth() uses.
    const b64url = (buf) => Buffer.from(buf).toString('base64url');
    const now = 1_700_000_000_000;
    const bodyStr = JSON.stringify({ iat: now, exp: now + 9_999_999_999 }); // far future, no `sub`
    const sig = createHmac('sha256', SECRET).update(bodyStr).digest();
    const token = `${b64url(bodyStr)}.${b64url(sig)}`;

    const { auth } = makeAuth();
    expect(auth.verify(token)).toBeNull();
  });

  it('a token whose sub is an empty string returns null', () => {
    const b64url = (buf) => Buffer.from(buf).toString('base64url');
    const now = 1_700_000_000_000;
    const bodyStr = JSON.stringify({ sub: '', iat: now, exp: now + 9_999_999_999 });
    const sig = createHmac('sha256', SECRET).update(bodyStr).digest();
    const token = `${b64url(bodyStr)}.${b64url(sig)}`;

    const { auth } = makeAuth();
    expect(auth.verify(token)).toBeNull();
  });
});

describe('b24SessionHandler — authId edge cases', () => {
  it('empty authId → 401 WITHOUT calling appInfo', async () => {
    const appInfo = vi.fn(async () => true);
    const { auth } = makeAuth({ appInfo });

    // empty string
    const r1 = mockRes();
    await auth.b24SessionHandler({ body: { domain: 'acme.bitrix24.by', authId: '' } }, r1);
    expect(r1.statusCode).toBe(401);
    expect(appInfo).not.toHaveBeenCalled();

    // missing authId (body has no authId key)
    const r2 = mockRes();
    await auth.b24SessionHandler({ body: { domain: 'acme.bitrix24.by' } }, r2);
    expect(r2.statusCode).toBe(401);
    expect(appInfo).not.toHaveBeenCalled();
  });

  it('authId longer than 4096 chars → 401 WITHOUT calling appInfo', async () => {
    const appInfo = vi.fn(async () => true);
    const { auth } = makeAuth({ appInfo });
    const res = mockRes();
    await auth.b24SessionHandler(
      { body: { domain: 'acme.bitrix24.by', authId: 'x'.repeat(4097) } },
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(appInfo).not.toHaveBeenCalled();
  });
});

describe('b24SessionHandler — apex domain vs wildcard allowlist', () => {
  it("bare apex 'bitrix24.by' against allowlist ['*.bitrix24.by'] → 400 WITHOUT calling appInfo", async () => {
    const appInfo = vi.fn(async () => true);
    // Build an auth whose allowlist is ONLY the wildcard, not the apex itself.
    const { auth } = makeAuth({ appInfo, portalDomains: ['*.bitrix24.by'] });
    const res = mockRes();
    await auth.b24SessionHandler({ body: { domain: 'bitrix24.by', authId: 'anyId' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'domain not allowed' });
    expect(appInfo).not.toHaveBeenCalled();
  });
});

describe('parseCookies — whitespace around keys and values', () => {
  it('trims spaces around keys and values (e.g. " pai_sess = x ")', () => {
    const result = parseCookies(' pai_sess = x ; other = y ');
    expect(result.pai_sess).toBe('x');
    expect(result.other).toBe('y');
  });
});
