import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { MIME_SNIFF_BYTES, validateSniffedMime } from './file-validation.js';
import { createJobsStore } from './jobs-store.js';
import { createMetrics } from './metrics.js';
import { createNbrbRate } from './nbrb-rate.js';
import { startUploadsCleanup } from './uploads-cleanup.js';
import { runAgent, redactToken } from './agent-runner.js';
import { createSessionAuth, parseCookies, domainAllowed } from './auth.js';
import { createGithubIssue, buildIssue, normalizeKind, GithubFeedbackError, checkRepoPrivacy } from './feedback.js';
import { createAgentFeedbackReporter } from './agent-feedback.js';
import { parseBotEvent, handleBotEvent } from './b24-bot.js';
import { makeBotApi } from './b24-bot-api.js';
import { safeCompare } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The usage dashboard (issue #67) is now a Nuxt page — ui/app/pages/metrics.vue — served as a
// prerendered static asset by express.static below (served openly; the app session gates the
// /metrics/data API). The backend only owns the data here: GET /metrics/data.

// Map a thrown agent error message to a small, stable label for the metrics outcome
// breakdown (issue #67). Business errors (supplier_not_found, tool_unavailable, …) arrive in
// the agent's result payload instead and are recorded directly.
// Order matters: a crash's stderr may embed "ENOENT"/"not found", so match agent-runner's
// exact "CLI not found" phrase and check "exited with code" before the JSON-shape errors.
export function classifyAgentError(msg) {
  const m = String(msg);
  if (/timed out/i.test(m)) return 'timeout';
  if (/CLI not found/i.test(m)) return 'cli_missing';
  if (/exited with code/i.test(m)) return 'agent_crash';
  if (/no JSON|not valid JSON/i.test(m)) return 'bad_output';
  return 'other_error';
}

const AUTH_PLACEHOLDER = 'replace-with-secure-token';
const BASIC_AUTH_PLACEHOLDER = 'replace-with-secure-password';

// ALLOWED_MIME_TYPES + MIME_SNIFF_BYTES + the magic-byte validator now live in ./file-validation.js
// so /upload (below) and the chat-bot download boundary (b24-bot-api.js, #216) share one content check.

// Caps for agent-derived fields persisted to Redis and returned via the API,
// so a malformed/oversized agent response can't bloat the store or the response.
const MAX_RESULT_BYTES = 100_000;
const MAX_ERROR_CHARS = 300;

// safeCompare (constant-time, no length leak, #41) is shared via ./utils.js so the Bearer check here
// and the cookie/credential checks in auth.js never drift.

// Derive bare hostnames from the space-separated CSP frame-ancestors string (e.g.
// "https://*.bitrix24.by https://portal.example.com" → ["*.bitrix24.by", "portal.example.com"]).
// Reused for the app.info SSRF allowlist so ops configures only ONE env (B24_FRAME_ANCESTORS):
// whoever may iframe the app is exactly who we'll trust to establish a B24 session. Wildcard
// entries ('*.bitrix24.by') are preserved and interpreted by auth.js's allowlist matcher.
function parseFrameAncestorHosts(frameAncestors) {
  return String(frameAncestors || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((origin) => origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')) // strip scheme
    .map((s) => s.split('/')[0]) // strip any path
    .map((s) => s.replace(/:\d+$/, '')) // strip port
    .map((s) => s.toLowerCase())
    // Keep only real dotted hostnames (optionally a '*.' wildcard); drop CSP keywords/non-hosts like
    // 'self', 'none', 'data:' so they can't accidentally enter the app.info allowlist.
    .filter((s) => /^(\*\.)?[a-z0-9][a-z0-9.-]*\.[a-z0-9]{2,}$/.test(s));
}

// Best-effort removal of multer's temp files. Used on every early-return error
// path in /upload so a rejected upload never leaves orphans in uploads/_tmp.
function cleanupTmpFiles(files) {
  for (const file of files ?? []) {
    try { fs.unlinkSync(file.path); } catch {}
  }
}

// multer/busboy decode the multipart filename header as latin1, so UTF-8 names
// (e.g. Cyrillic) arrive as mojibake. Re-decode as UTF-8. If the string already holds
// real Unicode (chars > 0xFF — e.g. via RFC5987 filename*), it's correct → leave it.
function decodeOriginalName(name) {
  if (typeof name !== 'string' || /[^\x00-\xff]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  // Don't corrupt a genuine latin-1 name: if re-decoding yielded replacement chars
  // (U+FFFD), the bytes weren't UTF-8 → keep the original.
  return decoded.includes('�') ? name : decoded;
}

// Per-client rate limiter, keyed by a HASH of the Authorization header (so a single token
// flooding /upload can't exhaust the agent subprocess pool, and the raw token never becomes a
// Redis key). Prefers Redis (shared across instances + survives restart, #105); falls back to
// an in-memory Map when no Redis client is supplied (dev/tests/single-process).
function createRateLimiter({ windowMs, max, redisClient = null, keyFn = null }) {
  const hits = new Map(); // process-local fallback
  // Bucket identity. Default: the Authorization header (programmatic callers) or the client IP
  // (cookie sessions carry no Authorization header). A caller may override via keyFn — e.g. /feedback
  // keys on the verified session `sub` so one portal's staff behind a shared NAT don't share a bucket.
  // Whatever identity string is returned is hashed uniformly here (the raw value never becomes a key).
  const identityFor = keyFn || ((req) => String(req.headers['authorization'] || req.ip || 'anon'));
  const keyFor = (req) =>
    'rl:' + createHash('sha256').update(identityFor(req)).digest('hex').slice(0, 32);

  // Redis fixed-window: INCR the counter and (re)arm the window TTL. We pexpire on EVERY hit,
  // not just the first: if the process died between INCR and pexpire on the first hit, the key
  // would otherwise live forever with no TTL and lock the client out — re-arming every hit makes
  // it self-healing (the tiny window-extension on each request is acceptable for a DoS guard).
  // The INCR/pexpire pair is not atomic — a key expiring exactly between two concurrent INCRs can
  // permit ±1 request at the boundary; acceptable here (a Lua script would make it strict).
  // Fail-OPEN on any Redis error: a best-effort DoS guard must never block uploads during a blip.
  async function allowedViaRedis(key) {
    try {
      const n = await redisClient.incr(key);
      await redisClient.pexpire(key, windowMs);
      return n <= max;
    } catch (e) {
      console.warn(`[rate-limit] Redis error — failing open: ${e?.message ?? e}`);
      return true;
    }
  }

  function allowedViaMemory(key) {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return false;
    recent.push(now);
    hits.set(key, recent);
    return true;
  }

  return function rateLimit(req, res, next) {
    if (!max || max <= 0) { next(); return; } // max<=0 disables the limiter
    const key = keyFor(req);
    const tooMany = () => {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      res.status(429).json({ error: 'Too many requests — slow down.' });
    };
    if (redisClient) {
      // .catch is belt-and-suspenders: allowedViaRedis already fails open, but a throw inside
      // the .then callback (e.g. next()) would otherwise become an UnhandledRejection that
      // crashes the process on Node 18+. Route it to Express's error handler instead.
      allowedViaRedis(key).then((ok) => (ok ? next() : tooMany())).catch((err) => next(err));
      return;
    }
    if (allowedViaMemory(key)) next(); else tooMany();
  };
}

/**
 * Create and configure the Express application.
 * All config is taken from the `config` argument (used by tests) with fallback
 * to process.env so that the production entry-point works without changes.
 *
 * @param {{
 *   token?: string,
 *   uploadDir?: string,
 *   maxFileSizeMb?: number,
 *   maxFilesPerRequest?: number,
 *   maxConcurrentJobs?: number,
 *   allowedExtensions?: string,
 *   redisUrl?: string,
 *   ttlHours?: number,
 *   responsibleUserId?: string,
 *   basicAuthUser?: string,
 *   basicAuthPass?: string,
 *   uiPublicDir?: string,
 *   agentConfig?: import('./agent-runner.js').AgentConfig,
 *   jobs?: object,
 *   metrics?: object,
 *   rateLimitRedis?: object,
 *   sessionAuth?: object,
 *   sessionSecret?: string,
 *   sessionTtlMs?: number,
 *   portalDomains?: string[],
 *   appInfo?: (domain: string, authId: string) => Promise<boolean>,
 *   loginRateLimitMax?: number,
 *   loginRateLimitWindowMs?: number,
 * }} [config]
 * @returns {import('express').Express}
 *
 * NOTE: when `metrics` is omitted createApp builds a default Metrics WITHOUT a live USD→BYN
 * rate provider (getUsdByn) — the savings estimate then uses the static USD_BYN_RATE fallback.
 * The live NB RB rate is wired only at the prod entry point (bottom of this file) so the unit/
 * route suites never make an outbound api.nbrb.by call. To get the live rate elsewhere, pass a
 * `metrics` built via createMetrics({ getUsdByn: createNbrbRate(...).get }).
 */
export function createApp(config = {}) {
  const uploadDir = path.resolve(
    config.uploadDir ?? process.env.UPLOAD_DIR ?? 'uploads',
  );
  const maxFileSizeMb = config.maxFileSizeMb
    ?? parseInt(process.env.MAX_FILE_SIZE_MB ?? '20', 10);
  const maxFilesPerRequest = config.maxFilesPerRequest
    ?? parseInt(process.env.MAX_FILES_PER_REQUEST ?? '10', 10);
  const maxConcurrentJobs = config.maxConcurrentJobs
    ?? parseInt(process.env.MAX_CONCURRENT_JOBS ?? '2', 10);
  const allowedExtensions = (
    config.allowedExtensions
    ?? (process.env.ALLOWED_EXTENSIONS ?? 'pdf,xlsx,docx,xls,jpg,jpeg,png')
  )
    .split(',')
    .map((e) => e.trim().toLowerCase());
  const token = config.token ?? process.env.BACKEND_API_TOKEN ?? '';
  const responsibleUserIdDefault =
    config.responsibleUserId ?? process.env.PUBLIC_PAGE_RESPONSIBLE_USER_ID ?? null;
  const redisUrl = config.redisUrl ?? process.env.REDIS_URL ?? '';
  const ttlHours = config.ttlHours ?? parseInt(process.env.JOB_TTL_HOURS ?? '24', 10);
  const basicAuthUser = config.basicAuthUser ?? process.env.PUBLIC_PAGE_BASIC_AUTH_USER ?? 'procure';
  const basicAuthPass = config.basicAuthPass ?? process.env.PUBLIC_PAGE_BASIC_AUTH_PASS ?? '';
  const uiPublicDir = config.uiPublicDir ?? path.join(__dirname, '..', 'ui', 'public');
  const rateLimitMax = config.rateLimitMax
    ?? parseInt(process.env.RATE_LIMIT_MAX ?? '20', 10);
  const rateLimitWindowMs = config.rateLimitWindowMs
    ?? parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);
  // App-session lifetime. Default 12h: long enough that a B24 workday doesn't re-prompt, short
  // enough that a leaked cookie ages out. Injectable for tests (config.sessionTtlMs).
  // Math.max(1h) guards SESSION_TTL_HOURS=0 / negative / NaN, which would otherwise make every issued
  // cookie already-expired (Max-Age=0 / exp in the past) → nobody could stay logged in.
  const sessionTtlMs = config.sessionTtlMs
    ?? Math.max(1, parseInt(process.env.SESSION_TTL_HOURS ?? '12', 10) || 12) * 60 * 60 * 1000;

  // GitHub user-feedback channel (issue #182, channel 1 — "from the employee"). When no token is set
  // the feature is OFF: GET /feedback/config reports { enabled:false } so the UI hides the widget, and
  // POST /feedback returns 503. The repo defaults to this app's own repo (private at launch, so
  // capturing job context in the issue is acceptable). See backend/feedback.js + docs/FEEDBACK.md.
  const githubFeedbackToken = config.githubFeedbackToken ?? process.env.GITHUB_FEEDBACK_TOKEN ?? '';
  const githubFeedbackRepo = config.githubFeedbackRepo
    ?? process.env.GITHUB_FEEDBACK_REPO ?? 'postroyka/purchase-ai-chat';
  // Замеры времени (#замеры): при SHOW_TIMINGS=true /job/:id/status отдаёт тайминги по файлам
  // (startedAt/agentMs/durationMs) + флаг — UI показывает ДЕТАЛЬНЫЕ замеры в логе по готовности.
  // Только для лога на странице, НЕ в метрики. По умолчанию выключено (opt-in). Живой mm:ss
  // «обрабатывается N сек» UI показывает всегда (от клиентского procSince), независимо от флага (#203).
  const showTimings = config.showTimings ?? (String(process.env.SHOW_TIMINGS ?? '').toLowerCase() === 'true');
  // Пороги «быстро/медленно» по total-времени файла для лога замеров (#замеры): ≤FAST → fast,
  // ≥SLOW → slow, между — normal. Оценочные — калибруются реальностью через env (docs/PARSING_PERFORMANCE.md).
  const timingFastMs = config.timingFastMs ?? (Number.parseInt(process.env.TIMING_FAST_MS ?? '', 10) || 45000);
  const timingSlowMs = config.timingSlowMs ?? (Number.parseInt(process.env.TIMING_SLOW_MS ?? '', 10) || 90000);
  // Guard NaN explicitly: a garbled FEEDBACK_RATE_LIMIT_MAX would otherwise become NaN, which the
  // limiter reads as "disabled" (fail-OPEN) — the wrong direction for an anti-spam-into-our-repo
  // control. Number.isFinite keeps a deliberate 0 (disable) working while a garbled value → default 5.
  const parsedFeedbackMax = config.feedbackRateLimitMax
    ?? parseInt(process.env.FEEDBACK_RATE_LIMIT_MAX ?? '5', 10);
  const feedbackRateLimitMax = Number.isFinite(parsedFeedbackMax) ? parsedFeedbackMax : 5;
  const parsedFeedbackWindow = config.feedbackRateLimitWindowMs
    ?? parseInt(process.env.FEEDBACK_RATE_LIMIT_WINDOW_MS ?? '3600000', 10);
  // A non-finite or non-positive window breaks the limiter (pexpire(NaN) throws → fails open;
  // memory path's `now - t < NaN` is always false → never blocks) → fall back to 1h.
  const feedbackRateLimitWindowMs = Number.isFinite(parsedFeedbackWindow) && parsedFeedbackWindow > 0
    ? parsedFeedbackWindow : 3600000;

  const app = express();
  // Behind nginx-proxy the real client IP is in X-Forwarded-For; without trusting the proxy, req.ip
  // is the proxy's address and the per-IP brute-force limiter on /login + /session/b24 would bucket
  // ALL clients into one counter (lockout for everyone, or no real per-attacker limit). Trust one hop
  // by default; override with TRUST_PROXY (hop count, 'loopback', or an IP/CIDR list) for other setups.
  const trustProxy = config.trustProxy ?? process.env.TRUST_PROXY ?? 1;
  app.set('trust proxy', /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy);

  // Baseline security headers (helmet-equivalent subset). Kept dependency-free so the
  // prod image still builds with `pnpm install --frozen-lockfile --prod`.
  //
  // CSP (#105): pragmatic, not maximal. 'unsafe-inline' is retained for script/style because
  // the Nuxt production bundle emits inline hydration/styles, so this does NOT stop inline-script
  // XSS — TODO: nonce-based CSP (drop 'unsafe-inline') as a #105 follow-up; do not consider P2
  // fully closed by this. connect-src allows 'self' + the Bitrix24 portals: the b24jssdk loads
  // app/profile/currency by XHR-ing the portal REST (batch) directly, so locking it to 'self' breaks
  // the in-frame SDK init (block:csp) and with it installFinish + helper data. The backend token is
  // no longer in the browser (#133/#173), so widening connect-src doesn't reopen a token-exfil path.
  // object-src/base-uri close base-tag injection. frame-ancestors allowlists who may iframe the
  // app: our own origin + Bitrix24 portals (the app runs inside the portal's iframe as a local
  // app). For a self-hosted Bitrix24 box set B24_FRAME_ANCESTORS to your portal origin(s),
  // space-separated. X-Frame-Options is intentionally NOT sent — it only speaks SAMEORIGIN/DENY
  // and would block the cross-origin Bitrix24 frame; modern browsers use CSP frame-ancestors as
  // its replacement.
  // HSTS (#105): force HTTPS for 2y incl. subdomains (the TLS-terminating proxy must serve it).
  // NOTE: after deploy, smoke-check that the dashboard still renders under this CSP.
  const frameAncestors = process.env.B24_FRAME_ANCESTORS
    || 'https://*.bitrix24.ru https://*.bitrix24.com https://*.bitrix24.by';
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", // blob: — same-origin object-URL для превью файлов (#198)
    "font-src 'self' data:",
    `connect-src 'self' ${frameAncestors}`,
    "object-src 'none'",
    "base-uri 'self'",
    `frame-ancestors 'self' ${frameAncestors}`,
  ].join('; ');
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Content-Security-Policy', csp);
    // HSTS only in production: in dev/staging the backend may be hit over plain HTTP
    // (no TLS proxy), and a 2-year HSTS pin there would wrongly block HTTP for that host.
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
    next();
  });

  const jobs = config.jobs ?? createJobsStore({ redisUrl, ttlHours });
  // The live NB RB rate is wired at the prod entry point (bottom of file), not here, so
  // createApp stays hermetic — no outbound api.nbrb.by call from the unit/route test suites.
  const metrics = config.metrics ?? createMetrics({ redisUrl });
  const agentConfig = config.agentConfig ?? {};
  // Rate-limiter state in Redis when available (multi-instance-safe, survives restart — #105);
  // dedicated lazy client mirroring jobs-store. Tests inject a fake via config.rateLimitRedis.
  // commandTimeout 1s (tighter than jobs-store's 3s): a rate-limit check must be fast, and a
  // hanging Redis should fail open quickly rather than pile up pending /upload handlers.
  // NB: like the jobs-store/metrics clients, this is not explicitly .quit()'d on shutdown —
  // process exit closes it (a uniform graceful Redis close is a small follow-up).
  const rateLimitRedis = config.rateLimitRedis ?? (redisUrl
    ? new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, commandTimeout: 1000 })
    : null);
  if (rateLimitRedis?.on) rateLimitRedis.on('error', (e) => console.error('[rate-limit] Redis error:', e?.message ?? e));
  const uploadRateLimit = createRateLimiter({ windowMs: rateLimitWindowMs, max: rateLimitMax, redisClient: rateLimitRedis });

  // Agent-feedback channel (issue #182, channel «агент»): turns the agent's result `feedback[]` into
  // deduped GitHub issues in the same private repo as the user channel. Off when no token is set
  // (same GITHUB_FEEDBACK_TOKEN gate). Redis client (when present) backs the dedup + hourly-cap.
  const agentFeedback = config.agentFeedback ?? createAgentFeedbackReporter({
    token: githubFeedbackToken, repo: githubFeedbackRepo, redisClient: rateLimitRedis,
  });

  // App-level signed-cookie session (auth.js) — replaces HTTP Basic so the Bitrix24 iframe can
  // load the UI. The standalone /login form's credentials are the existing PUBLIC_PAGE_BASIC_AUTH_*
  // values; a placeholder password counts as "not set" (mirrors the old basicAuthConfigured check)
  // so a forgotten-to-change default never authenticates.
  const loginPass = (basicAuthPass && basicAuthPass !== BASIC_AUTH_PLACEHOLDER) ? basicAuthPass : '';
  // Real (non-placeholder) API token used as the cookie-secret fallback below — a forgotten-to-change
  // placeholder must count as "no secret" so sessions stay unconfigured (→ 503), like bearerConfigured.
  const realToken = (token && token !== AUTH_PLACEHOLDER) ? token : '';
  // Cookie signing key. Prefer an explicit SESSION_SECRET (REQUIRED for multi-instance — see
  // .env.prod.example). When unset we derive deterministically so a single instance stays stable
  // across restarts. Derive from the PAGE PASSWORD first, NOT the API token: the token is shared with
  // MCP/CI/scripts and is the most likely secret to leak, and a token leak must not also let someone
  // forge session cookies. Only when no password is set (B24-only deployment) do we fall back to the
  // token, so the cookie is still signed with *some* secret rather than ''. Rotating the source secret
  // invalidates existing cookies (documented). If neither is set the secret is '' → loginHandler 503.
  const sessionSecret = config.sessionSecret ?? process.env.SESSION_SECRET ?? (
    loginPass
      ? createHash('sha256').update(`pai-session:pass:${loginPass}`).digest('hex')
      : realToken
        ? createHash('sha256').update(`pai-session:token:${realToken}`).digest('hex')
        : ''
  );
  // Deriving (vs an explicit SESSION_SECRET) in production ties the cookie key to the password/token
  // and won't match across instances — warn once so ops can set it deliberately.
  if (!config.sessionSecret && !process.env.SESSION_SECRET && sessionSecret
      && process.env.NODE_ENV === 'production') {
    console.warn('[session] SESSION_SECRET not set — deriving the cookie key from the page password/token. '
      + 'Set SESSION_SECRET explicitly (required for multi-instance; survives credential rotation).');
  }
  // The B24 app.info allowlist is derived from the SAME frame-ancestors origins as the CSP, so
  // ops sets only B24_FRAME_ANCESTORS. portalDomains tests can override via config.portalDomains.
  // SSRF-allowlist портала (из B24_FRAME_ANCESTORS) — общий для /session/b24 (app.info) и обратных
  // вызовов чат-бота (b24-bot-api.js): один env управляет всеми исходящими к порталу.
  const portalDomains = config.portalDomains ?? parseFrameAncestorHosts(frameAncestors);
  const sessionAuth = config.sessionAuth ?? createSessionAuth({
    secret: sessionSecret,
    user: basicAuthUser,
    pass: loginPass,
    secure: process.env.NODE_ENV === 'production',
    portalDomains,
    ttlMs: sessionTtlMs,
    appInfo: config.appInfo, // undefined in prod → auth.js uses its real fetch-based probe
  });
  // Dedicated tight brute-force limiter for the credential/session endpoints (/login + /session/b24),
  // separate from the upload limiter: both are guessing/DoS targets (password attempts; authId
  // guessing + app.info amplification), so cap attempts per IP. Keyed by IP (these requests carry no
  // Authorization header, so keyFor falls back to req.ip — hence the trust-proxy setting above).
  const authRateLimit = createRateLimiter({
    windowMs: config.loginRateLimitWindowMs ?? 60_000,
    max: config.loginRateLimitMax ?? 10,
    redisClient: rateLimitRedis,
  });

  // Лимитер публичного бот-эндпоинта (DoS/брутфорс токена): keyed по IP (события Б24 без Authorization).
  // Щедрее auth-лимитера — легальные события чата идут чаще; 0 = выкл (тесты).
  const b24BotRateLimit = createRateLimiter({
    windowMs: config.b24BotRateLimitWindowMs ?? 60_000,
    max: config.b24BotRateLimitMax ?? 120,
    redisClient: rateLimitRedis,
  });

  // Feedback anti-spam (issue #182): cap how many issues one client can open into our GitHub repo
  // per window (default 5/hour). Same Redis-backed limiter as the others (multi-instance-safe).
  // Counts ATTEMPTS — a failed GitHub call still consumes a slot, discouraging tight retry loops.
  // Keyed on the authenticated identity (session `sub` like `b24:<portal>`, or `api-token`) rather
  // than IP, so a whole portal's staff behind one office NAT don't share a single bucket (one active
  // reviewer would otherwise starve the rest). feedbackReporter is hoisted (function declaration).
  const feedbackRateLimit = createRateLimiter({
    windowMs: feedbackRateLimitWindowMs,
    max: feedbackRateLimitMax,
    redisClient: rateLimitRedis,
    keyFn: (req) => {
      const who = feedbackReporter(req);
      return who && who !== 'unknown' ? `fb-sub:${who}` : `fb-ip:${req.ip || 'anon'}`;
    },
  });

  // Track in-flight processJob calls so graceful shutdown can wait for them.
  let activeJobs = 0;
  app.getActiveJobCount = () => activeJobs;
  // Expose the resolved upload dir so the prod entrypoint's retention sweep targets the SAME
  // directory createApp uses — the two must never resolve UPLOAD_DIR independently and diverge.
  app.getUploadDir = () => uploadDir;

  const bearerConfigured = () => Boolean(token) && token !== AUTH_PLACEHOLDER;
  // A session is acceptable whenever we have a signing secret — the cookie is HMAC-verified, so its
  // validity IS the auth. (The page password is only needed to *log in* via /login, which checks it
  // separately.) Gating on the password instead would reject genuine B24 sessions (/session/b24) in a
  // token-but-no-password deployment, breaking uploads inside the portal.
  const sessionConfigured = () => Boolean(sessionSecret);

  // API auth for /upload, /job/:id/status and /metrics/data. Accepts EITHER the Bearer API token
  // (programmatic / smoke-test / MCP clients — unchanged) OR a valid app session: a signed
  // pai_sess cookie (set by /login or /session/b24) PLUS the X-PAI-Auth CSRF header. The browser
  // UI sends the cookie automatically (it works inside the cross-site B24 iframe because the
  // cookie is SameSite=None) and adds the header via useApi, so the UI needs no token in its
  // bundle. HTTP Basic is no longer accepted (incompatible with the B24 iframe). If neither auth
  // method is configured, fail with 503 (service not configured) rather than locking everyone out.
  function requireAuth(req, res, next) {
    if (bearerConfigured() && safeCompare(req.headers['authorization'] ?? '', `Bearer ${token}`)) {
      return next();
    }
    if (sessionConfigured() && sessionAuth.requireSession(req) && sessionAuth.csrfOk(req)) {
      return next();
    }
    if (!bearerConfigured() && !sessionConfigured()) {
      return res.status(503).json({
        error: 'Service not configured: set BACKEND_API_TOKEN or PUBLIC_PAGE_BASIC_AUTH_USER/PASS',
      });
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Best-effort identity for a feedback issue's "who reported" line. The feedback repo is private at
  // launch, so attributing a report to the B24 portal/login (cookie `sub`) — or to the API token for
  // programmatic callers — is useful triage signal, not a privacy leak. Never throws; unknown → 'unknown'.
  function feedbackReporter(req) {
    try {
      const cookies = parseCookies(req.headers?.cookie);
      const payload = sessionAuth.verify(cookies[sessionAuth.cookieName]);
      if (payload?.sub) return String(payload.sub);
    } catch { /* fall through to the bearer/unknown cases */ }
    if (bearerConfigured() && safeCompare(req.headers['authorization'] ?? '', `Bearer ${token}`)) {
      return 'api-token';
    }
    return 'unknown';
  }

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      const tmpDir = path.join(uploadDir, '_tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      cb(null, tmpDir);
    },
    filename: (_req, file, cb) => {
      cb(null, `${uuidv4()}_${path.basename(file.originalname)}`);
    },
  });

  // Extension check is intentionally NOT in fileFilter: calling cb(error) there aborts
  // the multipart stream mid-upload causing ECONNRESET on the client before the 400 is sent.
  // Instead we accept all files here and check extensions after the upload completes.
  const upload = multer({
    storage,
    limits: {
      fileSize: maxFileSizeMb * 1024 * 1024,
      files: maxFilesPerRequest,
    },
  });

  // Создание+запуск задания — ОБЩИЙ путь для /upload и чат-бота Б24 (b24-bot.js). files уже на диске
  // (форма [{name,path,status:'pending',result:null,error:null}]). onDone(job) — опц. колбэк по
  // завершении: UI поллит /job/:id/status и onDone не нужен, бот шлёт результат в чат.
  async function createAndStartJob({ jobId, jobDir, fileEntries, responsibleUserId, onDone }) {
    const job = { jobId, status: 'pending', responsibleUserId, files: fileEntries, dir: jobDir, createdAt: Date.now() };
    await jobs.set(jobId, job); // бросает → caller чистит jobDir и отвечает 503
    activeJobs++;
    metrics.recordUpload({ fileCount: fileEntries.length }).catch(() => {}); // best-effort
    processJob(jobId, jobs, agentConfig, metrics, agentFeedback)
      .then(async () => {
        if (!onDone) return;
        try { await onDone(await jobs.get(jobId)); }
        catch (e) { console.error(`[job ${jobId}] onDone failed:`, e?.message); }
      })
      .catch((e) => console.error(`[processJob] unhandled error for job ${jobId}:`, e))
      .finally(() => { activeJobs--; });
    return job;
  }

  // Завести GitHub-issue по отзыву (репо/токен из конфига) — общий путь для /feedback и бота.
  async function createFeedbackIssue({ kind, comment, context }) {
    const { title, body, labels } = buildIssue({ kind, comment, context });
    return createGithubIssue({ repo: githubFeedbackRepo, token: githubFeedbackToken, title, body, labels });
  }

  // Отзыв из чата бота (👍/👎): счётчик пишем всегда (source:'user', как у виджета сотрудника),
  // issue — best-effort и только при настроенном токене (бот не должен падать на телеметрии).
  async function submitChatFeedback({ kind, jobId, reporter }) {
    metrics.recordFeedback({ source: 'user', kind }).catch(() => {});
    if (!githubFeedbackToken) return;
    const comment = kind === 'positive' ? 'Оценка из чата Битрикс24: 👍 верно' : 'Оценка из чата Битрикс24: 👎 не то';
    const context = { jobId: /^[A-Za-z0-9-]{1,64}$/.test(String(jobId ?? '')) ? String(jobId) : '', reporter: String(reporter ?? '') };
    await createFeedbackIssue({ kind, comment, context });
  }

  // POST /upload — two DoS guards: per-token rate limit (uploadRateLimit) bounds request
  // frequency, and the concurrency cap below bounds how many agent subprocesses run at once.
  app.post('/upload', requireAuth, uploadRateLimit, (req, res) => {
    if (activeJobs >= maxConcurrentJobs) {
      return res.status(429).json({ error: 'Server busy — too many jobs in progress. Please retry shortly.' });
    }
    upload.array('files[]')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: `File too large. Max size: ${maxFileSizeMb} MB` });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({ error: `Too many files. Max: ${maxFilesPerRequest}` });
        }
        return res.status(400).json({ error: err.message });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      // Extension check (moved out of fileFilter — see comment above multer setup)
      for (const f of req.files) {
        const ext = path.extname(f.originalname).slice(1).toLowerCase();
        if (!allowedExtensions.includes(ext)) {
          cleanupTmpFiles(req.files);
          return res.status(400).json({
            error: `File type .${ext} is not allowed. Allowed: ${allowedExtensions.join(', ')}`,
          });
        }
      }

      // MIME validation via magic bytes — reads only MIME_SNIFF_BYTES to avoid loading
      // full files into memory (prevents zip-bomb DoS from large xlsx/docx).
      for (const f of req.files) {
        let buf;
        try {
          const fd = fs.openSync(f.path, 'r');
          buf = Buffer.alloc(MIME_SNIFF_BYTES);
          const bytesRead = fs.readSync(fd, buf, 0, MIME_SNIFF_BYTES, 0);
          fs.closeSync(fd);
          buf = buf.subarray(0, bytesRead);
        } catch {
          cleanupTmpFiles(req.files);
          return res.status(500).json({ error: 'Failed to read uploaded file' });
        }

        const ext = path.extname(f.originalname).slice(1).toLowerCase();
        const verdict = await validateSniffedMime(buf, ext);
        if (!verdict.ok) {
          cleanupTmpFiles(req.files);
          return res.status(400).json({
            error: `File "${path.basename(decodeOriginalName(f.originalname))}" has invalid content type (detected: ${verdict.mime ?? 'unknown'}).`,
          });
        }
      }

      // Validate optional responsibleUserId from the request body (the public page
      // sends it). Must be a positive integer — it is later passed to the agent / Б24.
      const rawResponsible = req.body?.responsibleUserId;
      const hasResponsible = rawResponsible != null && String(rawResponsible) !== '';
      if (hasResponsible && !/^\d+$/.test(String(rawResponsible))) {
        cleanupTmpFiles(req.files);
        return res.status(400).json({ error: 'responsibleUserId must be a positive integer' });
      }

      const jobId = uuidv4();
      const jobDir = path.join(uploadDir, jobId);
      fs.mkdirSync(jobDir, { recursive: true });

      let fileEntries;
      try {
        fileEntries = req.files.map((f) => {
          // Store under a generated UUID name (keeping only the already-validated
          // extension) so an attacker-controlled original filename never reaches the
          // on-disk path or the agent's FILE_PATH. Path traversal is impossible by
          // construction. The display name keeps the original basename for the UI.
          const displayName = path.basename(decodeOriginalName(f.originalname));
          const ext = path.extname(displayName).toLowerCase();
          const destPath = path.join(jobDir, `${uuidv4()}${ext}`);
          fs.renameSync(f.path, destPath);
          return { name: displayName, path: destPath, status: 'pending', result: null, error: null };
        });
      } catch (err) {
        fs.rmSync(jobDir, { recursive: true, force: true });
        cleanupTmpFiles(req.files);
        return res.status(500).json({ error: 'Failed to store uploaded files' });
      }

      const responsibleUserId = hasResponsible ? String(rawResponsible) : responsibleUserIdDefault;
      try {
        await createAndStartJob({ jobId, jobDir, fileEntries, responsibleUserId });
      } catch (e) {
        console.error(`[upload] failed to persist job ${jobId}:`, e.message);
        fs.rmSync(jobDir, { recursive: true, force: true });
        return res.status(503).json({ error: 'Job store unavailable — please retry' });
      }

      return res.status(201).json({
        jobId,
        files: fileEntries.map(({ name, status }) => ({ name, status })),
      });
    });
  });

  // GET /job/:id/status
  app.get('/job/:id/status', requireAuth, async (req, res) => {
    let job;
    try {
      job = await jobs.get(req.params.id);
    } catch (e) {
      console.error(`[job status] store error for ${req.params.id}:`, e.message);
      return res.status(503).json({ error: 'Job store unavailable — please retry' });
    }
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json({
      jobId: job.jobId,
      status: job.status,
      ...(showTimings ? { showTimings: true } : {}),
      files: job.files.map((f) => ({
        name: f.name, status: f.status, result: f.result, error: f.error, problem: f.problem,
        // Тайминги отдаём только при SHOW_TIMINGS (#замеры) — иначе ответ без изменений.
        ...(showTimings ? { startedAt: f.startedAt ?? null, agentMs: f.agentMs ?? null, durationMs: f.durationMs ?? null, extractMethod: f.extractMethod ?? null, speed: classifySpeed(f.durationMs, timingFastMs, timingSlowMs) } : {}),
      })),
    });
  });

  // GET /health — no auth, used by Docker healthcheck.
  // Checks Redis connectivity so nginx-proxy and Docker know when the instance is ready.
  app.get('/health', async (_req, res) => {
    try {
      await jobs.ping();
      return res.json({ ok: true, redis: 'ok' });
    } catch {
      return res.status(503).json({ ok: false, redis: 'unavailable' });
    }
  });

  // GET /metrics/data — JSON snapshot. Auth via requireAuth (Bearer for scripts/MCP; or the app
  // session cookie + X-PAI-Auth header for the in-browser dashboard).
  app.get('/metrics/data', requireAuth, async (_req, res) => {
    try {
      return res.json(await metrics.snapshot());
    } catch (e) {
      console.error('[metrics] snapshot error:', e.message);
      return res.status(503).json({ error: 'Metrics unavailable' });
    }
  });

  // ── App session (auth.js) ───────────────────────────────────────────────────────────────────
  // These establish/inspect/clear the pai_sess cookie. express.json is mounted INLINE on the body
  // routes ONLY (tight limits) — NOT globally — so /upload's multipart parsing is unaffected.
  // Registered BEFORE the static catch-all so the SPA's own /login etc. don't shadow them.
  //
  // /login — standalone (non-B24) credential login. Rate-limited (brute-force guard, per IP).
  app.post('/login', express.json({ limit: '1kb' }), authRateLimit, sessionAuth.loginHandler);
  // /session — "am I logged in?" probe for the standalone UI bootstrap.
  app.get('/session', sessionAuth.sessionHandler);
  // /logout — clear the session cookie.
  app.post('/logout', sessionAuth.logoutHandler);
  // /session/b24 — establish a session from inside the B24 frame by validating the portal via one
  // app.info call (SSRF-guarded against the frame-ancestors allowlist). 4kb limit: AUTH_ID tokens
  // are larger than a login body.
  app.post('/session/b24', express.json({ limit: '4kb' }), authRateLimit, sessionAuth.b24SessionHandler);

  // ── User feedback (feedback.js — issue #182, channel «сотрудник») ────────────────────────────
  // GET /feedback/config — OPEN probe so the UI can show/hide the widget without shipping a token to
  // the browser. Leaks only a boolean (is the GitHub channel configured), never the token or repo.
  app.get('/feedback/config', (_req, res) => res.json({ enabled: Boolean(githubFeedbackToken) }));

  // 503 when the channel is unconfigured — placed BEFORE the rate limiter so hitting a dead endpoint
  // can't burn a client's quota (and after requireAuth so it doesn't leak config state to anon).
  const requireFeedbackConfigured = (_req, res, next) =>
    githubFeedbackToken ? next() : res.status(503).json({ error: 'Feedback channel is not configured' });

  // POST /feedback — authenticated employee feedback → a GitHub issue in githubFeedbackRepo. Order of
  // middleware matters: requireAuth (gate to app users — cookie session + X-PAI-Auth, or Bearer) →
  // requireFeedbackConfigured (503 if off) → feedbackRateLimit (bound spam to our repo) → express.json
  // (small body) → handler. Mounted BEFORE the static catch-all so the SPA route doesn't shadow it.
  app.post('/feedback', requireAuth, requireFeedbackConfigured, feedbackRateLimit, express.json({ limit: '32kb' }), async (req, res) => {
    const body = req.body ?? {};
    const kind = normalizeKind(body.kind);
    if (!kind) {
      return res.status(400).json({ error: 'kind must be one of: positive, problem, suggestion' });
    }
    // Комментарий НЕ обязателен (#218): достаточно оценки 👍/👎. Пустой текст → issue с «(без текста)».
    const comment = typeof body.comment === 'string' ? body.comment : '';

    // Validate/normalise the app-captured context BEFORE it reaches buildIssue: ids are constrained
    // to safe charsets here; free-text fields (fileName, userAgent) are additionally hostile-stripped
    // + HTML-escaped inside buildIssue. An out-of-shape field is dropped (becomes ''), never rejected
    // — the feedback itself must still go through even if the context is partial/garbled.
    const ctxIn = (body.context && typeof body.context === 'object') ? body.context : {};
    const context = {
      jobId: /^[A-Za-z0-9-]{1,64}$/.test(String(ctxIn.jobId ?? '')) ? String(ctxIn.jobId) : '',
      fileName: typeof ctxIn.fileName === 'string' ? ctxIn.fileName.slice(0, 300) : '',
      dealId: /^\d{1,12}$/.test(String(ctxIn.dealId ?? '')) ? String(ctxIn.dealId) : '',
      appVersion: typeof ctxIn.appVersion === 'string' ? ctxIn.appVersion.slice(0, 80) : '',
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
      reporter: feedbackReporter(req),
    };

    try {
      const issue = await createFeedbackIssue({ kind, comment, context });
      metrics.recordFeedback({ source: 'user', kind }).catch(() => {}); // best-effort, → /metrics
      return res.status(201).json({ ok: true, url: issue.url, number: issue.number });
    } catch (e) {
      // Log ONLY the stable error code — createGithubIssue guarantees its message is leak-free, but
      // we still avoid logging the message (defence in depth: never let a token reach the logs).
      const code = e instanceof GithubFeedbackError ? e.code : 'UNKNOWN';
      console.error(`[feedback] could not create issue (code: ${code})`);
      const status = code === 'NOT_CONFIGURED' ? 503 : 502;
      return res.status(status).json({ error: 'Could not submit feedback right now. Please try again later.' });
    }
  });

  // POST /b24/bot/event — публичный обработчик событий чат-бота Б24 2.0 (дизайн docs/B24_BOT.md).
  // Без requireAuth (Б24 ходит снаружи server→server); защита — сверка ВЕРХНЕГО auth.application_token
  // (constant-time) + лимит тела. Включается заданием B24_BOT_APPLICATION_TOKEN; без него любой POST
  // отвергается (403). Тело — form-urlencoded с PHP-ключами (express.urlencoded extended).
  const b24BotAppToken = config.b24BotApplicationToken ?? process.env.B24_BOT_APPLICATION_TOKEN ?? '';
  app.post('/b24/bot/event', b24BotRateLimit, express.urlencoded({ extended: true, limit: '64kb' }), (req, res) => {
    const evt = parseBotEvent(req.body ?? {});
    if (!b24BotAppToken || !safeCompare(evt.applicationToken, b24BotAppToken)) {
      return res.status(403).json({ error: 'invalid application_token' });
    }
    // 200 быстро (Б24 не гарантирует повтор обработчика) — тяжёлую работу делаем асинхронно.
    res.status(200).json({ ok: true });
    const api = config.botApi ?? makeBotApi({
      restEndpoint: evt.bot.restEndpoint, uploadDir, allowedExtensions,
      maxBytes: maxFileSizeMb * 1024 * 1024, maxFiles: maxFilesPerRequest,
      // SSRF: исходящие бота (REST-callback + downloadUrl) только на разрешённые домены портала + redirect:'error'.
      isAllowedHost: (host) => domainAllowed(host, portalDomains),
    });
    handleBotEvent(evt, {
      createAndStartJob,
      submitFeedback: submitChatFeedback,
      hasCapacity: () => activeJobs < maxConcurrentJobs,
      responsibleUserIdFor: (uid) => (/^\d+$/.test(String(uid)) ? String(uid) : responsibleUserIdDefault),
      downloadAndSaveFiles: (files, opts) => api.downloadAndSaveFiles(files, { ...opts, botId: evt.bot.id }),
      sendMessage: (m) => api.sendMessage(m),
      log: (m) => console.error(m),
    }).catch((e) => console.error('[b24bot] handler error:', e?.message));
  });

  // Serve the built UI (only present in the Docker image) OPENLY so the Bitrix24 iframe can load
  // `/`, `/install` and assets — the app session (above) is the gate now, not a page-level Basic
  // prompt (which the cross-site B24 iframe cannot satisfy). Mounted only if the build output
  // exists, so dev runs (UI served separately on :3001) and tests are unaffected.
  // extensions:['html'] resolves GET /metrics → metrics.html (Nuxt prerenders routes as flat
  // .html files because nuxt.config sets autoSubfolderIndex:false). /metrics/data and the session
  // routes are handled above, so they never reach the static layer.
  if (fs.existsSync(uiPublicDir)) {
    // Bitrix24 loads the app + install handlers via POST (it submits the frame auth in the request
    // body, with DOMAIN/APP_SID/… also on the query string). express.static answers only GET, so
    // B24's POST would 404 with "Cannot POST /install" (or "/") and the app could never install or
    // open inside the portal. Serve the matching prerendered SPA shell on POST so the client boots;
    // b24jssdk then reads the frame params (window.name "DOMAIN|APP_SID" + postMessage auth) and
    // runs the app (/) or installFinish (/install). These are OPEN (no auth): B24's cross-site POST
    // can't carry our session cookie, and they only return the public SPA HTML — the API stays
    // gated by requireAuth. install.html falls back to index.html when /install isn't prerendered
    // (the client router then resolves /install from the URL path).
    const indexHtml = path.join(uiPublicDir, 'index.html');
    const installHtml = fs.existsSync(path.join(uiPublicDir, 'install.html'))
      ? path.join(uiPublicDir, 'install.html')
      : indexHtml;
    const sendSpa = (file) => (_req, res, next) => res.sendFile(file, (err) => { if (err) next(err); });
    app.post('/', sendSpa(indexHtml));
    app.post('/install', sendSpa(installHtml));
    app.use(express.static(uiPublicDir, { extensions: ['html'] }));
  }

  return app;
}

