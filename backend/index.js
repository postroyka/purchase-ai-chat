import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { timingSafeEqual } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { createJobsStore } from './jobs-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_PLACEHOLDER = 'replace-with-secure-token';

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/zip', // fallback for valid xlsx/docx whose OOXML header isn't detected
]);

const MIME_SNIFF_BYTES = 4100;

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
  const jobs = createJobsStore({ redisUrl, ttlHours });

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

  const upload = multer({
    storage,
    limits: {
      fileSize: maxFileSizeMb * 1024 * 1024,
      files: maxFilesPerRequest,
    },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).replace('.', '').toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        return cb(
          Object.assign(
            new Error(`File type .${ext} is not allowed. Allowed: ${allowedExtensions.join(', ')}`),
            { code: 'INVALID_EXTENSION' },
          ),
        );
      }
      cb(null, true);
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

      // MIME validation via magic bytes.
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

        const detected = await fileTypeFromBuffer(buf);
        if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
          for (const file of req.files) { try { fs.unlinkSync(file.path); } catch {} }
          return res.status(400).json({
            error: `File "${path.basename(f.originalname)}" has invalid content type (detected: ${detected?.mime ?? 'unknown'}).`,
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

      processJob(jobId, jobs).catch((e) =>
        console.error(`[processJob] unhandled error for job ${jobId}:`, e),
      );

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

  // GET /health — no auth, used by Docker healthcheck
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Serve built UI (only present in Docker image).
  const UI_PUBLIC_DIR = path.join(__dirname, '..', 'ui', 'public');
  app.use(express.static(UI_PUBLIC_DIR));

  return app;
}

async function processJob(jobId, jobs) {
  const job = await jobs.get(jobId);
  if (!job) return;

  job.status = 'processing';
  await jobs.set(jobId, job);

  for (const fileEntry of job.files) {
    fileEntry.status = 'processing';
    await jobs.set(jobId, job);
    try {
      fileEntry.result = await runAgent(fileEntry.path, job.responsibleUserId);
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
}

// TODO Week 2: replace with child_process.spawn('claude', ['--mcp-config', ...])
async function runAgent(_filePath, _responsibleUserId) {
  return { status: 'stub', message: 'agent not implemented yet' };
}

// Entry point — only runs when executed directly, not when imported by tests.
if (process.argv[1] === __filename) {
  const PORT = process.env.PORT ?? 3000;
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[backend] procure-ai backend listening on port ${PORT}`);
  });
}
