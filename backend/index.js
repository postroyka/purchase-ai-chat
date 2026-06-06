import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { timingSafeEqual } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { createJobsStore } from './jobs-store.js';
import { runAgent } from './agent-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_PLACEHOLDER = 'replace-with-secure-token';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  // application/zip is a valid fallback for xlsx/docx — only allowed when ext matches
  'application/zip',
]);

// file-type needs ≥4096 bytes to reliably detect OOXML (xlsx/docx) formats
const MIME_SNIFF_BYTES = 4100;

// Constant-time string comparison. Length mismatch short-circuits before timingSafeEqual
// to avoid the "buffers must have the same length" throw; the length leak is acceptable
// for fixed-length bearer tokens.
function safeCompare(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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
 *   allowedExtensions?: string,
 *   redisUrl?: string,
 *   ttlHours?: number,
 *   responsibleUserId?: string,
 *   agentConfig?: import('./agent-runner.js').AgentConfig,
 *   jobs?: object,
 * }} [config]
 * @returns {import('express').Express}
 */
export function createApp(config = {}) {
  const uploadDir = path.resolve(
    config.uploadDir ?? process.env.UPLOAD_DIR ?? 'uploads',
  );
  const maxFileSizeMb = config.maxFileSizeMb
    ?? parseInt(process.env.MAX_FILE_SIZE_MB ?? '20', 10);
  const maxFilesPerRequest = config.maxFilesPerRequest
    ?? parseInt(process.env.MAX_FILES_PER_REQUEST ?? '10', 10);
  const allowedExtensions = (
    config.allowedExtensions
    ?? (process.env.ALLOWED_EXTENSIONS ?? 'pdf,xlsx,docx')
  )
    .split(',')
    .map((e) => e.trim().toLowerCase());
  const token = config.token ?? process.env.BACKEND_API_TOKEN ?? '';
  const responsibleUserIdDefault =
    config.responsibleUserId ?? process.env.PUBLIC_PAGE_RESPONSIBLE_USER_ID ?? null;
  const redisUrl = config.redisUrl ?? process.env.REDIS_URL ?? '';
  const ttlHours = config.ttlHours ?? parseInt(process.env.JOB_TTL_HOURS ?? '24', 10);

  const app = express();
  const jobs = config.jobs ?? createJobsStore({ redisUrl, ttlHours });
  const agentConfig = config.agentConfig ?? {};

  // Track in-flight processJob calls so graceful shutdown can wait for them.
  let activeJobs = 0;
  app.getActiveJobCount = () => activeJobs;

  function requireAuth(req, res, next) {
    if (!token || token === AUTH_PLACEHOLDER) {
      return res.status(503).json({ error: 'Service not configured: BACKEND_API_TOKEN is not set' });
    }
    const auth = req.headers['authorization'] ?? '';
    if (safeCompare(auth, `Bearer ${token}`)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
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

  // POST /upload
  app.post('/upload', requireAuth, (req, res) => {
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
          for (const file of req.files) { try { fs.unlinkSync(file.path); } catch {} }
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
          for (const file of req.files) { try { fs.unlinkSync(file.path); } catch {} }
          return res.status(500).json({ error: 'Failed to read uploaded file' });
        }

        const ext = path.extname(f.originalname).slice(1).toLowerCase();
        const detected = await fileTypeFromBuffer(buf);
        if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
          for (const file of req.files) { try { fs.unlinkSync(file.path); } catch {} }
          return res.status(400).json({
            error: `File "${path.basename(f.originalname)}" has invalid content type (detected: ${detected?.mime ?? 'unknown'}).`,
          });
        }
        // application/zip is a structural fallback for xlsx/docx — reject if ext doesn't match
        if (detected.mime === 'application/zip' && !['xlsx', 'docx'].includes(ext)) {
          for (const file of req.files) { try { fs.unlinkSync(file.path); } catch {} }
          return res.status(400).json({
            error: `File "${path.basename(f.originalname)}" has invalid content type (detected: ${detected.mime}).`,
          });
        }
      }

      const jobId = uuidv4();
      const jobDir = path.join(uploadDir, jobId);
      fs.mkdirSync(jobDir, { recursive: true });

      let fileEntries;
      try {
        fileEntries = req.files.map((f) => {
          const safeFilename = path.basename(f.originalname);
          const resolvedJobDir = path.resolve(jobDir);
          const destPath = path.join(resolvedJobDir, safeFilename);
          if (!destPath.startsWith(resolvedJobDir + path.sep)) {
            throw Object.assign(new Error(`Unsafe filename rejected: ${f.originalname}`), {
              code: 'UNSAFE_FILENAME',
            });
          }
          fs.renameSync(f.path, destPath);
          return { name: safeFilename, path: destPath, status: 'pending', result: null, error: null };
        });
      } catch (err) {
        fs.rmSync(jobDir, { recursive: true, force: true });
        for (const file of req.files) { try { fs.unlinkSync(file.path); } catch {} }
        if (err.code === 'UNSAFE_FILENAME') {
          return res.status(400).json({ error: err.message });
        }
        return res.status(500).json({ error: 'Failed to store uploaded files' });
      }

      const responsibleUserId = req.body?.responsibleUserId ?? responsibleUserIdDefault;

      const job = {
        jobId,
        status: 'pending',
        responsibleUserId,
        files: fileEntries,
        dir: jobDir,
        createdAt: Date.now(),
      };
      await jobs.set(jobId, job);

      activeJobs++;
      processJob(jobId, jobs, agentConfig).catch((e) =>
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
    const job = await jobs.get(req.params.id);
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

  // Serve built UI (only present in Docker image).
  const UI_PUBLIC_DIR = path.join(__dirname, '..', 'ui', 'public');
  app.use(express.static(UI_PUBLIC_DIR));

  return app;
}

// Iterates a job's files sequentially, runs the agent on each, and persists
// status transitions (pending → processing → done/error) to the jobs store.
// NOTE: assumes single-process deployment — no distributed locking. Multi-instance
// deployments would need a queue (e.g. BullMQ) to prevent duplicate processing.
async function processJob(jobId, jobs, agentConfig = {}) {
  const job = await jobs.get(jobId);
  if (!job) return;

  job.status = 'processing';
  await jobs.set(jobId, job);

  for (const fileEntry of job.files) {
    fileEntry.status = 'processing';
    await jobs.set(jobId, job);
    try {
      fileEntry.result = await runAgent(fileEntry.path, job.responsibleUserId, agentConfig);
      fileEntry.status = 'done';
    } catch (err) {
      console.error(`[processJob] error processing file ${fileEntry.name}:`, err);
      fileEntry.status = 'error';
      fileEntry.error = err.message;
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
  const app = createApp();
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