// Iterates a job's files sequentially, runs the agent on each, and persists
// status transitions (pending → processing → done/error) to the jobs store.
// NOTE: assumes single-process deployment — no distributed locking. Multi-instance
// deployments would need a queue (e.g. BullMQ) to prevent duplicate processing.
// Human-readable RU reason shown on the result page when a file finished WITHOUT a created deal
// (issue #192) — keyed by the agent's business-error code (prompts/main.md). We do NOT echo the
// agent's result.message (it derives from untrusted document text); a fixed message per code keeps
// it safe and clear. Unknown code / no-error-but-no-deal fall back to a generic line.
export const PROBLEM_MESSAGES = {
  unreadable_document: 'Не удалось распознать документ — нет читаемого текста. Загрузите чёткий скан или PDF счёта.',
  foreign_supplier: 'Поставщик не из РБ (российские реквизиты ИНН/КПП) — сделка не создаётся.',
  unsupported_currency: 'Валюта документа не BYN — сделка не создаётся.',
  supplier_not_found: 'Поставщик не найден в Битрикс24 по УНП из документа. Заведите поставщика или проверьте УНП.',
  contract_not_found: 'У поставщика не найден активный договор закупки. Создайте договор для поставщика.',
  missing_responsible: 'Не задан ответственный пользователь — сделку некому назначить. Обратитесь к администратору.',
  tool_unavailable: 'Сервис Битрикс24 временно недоступен. Повторите попытку позже.',
};
export function problemMessage(result) {
  const code = result && typeof result === 'object' && typeof result.error === 'string' ? result.error : null;
  if (code && Object.prototype.hasOwnProperty.call(PROBLEM_MESSAGES, code)) return PROBLEM_MESSAGES[code];
  if (code) return 'Не удалось обработать документ — сделка не создана.';
  return 'Сделка не создана — проверьте, что это счёт/спецификация (PDF или изображение).';
}

