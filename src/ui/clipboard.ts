/**
 * System-clipboard writer used by the merge-confirm screen hotkeys.
 *
 * Detects which mechanisms are usable in the current environment and
 * returns an ordered candidate list.  The writer iterates the list in
 * order and reports `"ok"` as soon as one candidate succeeds.
 *
 * See issue #265 for the full ordering policy.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

/**
 * A clipboard-write mechanism.  `osc52` rides the controlling
 * terminal's escape stream; the others shell out to a native tool on
 * the local machine.
 */
export type ClipboardCandidate = "pbcopy" | "wl-copy" | "xclip" | "osc52";

/**
 * Environment facts consulted by {@link detectClipboardSupport}.
 * Factored out so tests can inject a fixed view without monkey-patching
 * `process` or the filesystem.
 */
export interface ClipboardEnvironment {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  stdoutIsTTY: boolean;
  /** Returns `true` when the given command is reachable on PATH. */
  hasCommand: (cmd: string) => boolean;
}

function defaultHasCommand(cmd: string): boolean {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;
  const pathExt =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of pathExt) {
      try {
        accessSync(path.join(dir, cmd + ext), fsConstants.X_OK);
        return true;
      } catch {
        // try next
      }
    }
  }
  return false;
}

/**
 * Snapshot the current process environment for clipboard detection.
 * Returns a fresh object each call — cheap, and keeps
 * {@link detectClipboardSupport} free of implicit globals.
 */
export function currentClipboardEnvironment(): ClipboardEnvironment {
  return {
    platform: process.platform,
    env: { ...process.env },
    stdoutIsTTY: !!process.stdout.isTTY,
    hasCommand: defaultHasCommand,
  };
}

/**
 * Classify the environment and return the ordered list of clipboard
 * candidates to try.  An empty list means clipboard writes are not
 * supported here.
 *
 * Ordering:
 * - SSH session — OSC 52 first (the user's local terminal), then any
 *   available native tool as a last resort.
 * - Local session — platform-native tool first, OSC 52 as fallback.
 */
export function detectClipboardSupport(
  environment: ClipboardEnvironment = currentClipboardEnvironment(),
): ClipboardCandidate[] {
  const { platform, env, stdoutIsTTY, hasCommand } = environment;
  const isSsh = !!(env.SSH_TTY || env.SSH_CONNECTION);
  const osc52: ClipboardCandidate[] = stdoutIsTTY ? ["osc52"] : [];
  const native: ClipboardCandidate[] = [];

  if (platform === "darwin") {
    // `pbcopy` ships with macOS at `/usr/bin/pbcopy` and is always
    // available on a stock system.  PATH inspection is imperfect (a
    // stripped PATH can miss `/usr/bin`), so treat darwin as an
    // unconditional native candidate to avoid silently downgrading to
    // best-effort OSC 52 — or to `[]` when stdout is redirected —
    // when the deterministic path would still work.
    native.push("pbcopy");
  } else if (platform === "linux") {
    if (env.WAYLAND_DISPLAY && hasCommand("wl-copy")) {
      native.push("wl-copy");
    } else if (env.DISPLAY && hasCommand("xclip")) {
      native.push("xclip");
    }
  }

  if (isSsh) {
    return [...osc52, ...native];
  }
  return [...native, ...osc52];
}

/**
 * Encode `value` as an OSC 52 clipboard-set escape sequence.
 *
 * Format: `ESC ] 52 ; c ; <base64 of UTF-8 value> BEL`.
 * Exported for unit tests.
 */
export function encodeOsc52(value: string): string {
  const payload = Buffer.from(value, "utf8").toString("base64");
  return `\x1b]52;c;${payload}\x07`;
}

type SpawnSync = typeof spawnSync;
type WriteToStdout = (chunk: string) => boolean;

/**
 * Injection points for {@link writeToClipboard}.  Production callers
 * omit this argument; tests pass mocks.
 */
export interface ClipboardWriterDeps {
  spawnSync?: SpawnSync;
  stdoutWrite?: WriteToStdout;
}

/**
 * Try each candidate in order.  Returns `"ok"` as soon as one
 * succeeds, `"error"` only when every candidate fails.  Never throws.
 *
 * - Native tool: success = `spawnSync` returns exit status 0 within
 *   the timeout.  Any non-zero exit, timeout, or spawn error falls
 *   through to the next candidate.
 * - OSC 52: success = `process.stdout.write` returned without
 *   throwing.  A silent-ignore terminal is indistinguishable from
 *   success at the protocol level.
 */
export async function writeToClipboard(
  value: string,
  candidates: ClipboardCandidate[],
  deps: ClipboardWriterDeps = {},
): Promise<"ok" | "error"> {
  const spawn = deps.spawnSync ?? spawnSync;
  const write =
    deps.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));

  for (const candidate of candidates) {
    if (candidate === "osc52") {
      try {
        write(encodeOsc52(value));
        return "ok";
      } catch {
        continue;
      }
    }
    const argv = nativeArgv(candidate);
    if (!argv) continue;
    try {
      const result = spawn(argv[0], argv.slice(1), {
        input: value,
        timeout: 1000,
        encoding: "utf8",
      });
      if (result.error) continue;
      if (result.signal) continue;
      if (result.status === 0) return "ok";
    } catch {}
  }
  return "error";
}

function nativeArgv(candidate: ClipboardCandidate): string[] | null {
  switch (candidate) {
    case "pbcopy":
      // Bypass PATH: `pbcopy` is a stock macOS binary at a fixed
      // location, and `detectClipboardSupport` enqueues it
      // unconditionally on darwin.  Using the absolute path keeps the
      // stripped-PATH case (e.g. PATH missing `/usr/bin`) reachable —
      // bare `spawnSync("pbcopy", …)` would ENOENT there even though
      // the binary is present.
      return ["/usr/bin/pbcopy"];
    case "wl-copy":
      return ["wl-copy"];
    case "xclip":
      return ["xclip", "-selection", "clipboard"];
    default:
      return null;
  }
}
