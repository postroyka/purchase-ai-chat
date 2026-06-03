import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { fileTypeFromBuffer } from 'file-type';
import { createJobsStore } from './jobs-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10);
const MAX_FILES_PER_REQUEST = parseInt(process.env.MAX_FILES_PER_REQUEST || '10', 10);
const ALLOWED_EXTENSIONS = (process.env.ALLOWED_EXTENSIONS || 'pdf,xlsx,docx')
  .split(',')
  .map((e) => e.trim().toLowerCase());
const BACKEND_API_TOKEN = process.env.BACKEND_API_TOKEN || '';

// MIME types allowed by magic bytes (not just extension).
// xlsx/docx are ZIP-based; file-type returns their specific OOXML type when
// the internal structure is valid, and falls back to application/zip otherwise.
// We allow both so a correct xlsx/docx isn't wrongly rejected, but document
// that a generic zip with a renamed extension will also pass this check.
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/zip', // fallback for valid xlsx/docx whose OOXML header isn't detected
]);

// How many bytes to read for magic-byte detection. file-type needs ≤ 4100 bytes.
const MIME_SNIFF_BYTES = 4100;

const AUTH_PLACEHOLDER = 'replace-with-secure-token';

/**
 * Bearer-token auth middleware.
 * - No token configured → 503 (force operator to set the secret)
 * - Placeholder value → 503 (same: copied from example without changing)
 * - Wrong token → 401
 */
function requireAuth(req, res, next) {
  if (!BACKEND_API_TOKEN || BACKEND_API_TOKEN === AUTH_PLACEHOLDER) {
    return res.status(503).json({ error: 'Service not configured: BACKEND_API_TOKEN is not set' });
  }
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${BACKEND_API_TOKEN}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

const jobs = createJobsStore();

// Multer storage: files land in a tmp dir first, then moved after MIME check.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = path.join(__dirname, '..', UPLOAD_DIR, '_tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}_${path.basename(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
    files: MAX_FILES_PER_REQUEST,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).replace('.', '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(
        Object.assign(new Error(`File type .${ext} is not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`), {
          code: 'INVALID_EXTENSION',
        })
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
        return res.status(400).json({ error: `File too large. Max size: ${MAX_FILE_SIZE_MB} MB` });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: `Too many files. Max: ${MAX_FILES_PER_REQUEST}` });
      }
      if (err.code === 'INVALID_EXTENSION') {
        return res.status(400).json({ error: err.message });
      }
      return res.status(400).json({ error: err.message });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // MIME validation via magic bytes — read only first MIME_SNIFF_BYTES to avoid
    // loading full file into memory (prevents zip-bomb DoS with large xlsx/docx).
    for (const f of req.files) {
      let buf;
      try {
        const fd = fs.openSync(f.path, 'r');
        buf = Buffer.alloc(MIME_SNIFF_BYTES);
        const bytesRead = fs.readSync(fd, buf, 0, MIME_SNIFF_BYTES, 0);
        fs.closeSync(fd);
        buf = buf.subarray(0, bytesRead);
      } catch (readErr) {
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
    const jobDir = path.join(__dirname, '..', UPLOAD_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const fileEntries = req.files.map((f) => {
      const safeFilename = path.basename(f.originalname);
      const resolvedJobDir = path.resolve(jobDir);
      const destPath = path.join(resolvedJobDir, safeFilename);
      if (!destPath.startsWith(resolvedJobDir + path.sep)) {
        throw new Error(`Unsafe filename rejected: ${f.originalname}`);
      }
      fs.renameSync(f.path, destPath);
      return {
        name: safeFilename,
        path: destPath,
        status: 'pending',
        result: null,
        error: null,
      };
    });

    const responsibleUserId = req.body.responsibleUserId || process.env.PUBLIC_PAGE_RESPONSIBLE_USER_ID || null;

    const job = {
      jobId,
      status: 'pending',
      responsibleUserId,
      files: fileEntries,
      dir: jobDir,
      createdAt: Date.now(),
    };
    await jobs.set(jobId, job);

    // Fire and forget
    processJob(jobId).catch((e) => console.error(`[processJob] unhandled error for job ${jobId}:`, e));

    return res.status(201).json({
      jobId,
      files: fileEntries.map(({ name, status }) => ({ name, status })),
    });
  });
});

// GET /job/:id/status
app.get('/job/:id/status', requireAuth, async (req, res) => {
  const job = await jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json({
    jobId: job.jobId,
    status: job.status,
    files: job.files.map(({ name, status, result, error }) => ({ name, status, result, error })),
  });
});

// GET /health — no auth, used by Docker healthcheck
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Process job: iterate files sequentially
async function processJob(jobId) {
  const job = await jobs.get(jobId);
  if (!job) return;

  job.status = 'processing';
  await jobs.set(jobId, job);

  for (const fileEntry of job.files) {
    fileEntry.status = 'processing';
    await jobs.set(jobId, job);
    try {
      const agentResult = await runAgent(fileEntry.path, job.responsibleUserId);
      fileEntry.status = 'done';
      fileEntry.result = agentResult;
    } catch (err) {
      console.error(`[processJob] error processing file ${fileEntry.name}:`, err);
      fileEntry.status = 'error';
      fileEntry.error = err.message;
    }
    await jobs.set(jobId, job);
  }

  const allFailed = job.files.every((f) => f.status === 'error');
  job.status = allFailed ? 'error' : 'done';
  await jobs.set(jobId, job);
}

// runAgent stub — TODO Week 2: replace with child_process.spawn('claude', ['--mcp-config', ...])
async function runAgent(_filePath, _responsibleUserId) {
  // Avoid logging PII (file path, user id) — log only job context when available
  return { status: 'stub', message: 'agent not implemented yet' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`[backend] procure-ai backend listening on port ${PORT}`);
  });
}

export { app };