// Process the agent result's optional `feedback[]` (developer feedback about our MCP tools/prompt,
// issue #182 channel «агент»): count each by kind in metrics and hand it to the deduping reporter,
// which decides whether to open a GitHub issue. Bounded (≤10/file) against a prompt-injected document
// trying to spam, and fully best-effort — a feedback hiccup must never fail or noticeably delay a job.
async function reportAgentFeedback(result, agentFeedback, metrics, ctx) {
  const list = Array.isArray(result?.feedback) ? result.feedback.slice(0, 10) : [];
  for (const fb of list) {
    if (!fb || typeof fb !== 'object') continue;
    const note = typeof fb.note === 'string' ? fb.note : '';
    if (note.trim() === '') continue;
    // Normalise the kind ONCE so the /metrics counter and the issue label agree (an unknown kind
    // becomes 'problem' in both, instead of 'other' in metrics vs 'problem' on the issue).
    const kind = normalizeKind(typeof fb.kind === 'string' ? fb.kind : '') ?? 'problem';
    const tool = typeof fb.tool === 'string' ? fb.tool : '';
    metrics?.recordFeedback({ source: 'agent', kind })?.catch(() => {});
    try {
      await agentFeedback?.report({ kind, tool, note, context: ctx });
    } catch { /* reporter is best-effort and already swallows; guard anyway */ }
  }
}

