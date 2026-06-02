import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10);
const ALLOWED_EXTENSIONS = (process.env.ALLOWED_EXTENSIONS || 'pdf,xlsx,docx')
  .split(',')
  .map((e) => e.trim().toLowerCase());

// In-memory jobs store
const jobs = new Map();

// Multer storage: files go to a temp dir first, then moved per-job
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = path.join(__dirname, '..', UPLOAD_DIR, '_tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}_${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
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
app.post('/upload', (req, res) => {
  upload.array('files[]')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large. Max size: ${MAX_FILE_SIZE_MB} MB` });
      }
      if (err.code === 'INVALID_EXTENSION') {
        return res.status(400).json({ error: err.message });
      }
      return res.status(400).json({ error: err.message });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const jobId = uuidv4();
    const jobDir = path.join(__dirname, '..', UPLOAD_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const fileEntries = req.files.map((f) => {
      const destPath = path.join(jobDir, f.originalname);
      fs.renameSync(f.path, destPath);
      return {
        name: f.originalname,
        path: destPath,
        status: 'pending',
        result: null,
        error: null,
      };
    });

    const responsibleUserId = req.body.responsibleUserId || process.env.PUBLIC_PAGE_RESPONSIBLE_USER_ID || null;

    jobs.set(jobId, {
      jobId,
      status: 'pending',
      responsibleUserId,
      files: fileEntries,
    });

    // Fire and forget
    processJob(jobId).catch((e) => console.error(`[processJob] unhandled error for job ${jobId}:`, e));

    return res.status(201).json({
      jobId,
      files: fileEntries.map(({ name, status }) => ({ name, status })),
    });
  });
});

// GET /job/:id/status
app.get('/job/:id/status', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json({
    jobId: job.jobId,
    status: job.status,
    files: job.files.map(({ name, status, result, error }) => ({ name, status, result, error })),
  });
});

// GET /health
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Process job: iterate files sequentially
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'processing';

  for (const fileEntry of job.files) {
    fileEntry.status = 'processing';
    try {
      const agentResult = await runAgent(fileEntry.path, job.responsibleUserId);
      fileEntry.status = 'done';
      fileEntry.result = agentResult;
    } catch (err) {
      console.error(`[processJob] error processing file ${fileEntry.name}:`, err);
      fileEntry.status = 'error';
      fileEntry.error = err.message;
    }
  }

  job.status = 'done';
}

// runAgent stub — will be replaced with Claude Code CLI invocation
async function runAgent(filePath, responsibleUserId) {
  console.log(`[runAgent] stub called: filePath=${filePath}, responsibleUserId=${responsibleUserId}`);
  return { status: 'stub', message: 'agent not implemented yet' };
}

app.listen(PORT, () => {
  console.log(`[backend] procure-ai backend listening on port ${PORT}`);
});
