import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanupOldUploads, startUploadsCleanup } from '../uploads-cleanup.js';

// Suppress the expected "could not process …" warnings from the error-isolation test.
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});

const DAY_MS = 24 * 60 * 60 * 1000;

// Set an entry's mtime (and atime) into the past so the retention check treats it as stale.
function ageEntry(target, ageMs) {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(target, when, when);
}

describe('cleanupOldUploads', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-cleanup-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes entries older than the retention window and keeps fresh ones', () => {
    const oldFile = path.join(dir, 'old.txt');
    const freshFile = path.join(dir, 'fresh.txt');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(freshFile, 'fresh');
    // 10 days old vs. just now, with a 7-day retention.
    ageEntry(oldFile, 10 * DAY_MS);

    const summary = cleanupOldUploads({ dir, retentionDays: 7 });

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
    expect(summary.removed).toContain('old.txt');
    expect(summary.kept).toBe(1);
  });

  it('removes a stale job FOLDER recursively (uploads/<job_id>/ with files inside)', () => {
    const jobDir = path.join(dir, 'job-123');
    fs.mkdirSync(jobDir);
    fs.writeFileSync(path.join(jobDir, 'invoice.pdf'), 'data');
    ageEntry(jobDir, 30 * DAY_MS);

    const summary = cleanupOldUploads({ dir, retentionDays: 7 });

    expect(fs.existsSync(jobDir)).toBe(false);
    expect(summary.removed).toContain('job-123');
  });

  it('never deletes the live multer _tmp spool, even when its mtime is old', () => {
    const tmp = path.join(dir, '_tmp');
    fs.mkdirSync(tmp);
    ageEntry(tmp, 365 * DAY_MS);

    const summary = cleanupOldUploads({ dir, retentionDays: 7 });

    expect(fs.existsSync(tmp)).toBe(true);
    expect(summary.removed).not.toContain('_tmp');
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
  });

  it('honours an injected `now` so age is computed deterministically', () => {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');
    // The file is fresh in real time; advance `now` 8 days into the future → it's now stale.
    const summary = cleanupOldUploads({ dir, retentionDays: 7, now: Date.now() + 8 * DAY_MS });

    expect(fs.existsSync(file)).toBe(false);
    expect(summary.removed).toContain('a.txt');
  });

  it('floors retentionDays at 1 so a misconfigured 0 cannot wipe fresh uploads', () => {
    const file = path.join(dir, 'today.txt');
    fs.writeFileSync(file, 'x');
    // mtime is "now"; with the 1-day floor a brand-new file is below the cutoff and survives.
    const summary = cleanupOldUploads({ dir, retentionDays: 0 });

    expect(fs.existsSync(file)).toBe(true);
    expect(summary.removed).toHaveLength(0);
  });

  it('returns an empty summary (does not throw) for a missing directory', () => {
    const summary = cleanupOldUploads({ dir: path.join(dir, 'does-not-exist'), retentionDays: 7 });
    expect(summary.removed).toHaveLength(0);
    expect(summary.kept).toBe(0);
  });
});

describe('startUploadsCleanup', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-cleanup-timer-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs an immediate sweep on start and returns an unref-able timer', () => {
    const stale = path.join(dir, 'stale.txt');
    fs.writeFileSync(stale, 'x');
    ageEntry(stale, 30 * DAY_MS);

    const timer = startUploadsCleanup({ dir, retentionDays: 7, intervalMs: 60_000 });
    try {
      // The boot pass must have already removed the stale entry (no need to wait the interval).
      expect(fs.existsSync(stale)).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });
});