// Классификация total-времени файла для лога замеров (#замеры): fast/normal/slow по порогам
// (оценочные, калибруются через TIMING_FAST_MS/TIMING_SLOW_MS — см. docs/PARSING_PERFORMANCE.md).
// Ожидается fastMs ≤ slowMs; при инверсии (конфиг-ошибка) 'slow' недостижим — всё ≤fast станет 'fast'.
export function classifySpeed(durationMs, fastMs, slowMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs <= fastMs) return 'fast';
  if (durationMs >= slowMs) return 'slow';
  return 'normal';
}

async function processJob(jobId, jobs, agentConfig = {}, metrics = null, agentFeedback = null) {
  const job = await jobs.get(jobId);
  if (!job) return;

  job.status = 'processing';
  await jobs.set(jobId, job);

  for (const fileEntry of job.files) {
    fileEntry.status = 'processing';
    const startedAt = Date.now();
    fileEntry.startedAt = startedAt; // тайминги (#замеры): для живого mm:ss, пока файл обрабатывается
    await jobs.set(jobId, job);
    const format = path.extname(fileEntry.path).slice(1).toLowerCase();
    let agentMeta = null; // filled via onMeta on a successful run (extract method + cost/time)
    try {
      // Pass jobId into the agent config so agent-runner log lines are traceable
      // when multiple jobs run concurrently. onMeta captures usage metadata (#67).
      const result = await runAgent(fileEntry.path, job.responsibleUserId, {
        ...agentConfig, jobId, onMeta: (m) => { agentMeta = m; },
      });
      // A created deal is the only success signal (prompts/main.md). Detect it up front so it can be
      // used for both the metrics outcome and the result-page badge, AND preserved through truncation.
      const rdeal = result && typeof result === 'object' && result.deal && typeof result.deal === 'object'
        ? result.deal : null;
      const dealId = rdeal ? rdeal.dealId : undefined;
      const hasDeal = dealId != null && String(dealId).trim() !== '';
      // Guard against an abnormally large agent result bloating Redis / the API response — but KEEP the
      // deal pointer in the truncated payload, else a big SUCCESS is mis-shown as "Без сделки" with no
      // reason (the #192 regression on the truncation path: the UI reads file.result.deal via dealOf).
      let tooLarge = false;
      try { tooLarge = JSON.stringify(result).length > MAX_RESULT_BYTES; } catch { /* non-serialisable */ }
      fileEntry.result = tooLarge
        ? { truncated: true, message: 'agent result too large — omitted', deal: rdeal }
        : result;
      fileEntry.status = 'done';
      // A business error (e.g. tool_unavailable, supplier_not_found) comes back in the agent's result
      // payload — not as a thrown exception — so the file is "done" but not "ok". A file with NO created
      // deal (business error OR an unrecognised document) is 'no_deal', NOT 'ok', so the /metrics
      // success-rate agrees with the UI ("успех = создана сделка", issue #192).
      const errCode = result && typeof result === 'object' && typeof result.error === 'string' ? result.error : null;
      const outcome = errCode ? errCode : (hasDeal ? 'ok' : 'no_deal');
      // issue #192: surface a human-readable reason when no deal was created, so the result page shows
      // WHY instead of a bare green "Готово". Status stays 'done' — it was processed.
      fileEntry.problem = hasDeal ? null : problemMessage(result).slice(0, MAX_ERROR_CHARS);
      // Count recognised line items + those missing a supplier article (vendorCode) for the
      // savings estimate (#75). Items are present even when the deal couldn't be created
      // (e.g. tool_unavailable) — the recognition/matching work was still done.
      const items = Array.isArray(result?.items) ? result.items : [];
      const positionsNoArticle = items.filter((it) => {
        const vc = it && typeof it === 'object' ? it.vendorCode : null;
        return vc == null || String(vc).trim() === '';
      }).length;
      // Тайминги (#замеры): полное время файла и время агента — для лога на странице (НЕ в метрики).
      const durationMs = Date.now() - startedAt;
      fileEntry.durationMs = durationMs;
      fileEntry.agentMs = (agentMeta && Number.isFinite(agentMeta.agentDurationMs)) ? agentMeta.agentDurationMs : null;
      // Метод извлечения текста (pdftotext/ocr/office) — частый ответ на «где медленно» (OCR-скан).
      fileEntry.extractMethod = (agentMeta && typeof agentMeta.extractMethod === 'string') ? agentMeta.extractMethod : null;
      metrics?.recordFile({
        format, status: 'done', outcome, durationMs, agent: agentMeta,
        positions: items.length, positionsNoArticle,
      });
      // Channel «MCP» (issue #182): record WHICH supplier failed to match (by УНП) so the dashboard
      // can rank the suppliers that fail most. Best-effort, derived from the same result. Method-guarded
      // (?.()) so a partial metrics stub can't throw into the job's success path.
      metrics?.recordMatching?.({ result });
      // Channel «агент» (issue #182): non-terminal quality signals → metrics counts; developer
      // feedback ("what hinders / how to improve" about our tools/prompt) → deduped GitHub issue +
      // metrics. Both are optional fields in the agent result and best-effort — never fail the job.
      const warnings = Array.isArray(result?.warnings)
        ? result.warnings.filter((w) => typeof w === 'string').slice(0, 20) // bound at the boundary
        : [];
      if (warnings.length) metrics?.recordWarnings(warnings);
      // Fire-and-forget: agent-feedback issue creation / metrics must NEVER delay the job — it never
      // feeds back into job state, and the metrics count (not the issue) is the durable signal.
      void reportAgentFeedback(result, agentFeedback, metrics, { jobId, fileName: fileEntry.name }).catch(() => {});
    } catch (err) {
      // Redact any Bearer token before the message is logged, persisted, or returned.
      const safeMsg = redactToken(String(err?.message ?? 'agent error'));
      console.error(`[processJob] error processing file ${fileEntry.name} (job ${jobId}): ${safeMsg}`);
      fileEntry.status = 'error';
      fileEntry.error = safeMsg.slice(0, MAX_ERROR_CHARS);
      const durationMs = Date.now() - startedAt;
      fileEntry.durationMs = durationMs;
      metrics?.recordFile({ format, status: 'error', outcome: classifyAgentError(safeMsg), durationMs, agent: agentMeta });
    }
    await jobs.set(jobId, job);
  }

  job.status = job.files.every((f) => f.status === 'error') ? 'error' : 'done';
  await jobs.set(jobId, job);

  // Clean up uploaded files after processing — agent has already read them.
  if (job.dir) {
    try {
      fs.rmSync(job.dir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[processJob] could not clean up job dir ${job.dir}:`, e.message);
    }
  }
}

// Entry point — only runs when executed directly, not when imported by tests.
if (process.argv[1] === __filename) {
  const PORT = process.env.PORT ?? 3000;
  // Wire the live NB RB USD→BYN rate here (not inside createApp) so the savings estimate (#75)
  // uses a real rate in production while the test suites stay offline. USD_BYN_RATE is the
  // offline fallback; the rate is cached 12h and fetched best-effort.
  const nbrbRate = createNbrbRate({ fallbackRate: Number(process.env.USD_BYN_RATE) || 3.3 });
  const metrics = createMetrics({ getUsdByn: nbrbRate.get });
  const app = createApp({ metrics });
  // Warm the cache and surface the source at boot, so ops can tell whether НБРБ is reachable
  // (vs. silently falling back to USD_BYN_RATE behind a strict egress firewall).
  nbrbRate.get()
    .then((r) => console.log(`[backend] USD→BYN rate: ${r.rate} (source: ${r.source}${r.date ? `, ${r.date}` : ''})`))
    .catch(() => {});
  const server = app.listen(PORT, () => {
    console.log(`[backend] procure-ai backend listening on port ${PORT}`);
  });

  // Privacy hardening (#190): feedback issues carry job context + employee comments (client data),
  // so the feedback repo MUST stay private. We can't enforce that, but warn loudly at boot if it's
  // public — a far better signal than a doc note that a single "Make public" click would silently void.
  // Best-effort, non-blocking; a network/permission failure just logs that it couldn't verify.
  {
    const fbToken = process.env.GITHUB_FEEDBACK_TOKEN ?? '';
    const fbRepo = process.env.GITHUB_FEEDBACK_REPO ?? 'postroyka/purchase-ai-chat';
    if (fbToken) {
      checkRepoPrivacy({ repo: fbRepo, token: fbToken })
        .then((r) => {
          if (r.private === false) {
            console.warn(`[backend] WARNING: feedback repo "${fbRepo}" is PUBLIC — feedback issues contain job context and employee comments. Make it private or point GITHUB_FEEDBACK_REPO at a private repo.`);
          } else if (r.private == null) {
            console.warn(`[backend] could not verify feedback repo privacy (status: ${r.status || 'network'}); ensure "${fbRepo}" is private.`);
          }
          // r.private === true → repo is private as intended → no log
        })
        .catch(() => {});
    }
  }

  // Retention sweep for uploads/ (ТЗ §5 / day 14): periodically delete job folders older than
  // UPLOADS_RETENTION_DAYS (default 7, floored at 1). Started here — NOT inside createApp — so the
  // test suites that import createApp never spawn timers or touch the filesystem. uploadDir is
  // resolved the same way createApp resolves it; the timer is self-unref'd so it can't block exit.
  // Parse retention: an unset/garbled value falls back to the documented default (7); a finite but
  // too-small value (0/negative) is passed through and floored to the 1-day minimum INSIDE
  // cleanupOldUploads — one source of the floor avoids the `parseInt('0')||7` footgun (0 → 7, not 1).
  const parsedRetention = parseInt(process.env.UPLOADS_RETENTION_DAYS ?? '7', 10);
  const uploadsRetentionDays = Number.isFinite(parsedRetention) ? parsedRetention : 7;
  const uploadsDir = app.getUploadDir();
  startUploadsCleanup({ dir: uploadsDir, retentionDays: uploadsRetentionDays });
  console.log(`[backend] uploads retention: deleting uploads older than ${Math.max(1, uploadsRetentionDays)}d (dir: ${uploadsDir})`);

  async function shutdown(signal) {
    console.log(`[backend] ${signal} received — graceful shutdown started`);
    // closeAllConnections() drains keep-alive connections immediately so no
    // new requests can arrive after shutdown begins (server.close() alone only
    // stops accepting new TCP connections, not existing keep-alive ones).
    server.closeAllConnections?.();
    server.close();
    // Wait up to 25 s — leave 5 s headroom before Docker's stop-timeout (30 s)
    // so the process exits cleanly before Docker sends SIGKILL.
    const deadline = Date.now() + 25_000;
    while (app.getActiveJobCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (app.getActiveJobCount() > 0) {
      console.error('[backend] shutdown deadline exceeded — forcing exit');
      process.exit(1);
    }
    console.log('[backend] all jobs finished — exiting cleanly');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
