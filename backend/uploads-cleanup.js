// Retention sweep for the uploads/ directory (ТЗ §5 / day 14). Multer's per-request handler
// already removes the short-lived temp files in uploads/_tmp, and processJob() rm's a job's own
// folder after it finishes — but a job that crashes, a process killed mid-run, or simply the
// historical backlog leaves uploads/<job_id>/ folders behind forever. Disk then grows without
// bound. This module deletes any entry under uploadDir whose mtime is older than the configured
// retention window, run once at boot and then periodically.
//
// Design notes:
//  - Best-effort and NEVER throws: a single un-deletable entry (permissions, a file vanishing
//    between readdir and stat, an NFS hiccup) must not abort the whole sweep or crash the boot
//    path that starts the timer. Every entry is wrapped in its own try/catch.
//  - Parameters (dir, retentionDays, now) are injectable so the unit test can point at a temp
//    dir, age files via fs.utimesSync, and assert deterministically without waiting real days.
//  - mtime, not ctime/atime: ctime changes on metadata touches and atime is often disabled
//    (noatime mounts); mtime ("last written") best reflects "this upload is stale".

import fs from 'fs';
import path from 'path';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// The active multer spool. We never age this out by folder mtime — multer owns its lifecycle
// (it writes then moves/removes files inside it) and removing the directory underneath it would
// race an in-flight upload. Stale *temp files* inside it are out of scope here; only the _tmp
// directory entry itself is skipped.
const TMP_DIR_NAME = '_tmp';

/**
 * Delete entries (files or directories) directly under `dir` whose mtime is older than
 * `retentionDays` days. Returns a small summary for logging/tests. Never throws.
 *
 * @param {{ dir: string, retentionDays?: number, now?: number }} opts
 *   - dir: the uploads directory to sweep (required).
 *   - retentionDays: age threshold in days; floored at 1 so a misconfigured 0/negative value
 *     can't wipe fresh uploads. Defaults to 7.
 *   - now: current epoch ms; injectable for deterministic tests. Defaults to Date.now().
 * @returns {{ removed: string[], kept: number, skipped: number }}
 *   removed — names deleted; kept — entries left in place (too new); skipped — _tmp + errors.
 */
export function cleanupOldUploads({ dir, retentionDays = 7, now = Date.now() } = {}) {
  const summary = { removed: [], kept: 0, skipped: 0 };
  // Floor at 1 day: never let a bad UPLOADS_RETENTION_DAYS (0, negative, NaN) delete fresh data.
  const days = Number.isFinite(retentionDays) && retentionDays >= 1 ? retentionDays : 1;
  const cutoff = now - days * MS_PER_DAY;

  let entries;
  try {
    // withFileTypes avoids an extra stat just to learn file-vs-dir; missing dir → nothing to do.
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // ENOENT is normal on a fresh deploy (uploads/ not created until the first upload). Anything
    // else (permission, not-a-directory) is logged but swallowed — a sweep must not crash callers.
    if (e?.code !== 'ENOENT') {
      console.warn(`[uploads-cleanup] cannot read ${dir}: ${e?.message ?? e}`);
    }
    return summary;
  }

  for (const entry of entries) {
    const name = entry.name;
    if (name === TMP_DIR_NAME) {
      // Leave the live multer spool alone (see TMP_DIR_NAME note above).
      summary.skipped += 1;
      continue;
    }
    const full = path.join(dir, name);
    try {
      // lstatSync (not statSync): we age/remove the entry ITSELF. For a symlink that means its own
      // mtime, and the rmSync below removes just the link — never following it outside uploadDir.
      const { mtimeMs } = fs.lstatSync(full);
      if (mtimeMs < cutoff) {
        // recursive+force: job folders contain the uploaded files; force ignores a concurrent
        // delete (ENOENT) so two overlapping sweeps don't fight.
        fs.rmSync(full, { recursive: true, force: true });
        summary.removed.push(name);
      } else {
        summary.kept += 1;
      }
    } catch (e) {
      // Per-entry isolation: a vanished/locked entry is skipped, the sweep continues.
      summary.skipped += 1;
      console.warn(`[uploads-cleanup] could not process ${full}: ${e?.message ?? e}`);
    }
  }

  return summary;
}

/**
 * Start the periodic retention sweep: one immediate pass at boot (clears any existing backlog
 * right away) plus a recurring pass on `intervalMs`. Returns the timer so a caller could stop it.
 *
 * Intentionally NOT started inside createApp(): the route/unit suites import createApp and would
 * otherwise spawn real timers and do filesystem deletes. It's wired only at the prod entry point
 * (bottom of index.js). The timer is .unref()'d so it never keeps the Node event loop alive on its
 * own — important so tests/CLI processes can exit cleanly.
 *
 * @param {{ dir: string, retentionDays?: number, intervalMs?: number }} opts
 * @returns {NodeJS.Timeout} the interval handle (already unref'd).
 */
export function startUploadsCleanup({ dir, retentionDays = 7, intervalMs = 6 * 60 * 60 * 1000 } = {}) {
  const run = () => {
    const { removed, kept, skipped } = cleanupOldUploads({ dir, retentionDays });
    if (removed.length > 0) {
      console.log(`[uploads-cleanup] removed ${removed.length} stale upload(s) older than ${retentionDays}d (kept ${kept}, skipped ${skipped})`);
    }
  };
  run(); // sweep the backlog immediately on boot, don't wait one full interval
  const timer = setInterval(run, intervalMs);
  // Don't let the cleanup timer be the reason the process stays up (tests, graceful shutdown).
  timer.unref?.();
  return timer;
}
