import { createHmac } from 'node:crypto';
import { safeCompare } from './utils.js';

// App-level signed-cookie session auth (replaces HTTP Basic for the served UI).
//
// WHY THIS EXISTS: the app is a Bitrix24 LOCAL APP — it loads inside the portal's cross-site
// iframe. HTTP Basic is fundamentally incompatible with that model: the B24 iframe (and B24's
// own install/handler requests) cannot carry Basic credentials, so a Basic gate on the UI → 401
// → the app never loads or installs inside the portal. Instead we serve the UI openly and gate
// the *API* with an app session established two ways:
//   1. Standalone (outside B24): a login form posting the existing PUBLIC_PAGE_BASIC_AUTH_*
//      credentials to /login.
//   2. Inside B24: the frame proves the portal is genuine via one app.info call (/session/b24).
// Both set a signed, HttpOnly cookie. Dependency-free by design (node:crypto only) so the prod
// image keeps building with `pnpm install --frozen-lockfile --prod`.

const COOKIE_NAME = 'pai_sess';

// base64url helpers (RFC 4648 §5) — Node's Buffer supports 'base64url' natively.
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

// safeCompare (constant-time, no length leak) is shared via ./utils.js — used here for BOTH the HMAC
// signature compare and the user/pass compare — so it never drifts from the Bearer check in index.js.

// Parse a Cookie header into a plain object. No dependency: split on ';', then on the FIRST '='
// (cookie values may themselves contain '='). Missing/garbled header → {}.
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const v = part.slice(eq + 1).trim();
    // First occurrence wins (a duplicate cookie name must not let an attacker override).
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/**
 * Build the session-auth handlers + helpers. All config is injectable so the unit tests can
 * exercise every branch without process.env or real network calls.
 *
 * @param {{
 *   secret: string,            // HMAC signing key (derived in index.js when SESSION_SECRET unset)
 *   user?: string,             // standalone login username (PUBLIC_PAGE_BASIC_AUTH_USER)
 *   pass?: string,             // standalone login password (PUBLIC_PAGE_BASIC_AUTH_PASS)
 *   ttlMs?: number,            // session lifetime; default 12h
 *   secure?: boolean,          // append `; Secure` to the cookie (prod/HTTPS only)
 *   portalDomains?: string[],  // app.info SSRF allowlist (hostnames; '*.bitrix24.by' wildcards ok)
 *   appInfo?: (domain: string, authId: string) => Promise<boolean>, // injectable for tests
 *   now?: () => number,        // injectable clock for expiry tests
 * }} config
 */
