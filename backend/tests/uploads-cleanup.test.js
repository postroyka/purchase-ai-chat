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

  // Falsifiable floor test: a 12-HOUR-old file. Without the 1-day floor, retentionDays=0 would
  // delete anything older than "now" (12h > 0 days → gone); the floor keeps it (12h < 1 day).
  it.each([0, -5, NaN])('floors a bad retentionDays (%s) at 1 — a 12h-old file survives', (bad) => {
    const file = path.join(dir, 'half-day.txt');
    fs.writeFileSync(file, 'x');
    ageEntry(file, 12 * 60 * 60 * 1000); // 12 hours old

    const summary = cleanupOldUploads({ dir, retentionDays: bad });

    expect(fs.existsSync(file)).toBe(true);
    expect(summary.removed).toHaveLength(0);
  });

  it('returns an empty summary (does not throw) for a missing directory', () => {
    const summary = cleanupOldUploads({ dir: path.join(dir, 'does-not-exist'), retentionDays: 7 });
    expect(summary.removed).toHaveLength(0);
    expect(summary.kept).toBe(0);
  });

  it('keeps an entry whose mtime equals the cutoff exactly (boundary: strict <, not <=)', () => {
    const file = path.join(dir, 'boundary.txt');
    fs.writeFileSync(file, 'x');
    const past = Date.now() - 7 * DAY_MS;
    fs.utimesSync(file, new Date(past), new Date(past));
    // Read the mtime the FS actually stored (dodges sub-ms rounding flakiness), then place `now`
    // so the cutoff lands exactly on it: cutoff = now - 7d  ⇒  now = mtimeMs + 7d.
    const mtimeMs = fs.lstatSync(file).mtimeMs;
    const summary = cleanupOldUploads({ dir, retentionDays: 7, now: mtimeMs + 7 * DAY_MS });

    expect(fs.existsSync(file)).toBe(true); // mtimeMs === cutoff → NOT (< cutoff) → kept
    expect(summary.kept).toBe(1);
  });

  it('isolates a per-entry lstat error: skips that entry and keeps sweeping the rest', () => {
    const good = path.join(dir, 'good.txt');
    const bad = path.join(dir, 'bad.txt');
    fs.writeFileSync(good, 'x');
    fs.writeFileSync(bad, 'x');
    ageEntry(good, 10 * DAY_MS);
    ageEntry(bad, 10 * DAY_MS);

    const realLstat = fs.lstatSync.bind(fs);
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((p, ...args) => {
      if (String(p).endsWith('bad.txt')) throw Object.assign(new Error('boom'), { code: 'EACCES' });
      return realLstat(p, ...args);
    });
    try {
      const summary = cleanupOldUploads({ dir, retentionDays: 7 });
      expect(fs.existsSync(good)).toBe(false);            // the good (old) entry was still removed
      expect(summary.removed).toContain('good.txt');
      expect(summary.skipped).toBeGreaterThanOrEqual(1);  // bad.txt skipped, sweep not aborted
    } finally {
      spy.mockRestore();
    }
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

  it('returns an unref-d timer so it never holds the event loop open', () => {
    const timer = startUploadsCleanup({ dir, retentionDays: 7, intervalMs: 9_999_999 });
    try {
      expect(timer.hasRef?.()).toBe(false); // .unref() was applied
    } finally {
      clearInterval(timer);
    }
  });
});
