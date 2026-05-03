/**
 * Centralized `gh` CLI invocation.
 *
 * `execFileSync` defaults `maxBuffer` to 1 MiB; `gh` calls that fetch
 * CI logs, PR comments, or check annotations easily exceed that, and
 * the resulting `ENOBUFS` is deterministic — retrying does not help.
 * Routing every `gh` call through this helper guarantees a generous
 * cap (64 MiB, applied to stdout AND stderr) and ensures `encoding`
 * and `stdio` cannot be weakened by callers.
 */

import { type ExecFileSyncOptions, execFileSync } from "node:child_process";

/**
 * Maximum bytes captured from `gh`'s stdout/stderr per call.
 *
 * The cap is intentionally generous so that long CI failure logs and
 * heavy PR/comment listings do not trip ENOBUFS.  Bump if a real
 * payload approaches the limit; do not lower without checking the
 * call sites in `ci.ts`, `pr-comments.ts`, etc.
 */
const GH_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Options accepted by {@link ghExec}.  `encoding`, `maxBuffer`, and
 * `stdio` are owned by the helper so callers cannot weaken the
 * guarantees that the return value is a string and that capture is
 * large enough for `gh` payloads.
 */
export type GhExecOptions = Omit<
  ExecFileSyncOptions,
  "encoding" | "maxBuffer" | "stdio"
>;

/**
 * Invoke `gh` with the given args, returning stdout as a string.
 *
 * The `maxBuffer` cap applies to stdout AND stderr — commands that
 * stream long progress to stderr (e.g. `gh run watch`) must stay
 * within the same budget.
 *
 * On failure the original error is rethrown with the offending args
 * prepended to its message so the next ENOBUFS (or other spawn
 * failure) points straight at the call site.
 */
export function ghExec(args: string[], options: GhExecOptions = {}): string {
  try {
    return execFileSync("gh", args, {
      ...options,
      encoding: "utf-8",
      maxBuffer: GH_MAX_BUFFER,
      // Capture stderr so a noisy progress stream cannot leak to the
      // user's terminal, and so the maxBuffer cap applies to it too.
      stdio: "pipe",
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    e.message = `gh ${args.join(" ")}: ${e.message}`;
    throw e;
  }
}
