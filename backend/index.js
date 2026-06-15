import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { createJobsStore } from './jobs-store.js';
import { createMetrics } from './metrics.js';
import { createNbrbRate } from './nbrb-rate.js';
import { runAgent, redactToken } from './agent-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The usage dashboard (issue #67) is now a Nuxt page — ui/app/pages/metrics.vue — served as a
// prerendered static asset by express.static below (behind the same Basic auth as the UI).
// The backend only owns the data here: GET /metrics/data.

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

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'image/jpeg', // jpg/jpeg
  'image/png',  // png
  // Ambiguous containers below also match other formats — gated by the extension check
  // after detection: application/zip → xlsx/docx, application/x-cfb (OLE2) → xls
  'application/zip',
  'application/x-cfb',
]);

// file-type needs ≥4096 bytes to reliably detect OOXML (xlsx/docx) formats
const MIME_SNIFF_BYTES = 4100;

// Caps for agent-derived fields persisted to Redis and returned via the API,
// so a malformed/oversized agent response can't bloat the store or the response.
const MAX_RESULT_BYTES = 100_000;
const MAX_ERROR_CHARS = 300;

// Constant-time string comparison with no length leak (#41). Hash both sides to a fixed
// 32-byte digest first: this sidesteps timingSafeEqual's equal-length requirement WITHOUT
// the old early `length !== length` short-circuit (which leaked token length via timing).
// SHA-256 is collision-resistant, so equal digests ⇒ equal inputs for our auth use.
function safeCompare(a, b) {
  const digest = (s) => createHash('sha256').update(Buffer.from(String(s), 'utf8')).digest();
  return timingSafeEqual(digest(a), digest(b));
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

// Dependency-free in-memory rate limiter. Keyed by Authorization header (per client),
// so a single token flooding /upload can't exhaust the agent subprocess pool. State is
// per-process — matches the single-process deployment (see processJob note below).
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function rateLimit(req, res, next) {
    if (!max || max <= 0) return next(); // max<=0 disables the limiter
    const key = req.headers['authorization'] || req.ip || 'anon';
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'Too many requests — slow down.' });
    }
    recent.push(now);
    hits.set(key, recent);
    return next();
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
 *   publicPageEnabled?: boolean,
 *   uiPublicDir?: string,
 *   agentConfig?: import('./agent-runner.js').AgentConfig,
 *   jobs?: object,
 *   metrics?: object,
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
  const publicPageEnabled = config.publicPageEnabled
    ?? ((process.env.PUBLIC_PAGE_ENABLED ?? 'true') !== 'false');
  const uiPublicDir = config.uiPublicDir ?? path.join(__dirname, '..', 'ui', 'public');
  const rateLimitMax = config.rateLimitMax
    ?? parseInt(process.env.RATE_LIMIT_MAX ?? '20', 10);
  const rateLimitWindowMs = config.rateLimitWindowMs
    ?? parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);

  const app = express();

  // Baseline security headers (helmet-equivalent subset). Kept dependency-free so the
  // prod image still builds with `pnpm install --frozen-lockfile --prod`.
  //
  // CSP (#105): pragmatic, not maximal. 'unsafe-inline' is retained for script/style because
  // the Nuxt production bundle emits inline hydration/styles, so this does NOT stop inline-script
  // XSS — TODO: nonce-based CSP (drop 'unsafe-inline') as a #105 follow-up; do not consider P2
  // fully closed by this. The lever that still bites here is `connect-src 'self'`: it blocks an
  // XSS payload from POSTing the (currently client-visible) backend token to an attacker origin.
  // object-src/base-uri/frame-ancestors close clickjacking and base-tag injection.
  // HSTS (#105): force HTTPS for 2y incl. subdomains (the TLS-terminating proxy must serve it).
  // NOTE: after deploy, smoke-check that the dashboard still renders under this CSP.
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
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
  const uploadRateLimit = createRateLimiter({ windowMs: rateLimitWindowMs, max: rateLimitMax });

  // Track in-flight processJob calls so graceful shutdown can wait for them.
  let activeJobs = 0;
  app.getActiveJobCount = () => activeJobs;

  const bearerConfigured = () => Boolean(token) && token !== AUTH_PLACEHOLDER;
  const basicAuthConfigured = () =>
    publicPageEnabled && Boolean(basicAuthPass) && basicAuthPass !== BASIC_AUTH_PLACEHOLDER;

  // Validate an HTTP Basic credential against the configured public-page user/pass.
  // Both fields are compared in constant time; a missing/garbled header returns false.
  function checkBasicAuth(req) {
    const auth = req.headers['authorization'] ?? '';
    if (!auth.startsWith('Basic ')) return false;
    let decoded;
    try { decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8'); } catch { return false; }
    const sep = decoded.indexOf(':');
    if (sep < 0) return false;
    // Evaluate both comparisons (no short-circuit) so timing doesn't reveal which half matched.
    const userOk = safeCompare(decoded.slice(0, sep), basicAuthUser);
    const passOk = safeCompare(decoded.slice(sep + 1), basicAuthPass);
    return userOk && passOk;
  }

  // API auth for /upload and /job/:id/status. Accepts EITHER the Bearer API token
  // (programmatic / smoke-test clients) OR — when the public page is enabled — a valid
  // Basic credential. A browser that authenticated for the page resends Basic automatically
  // on same-origin requests, so the UI needs no API token baked into its bundle.
  function requireAuth(req, res, next) {
    if (bearerConfigured() && safeCompare(req.headers['authorization'] ?? '', `Bearer ${token}`)) {
      return next();
    }
    if (basicAuthConfigured() && checkBasicAuth(req)) return next();
    if (!bearerConfigured() && !basicAuthConfigured()) {
      return res.status(503).json({
        error: 'Service not configured: set BACKEND_API_TOKEN or PUBLIC_PAGE_BASIC_AUTH_USER/PASS',
      });
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Page-level Basic auth guarding the served UI. Fails closed: if the public page is
  // enabled but the password is unset/placeholder, returns 503 rather than serving openly.
  function requirePageAuth(req, res, next) {
    if (!basicAuthConfigured()) {
      return res.status(503).send('Service not configured: PUBLIC_PAGE_BASIC_AUTH_PASS is not set');
    }
    if (checkBasicAuth(req)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="procure-ai", charset="UTF-8"');
    return res.status(401).send('Authentication required');
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
        const detected = await fileTypeFromBuffer(buf);
        if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
          cleanupTmpFiles(req.files);
          return res.status(400).json({
            error: `File "${path.basename(decodeOriginalName(f.originalname))}" has invalid content type (detected: ${detected?.mime ?? 'unknown'}).`,
          });
        }
        // application/zip is a structural fallback for xlsx/docx — reject if ext doesn't match
        if (detected.mime === 'application/zip' && !['xlsx', 'docx'].includes(ext)) {
          cleanupTmpFiles(req.files);
          return res.status(400).json({
            error: `File "${path.basename(decodeOriginalName(f.originalname))}" has invalid content type (detected: ${detected.mime}).`,
          });
        }
        // application/x-cfb (OLE2 compound file) is the signature of legacy .xls — reject for other exts
        if (detected.mime === 'application/x-cfb' && ext !== 'xls') {
          cleanupTmpFiles(req.files);
          return res.status(400).json({
            error: `File "${path.basename(decodeOriginalName(f.originalname))}" has invalid content type (detected: ${detected.mime}).`,
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

      const job = {
        jobId,
        status: 'pending',
        responsibleUserId,
        files: fileEntries,
        dir: jobDir,
        createdAt: Date.now(),
      };
      try {
        await jobs.set(jobId, job);
      } catch (e) {
        console.error(`[upload] failed to persist job ${jobId}:`, e.message);
        fs.rmSync(jobDir, { recursive: true, force: true });
        return res.status(503).json({ error: 'Job store unavailable — please retry' });
      }

      activeJobs++;
      metrics.recordUpload({ fileCount: fileEntries.length }).catch(() => {}); // best-effort
      processJob(jobId, jobs, agentConfig, metrics).catch((e) =>
        console.error(`[processJob] unhandled error for job ${jobId}:`, e),
      ).finally(() => { activeJobs--; });

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
      files: job.files.map(({ name, status, result, error }) => ({ name, status, result, error })),
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

  // GET /metrics/data — JSON snapshot. Dual auth (Bearer for scripts; Basic for the
  // in-browser dashboard, which resends the page credentials automatically on same-origin).
  app.get('/metrics/data', requireAuth, async (_req, res) => {
    try {
      return res.json(await metrics.snapshot());
    } catch (e) {
      console.error('[metrics] snapshot error:', e.message);
      return res.status(503).json({ error: 'Metrics unavailable' });
    }
  });

  // Serve built UI (only present in Docker image), guarded by Basic auth when the public
  // page is enabled. Mounted only if the build output exists, so dev runs (UI served
  // separately on :3001) and tests are unaffected.
  // extensions:['html'] resolves GET /metrics → metrics.html (Nuxt prerenders routes as flat
  // .html files because nuxt.config sets autoSubfolderIndex:false). /metrics/data is handled
  // by the route above, so it never reaches the static layer.
  if (publicPageEnabled && fs.existsSync(uiPublicDir)) {
    app.use(requirePageAuth, express.static(uiPublicDir, { extensions: ['html'] }));
  }

  return app;
}

// Iterates a job's files sequentially, runs the agent on each, and persists
// status transitions (pending → processing → done/error) to the jobs store.
// NOTE: assumes single-process deployment — no distributed locking. Multi-instance
// deployments would need a queue (e.g. BullMQ) to prevent duplicate processing.
async function processJob(jobId, jobs, agentConfig = {}, metrics = null) {
  const job = await jobs.get(jobId);
  if (!job) return;

  job.status = 'processing';
  await jobs.set(jobId, job);

  for (const fileEntry of job.files) {
    fileEntry.status = 'processing';
    await jobs.set(jobId, job);
    const startedAt = Date.now();
    const format = path.extname(fileEntry.path).slice(1).toLowerCase();
    let agentMeta = null; // filled via onMeta on a successful run (extract method + cost/time)
    try {
      // Pass jobId into the agent config so agent-runner log lines are traceable
      // when multiple jobs run concurrently. onMeta captures usage metadata (#67).
      const result = await runAgent(fileEntry.path, job.responsibleUserId, {
        ...agentConfig, jobId, onMeta: (m) => { agentMeta = m; },
      });
      // Guard against an abnormally large agent result bloating Redis / the API response.
      let tooLarge = false;
      try { tooLarge = JSON.stringify(result).length > MAX_RESULT_BYTES; } catch { /* non-serialisable */ }
      fileEntry.result = tooLarge
        ? { truncated: true, message: 'agent result too large — omitted' }
        : result;
      fileEntry.status = 'done';
      // A business error (e.g. tool_unavailable, supplier_not_found) comes back in the agent's
      // result payload — not as a thrown exception — so the file is "done" but the outcome
      // isn't "ok". Surface it for the metrics breakdown.
      const outcome = (result && typeof result === 'object' && typeof result.error === 'string')
        ? result.error
        : 'ok';
      // Count recognised line items + those missing a supplier article (vendorCode) for the
      // savings estimate (#75). Items are present even when the deal couldn't be created
      // (e.g. tool_unavailable) — the recognition/matching work was still done.
      const items = Array.isArray(result?.items) ? result.items : [];
      const positionsNoArticle = items.filter((it) => {
        const vc = it && typeof it === 'object' ? it.vendorCode : null;
        return vc == null || String(vc).trim() === '';
      }).length;
      metrics?.recordFile({
        format, status: 'done', outcome, durationMs: Date.now() - startedAt, agent: agentMeta,
        positions: items.length, positionsNoArticle,
      });
    } catch (err) {
      // Redact any Bearer token before the message is logged, persisted, or returned.
      const safeMsg = redactToken(String(err?.message ?? 'agent error'));
      console.error(`[processJob] error processing file ${fileEntry.name} (job ${jobId}): ${safeMsg}`);
      fileEntry.status = 'error';
      fileEntry.error = safeMsg.slice(0, MAX_ERROR_CHARS);
      metrics?.recordFile({ format, status: 'error', outcome: classifyAgentError(safeMsg), durationMs: Date.now() - startedAt, agent: agentMeta });
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
