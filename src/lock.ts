/**
 * File-based locking for serialising access to shared bare repos.
 *
 * Uses atomic `open(…, "wx")` (O_CREAT | O_EXCL) to create a lock file
 * and writes `pid:timestamp` so stale locks from crashed processes can be
 * detected and removed automatically.  The structured format ensures that
 * a partially written (truncated) lock file is never mistaken for a valid
 * owner.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RETRY_INTERVAL_MS = 500;
const MAX_WAIT_MS = 120_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockPath: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${process.pid}:${Date.now()}`);
      } catch (writeErr) {
        try {
          closeSync(fd);
        } catch {}
        try {
          unlinkSync(lockPath);
        } catch {}
        throw writeErr;
      }
      try {
        closeSync(fd);
      } catch (closeErr) {
        try {
          unlinkSync(lockPath);
        } catch {}
        throw closeErr;
      }
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      // Check for stale lock left by a crashed process.
      // Lock format is "pid:timestamp"; anything else is treated as
      // stale (e.g. truncated writes from a killed process).
      try {
        const raw = readFileSync(lockPath, "utf-8").trim();
        const match = /^(\d+):(\d+)$/.exec(raw);
        const pid = match ? Number(match[1]) : Number.NaN;
        if (Number.isNaN(pid) || !isProcessAlive(pid)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Another process may have cleaned it up first.
          }
          continue;
        }
      } catch {
        // Lock file disappeared between our open and read — retry.
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for repo lock: ${lockPath}`);
      }

      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        RETRY_INTERVAL_MS,
      );
    }
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already removed — harmless.
  }
}

/**
 * Execute `fn` while holding an exclusive file lock at `lockPath`.
 * The lock is always released when `fn` returns or throws.
 */
export function withLock<T>(lockPath: string, fn: () => T): T {
  acquireLock(lockPath);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Return the lock-file path for a given owner/repo bare clone:
 * `~/.agentcoop/repos/{owner}/{repo}.lock`
 */
export function repoLockPath(owner: string, repo: string): string {
  return join(homedir(), ".agentcoop", "repos", owner, `${repo}.lock`);
}