export function createSessionAuth(config = {}) {
  const secret = config.secret ?? '';
  const user = config.user ?? '';
  const pass = config.pass ?? '';
  const ttlMs = config.ttlMs ?? 12 * 60 * 60 * 1000;
  const secure = config.secure === true;
  const portalDomains = Array.isArray(config.portalDomains) ? config.portalDomains : [];
  const now = config.now ?? Date.now;
  const appInfo = config.appInfo ?? defaultAppInfo;

  // The session is "configured" only when both a secret and a password exist. With no password
  // there is nothing to authenticate against, so loginHandler returns 503 (mirrors the existing
  // "service not configured" behaviour rather than silently accepting anyone).
  const configured = () => Boolean(secret) && Boolean(pass);

  // ── Token: base64url(body) + "." + base64url(HMAC_SHA256(body, secret)) ───────────────────
  // body = JSON.stringify({ sub, iat, exp }). The signature covers the EXACT body bytes, so any
  // tamper (including re-ordered/whitespace-different JSON) changes the body string and fails.

  function sign(bodyStr) {
    return createHmac('sha256', secret).update(bodyStr).digest();
  }

  function issue(sub) {
    const iat = now();
    const exp = iat + ttlMs;
    const bodyStr = JSON.stringify({ sub, iat, exp });
    const sig = sign(bodyStr);
    return `${b64url(bodyStr)}.${b64url(sig)}`;
  }

  // Returns the decoded payload if the HMAC is valid (constant-time) AND not expired; else null.
  // Tampered / expired / structurally-garbage tokens all return null.
  function verify(token) {
    if (typeof token !== 'string' || token === '') return null;
    const dot = token.indexOf('.');
    if (dot < 0 || token.indexOf('.', dot + 1) !== -1) return null; // exactly one '.'
    const bodyB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    if (!bodyB64 || !sigB64) return null;

    let bodyStr;
    try {
      bodyStr = fromB64url(bodyB64).toString('utf8');
    } catch {
      return null;
    }
    // Compare the CANONICAL base64url signature STRINGS (ASCII), not the raw HMAC bytes: safeCompare
    // hashes both sides, and feeding it binary Buffers would round-trip them through utf8 (lossy for
    // non-UTF8 bytes). Our issue() always emits canonical unpadded base64url, so a legit token's
    // sigB64 equals b64url(expected); a forgery can't reproduce it without the secret. Constant-time.
    const expectedB64 = b64url(sign(bodyStr));
    if (!safeCompare(sigB64, expectedB64)) return null;

    let payload;
    try {
      payload = JSON.parse(bodyStr);
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || now() > payload.exp) return null;
    // Reject a token without a string `sub`: requireSession only checks validity, so a malformed
    // payload (only reachable via a code change to issue()) must never count as an authenticated user.
    if (typeof payload.sub !== 'string' || payload.sub === '') return null;
    return payload;
  }

  // ── Cookie ────────────────────────────────────────────────────────────────────────────────
  // SameSite=None is REQUIRED so the cookie is sent inside the cross-site Bitrix24 iframe (a
  // SameSite=Lax/Strict cookie is withheld on cross-site iframe requests). Browsers reject
  // `SameSite=None` WITHOUT `Secure`, so in production (HTTPS) we always set both. Over plain
  // HTTP (dev/tests) `secure` is false and `None` would be invalid → fall back to `SameSite=Lax`
  // (good enough for same-origin dev; cross-site framing only matters over HTTPS anyway).
  function cookieHeader(token, maxAgeSec) {
    const sameSite = secure ? 'None' : 'Lax';
    const attrs = [
      `${COOKIE_NAME}=${token}`,
      'HttpOnly',
      'Path=/',
      `Max-Age=${maxAgeSec}`,
      `SameSite=${sameSite}`,
    ];
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
  }

  function setSessionCookie(res, sub) {
    res.setHeader('Set-Cookie', cookieHeader(issue(sub), Math.floor(ttlMs / 1000)));
  }

  function clearSessionCookie(res) {
    // Max-Age=0 expires the cookie immediately; the empty value + same attributes ensure the
    // browser matches and removes the original cookie.
    res.setHeader('Set-Cookie', cookieHeader('', 0));
  }

  // ── Request-side helpers ───────────────────────────────────────────────────────────────────

  function hasValidSession(req) {
    const cookies = parseCookies(req.headers?.cookie);
    return verify(cookies[COOKIE_NAME]) !== null;
  }

  // requireSession is the boolean gate used by the API auth path in index.js.
  const requireSession = (req) => hasValidSession(req);

  // CSRF defence: the session cookie is SameSite=None, so it IS sent on cross-site requests
  // (e.g. a malicious page POSTing to /upload). We additionally require a custom header that a
  // cross-site page cannot set without a CORS preflight we never grant — so a forged cross-site
  // request carrying the cookie still fails. Any non-empty x-pai-auth header satisfies this.
  function csrfOk(req) {
    const h = req.headers?.['x-pai-auth'];
    return typeof h === 'string' && h.length > 0;
  }

  // ── Handlers (Express (req, res)) ──────────────────────────────────────────────────────────

  // POST /login — { username, password } (JSON; caller mounts express.json). Constant-time
  // checks BOTH fields with no short-circuit so timing never reveals which half matched.
  function loginHandler(req, res) {
    if (!configured()) {
      return res.status(503).json({ error: 'Service not configured: PUBLIC_PAGE_BASIC_AUTH_PASS is not set' });
    }
    const body = req.body ?? {};
    const userOk = safeCompare(body.username ?? '', user);
    const passOk = safeCompare(body.password ?? '', pass);
    if (userOk && passOk) {
      setSessionCookie(res, user || 'user');
      return res.status(200).json({ ok: true });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // GET /session — lets the standalone UI ask "am I already logged in?" without leaking anything.
  function sessionHandler(req, res) {
    return res.status(200).json({ authenticated: hasValidSession(req) });
  }

  // POST /logout — clear the cookie. Requires the CSRF header too: the cookie is SameSite=None, so
  // without this a cross-site page could POST /logout (the cookie rides along) and force-logout the
  // user. The UI sends X-PAI-Auth via useApi.
  function logoutHandler(req, res) {
    if (!csrfOk(req)) return res.status(403).json({ error: 'CSRF check failed' });
    clearSessionCookie(res);
    return res.status(204).end();
  }

  // POST /session/b24 — { domain, authId }. Establishes a session from inside the B24 frame by
  // validating the portal via app.info. SSRF guard is CRITICAL: domain is attacker-influenceable
  // (it arrives from the frame), so we normalise it to a bare hostname and require it to match
  // the portal allowlist BEFORE making any outbound request.
  async function b24SessionHandler(req, res) {
    const body = req.body ?? {};
    const host = normalizeDomain(body.domain);
    if (!host || !domainAllowed(host, portalDomains)) {
      // Do NOT call appInfo for a non-allowlisted domain — that is the SSRF sink.
      return res.status(400).json({ error: 'domain not allowed' });
    }
    const authId = typeof body.authId === 'string' ? body.authId : '';
    // Reject empty/implausibly-long authId before the outbound call: a real B24 access token is
    // short and never empty, so skipping the round-trip avoids a pointless app.info hit and bounds
    // the URL we build.
    if (!authId || authId.length > 4096) {
      return res.status(401).json({ error: 'b24 auth failed' });
    }
    let ok = false;
    try {
      ok = await appInfo(host, authId);
    } catch (e) {
      // network/abort/parse failure → auth failure. Log for ops with the authId redacted so a token
      // never lands in logs; the client still gets a generic 401 (no detail leak).
      ok = false;
      console.warn(`[b24-session] app.info failed for ${host}: ${redactAuthId(e?.message ?? e)}`);
    }
    if (ok) {
      setSessionCookie(res, `b24:${host}`);
      return res.status(200).json({ ok: true });
    }
    return res.status(401).json({ error: 'b24 auth failed' });
  }

  return {
    // helpers (exported for tests + index.js wiring)
    issue,
    verify,
    hasValidSession,
    requireSession,
    csrfOk,
    cookieName: COOKIE_NAME,
    // handlers
    loginHandler,
    sessionHandler,
    logoutHandler,
    b24SessionHandler,
  };
}

// Normalise a portal domain to a bare, lowercase hostname: strip scheme, any path/query, and a
// :port suffix. Returns '' for anything that doesn't yield a plausible hostname. Rejecting early
// here is the first half of the SSRF guard (the allowlist match is the second).
function normalizeDomain(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  if (s === '') return '';
  // Drop scheme if present (https://host…), then everything from the first '/'.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split('/')[0];
  // Drop a port suffix and any leftover userinfo (user@host).
  s = s.split('@').pop();
  s = s.split(':')[0];
  // A valid hostname: dot-separated labels of [a-z0-9-], no leading/trailing dot.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return '';
  return s;
}

// Match a normalised host against the allowlist. Supports exact entries (portal.example.com) and
// wildcard entries like '*.bitrix24.by', which match any SINGLE-label subdomain (foo.bitrix24.by
// but NOT a.b.bitrix24.by, and NOT the bare apex bitrix24.by) — mirroring CSP frame-ancestors
// wildcard semantics, so one env (B24_FRAME_ANCESTORS) drives both the CSP and this allowlist.
// Exported so the B24 bot (b24-bot-api.js) reuses the SAME SSRF allowlist for its outbound calls.
export function domainAllowed(host, allowlist) {
  for (const entry of allowlist) {
    if (typeof entry !== 'string' || entry === '') continue;
    const e = entry.trim().toLowerCase();
    if (e.startsWith('*.')) {
      const suffix = e.slice(1); // '.bitrix24.by'
      if (host.endsWith(suffix)) {
        const sub = host.slice(0, host.length - suffix.length);
        // exactly one label before the suffix, and non-empty
        if (sub.length > 0 && !sub.includes('.')) return true;
      }
    } else if (host === e) {
      return true;
    }
  }
  return false;
}

// Default app.info probe. Validates the portal by calling its REST app.info with the frame's
// AUTH_ID. Returns true ONLY when the HTTP response is ok AND the parsed JSON has a truthy
// `result` and NO `error` (B24 returns `{ error, error_description }` on a bad/expired auth).
// 5s timeout via AbortSignal.timeout so a hung portal can't pin the request. `domain` is already
// normalised + allowlisted by the caller, so the URL host is trusted here.
// Strip any `auth=<token>` value from a string before logging — defence in depth so a B24 access
// token never lands in logs (fetch errors don't normally include the URL, but never risk it).
const redactAuthId = (s) => String(s).replace(/auth=[^&\s]+/gi, 'auth=***');

async function defaultAppInfo(domain, authId) {
  const url = `https://${domain}/rest/app.info?auth=${encodeURIComponent(authId)}`;
  // redirect:'error' is defence-in-depth against SSRF-via-redirect: `domain` is allowlisted, but a
  // portal that responds 3xx (compromise/MITM) must not pull us to an internal address — fail closed.
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!res.ok) return false;
  let data;
  try {
    data = await res.json();
  } catch {
    return false;
  }
  return Boolean(data) && Boolean(data.result) && !data.error;
}
