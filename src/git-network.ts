/**
 * Synchronous git invocations that touch the network (clone/fetch).
 *
 * `execFileSync` has no facility for either bounding the wait or
 * tearing down descendants if the immediate child times out.  When
 * the OpenSSH connection dies silently (e.g. after host sleep) git's
 * underlying ssh child can wait indefinitely for bytes that will
 * never arrive, hanging the originating dispatch.
 *
 * This module wraps every network-touching git call in two
 * complementary safeguards:
 *
 *  1. **SSH keepalive.**  `GIT_SSH_COMMAND` is injected with
 *     `ServerAliveInterval=15` / `ServerAliveCountMax=4`, bounding
 *     dead-TCP detection at the SSH layer to roughly 60s.
 *
 *  2. **Spawn-level timeout with process-group kill.**  The child
 *     starts in its own process group (`detached: true`) so that on
 *     timeout we can SIGKILL the whole group, reaping any ssh child
 *     that would otherwise outlive its parent.
 */

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { t } from "./i18n/index.js";

const SSH_KEEPALIVE_CMD =
  "ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=4";

/** Default timeout for `git fetch`, `git ls-remote`, and similar. */
export const DEFAULT_FETCH_TIMEOUT_MS = 90_000;

/** Default timeout for `git clone`, which can be slow on large repos. */
export const DEFAULT_CLONE_TIMEOUT_MS = 5 * 60_000;

export interface GitNetworkExecOptions {
  cwd?: string;
  /** Per-call timeout override.  Defaults to {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Thrown when a git network call exceeds its timeout.  Distinguished
 * from generic failures so callers can surface an actionable message
 * instead of treating the run as a transient git error.
 */
export class GitNetworkTimeoutError extends Error {
  readonly args: readonly string[];
  readonly timeoutMs: number;

  constructor(args: readonly string[], timeoutMs: number) {
    super(
      t()["worktree.gitNetworkTimeout"](
        args.join(" "),
        Math.round(timeoutMs / 1000),
      ),
    );
    this.name = "GitNetworkTimeoutError";
    this.args = args;
    this.timeoutMs = timeoutMs;
  }
}

interface GroupSpawnResult {
  stdout: string;
  stderr: string;
  status: number;
  timedOut: boolean;
}

interface GroupSpawnOptions {
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run `command` synchronously inside a fresh POSIX process group,
 * bounded by `timeoutMs`.  Exported for testing only; production code
 * goes through {@link gitNetworkExec}.
 *
 * On timeout the child is killed and we additionally signal the whole
 * process group, ensuring grandchildren (e.g. ssh spawned by git) do
 * not outlive the call.
 */
export function spawnWithGroupTimeout(
  command: string,
  args: readonly string[],
  options: GroupSpawnOptions,
): GroupSpawnResult {
  // `detached: true` is honoured by spawnSync at runtime (it forwards
  // to the same libuv path as spawn) but is missing from
  // SpawnSyncOptions in @types/node, so the cast is required.
  const spawnOpts: SpawnSyncOptions & { detached: boolean } = {
    cwd: options.cwd,
    encoding: "utf-8",
    stdio: "pipe",
    detached: true,
    env: options.env ?? process.env,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  };
  const result = spawnSync(
    command,
    args as string[],
    spawnOpts as SpawnSyncOptions,
  );

  if (typeof result.pid === "number" && result.pid > 0) {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch {
      // Group already empty.
    }
  }

  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";

  if (result.error && !timedOut) {
    throw result.error;
  }

  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    status: typeof result.status === "number" ? result.status : -1,
    timedOut,
  };
}

/**
 * Run `git <args>` synchronously with SSH keepalive and a hard
 * timeout.  Returns stdout on success; throws
 * {@link GitNetworkTimeoutError} on timeout or a generic `Error`
 * containing stderr on any other non-zero exit.
 */
/**
 * Build the env passed to a git network spawn.  Exported for
 * testing.
 *
 * Git's SSH-transport precedence is:
 *   1. `GIT_SSH_COMMAND`
 *   2. `core.sshCommand`
 *   3. `GIT_SSH`
 *
 * Injecting `GIT_SSH_COMMAND` unconditionally would silently
 * override an existing `GIT_SSH` wrapper or a configured
 * `core.sshCommand` (proxy command, key selection, enterprise SSH
 * setup, etc.).  We therefore synthesize the keepalive command
 * only when none of `GIT_SSH_COMMAND`, `GIT_SSH`, or
 * `core.sshCommand` is already configured.  When any of those is
 * present the spawn-level timeout still bounds dead-TCP hangs, so
 * we lose only the SSH keepalive layer — not the structural fix.
 *
 * `coreSshCommandConfigured` lets the caller report a probed
 * `core.sshCommand` value (scoped by the spawn's `cwd`); pass
 * `false` when no probe was performed.
 */
export function buildGitNetworkEnv(
  source: NodeJS.ProcessEnv = process.env,
  coreSshCommandConfigured = false,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH && !coreSshCommandConfigured) {
    env.GIT_SSH_COMMAND = SSH_KEEPALIVE_CMD;
  }
  return env;
}

/**
 * Return true if `core.sshCommand` is set in any scope visible
 * from `cwd` (local + global + system when `cwd` is inside a repo,
 * global + system otherwise).
 *
 * Exported for testing.  A failure to invoke `git` here is treated
 * as "not configured" — falling back to keepalive injection is the
 * safer default since the alternative is the indefinite-hang bug
 * this module exists to prevent.
 */
export function hasCoreSshCommandConfigured(cwd?: string): boolean {
  try {
    const probe = spawnSync("git", ["config", "--get", "core.sshCommand"], {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    } as SpawnSyncOptions);
    return (
      probe.status === 0 &&
      typeof probe.stdout === "string" &&
      probe.stdout.trim() !== ""
    );
  } catch {
    return false;
  }
}

export function gitNetworkExec(
  args: readonly string[],
  options: GitNetworkExecOptions = {},
): string {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const env = buildGitNetworkEnv(
    process.env,
    hasCoreSshCommandConfigured(options.cwd),
  );

  const result = spawnWithGroupTimeout("git", args, {
    cwd: options.cwd,
    timeoutMs,
    env,
  });

  if (result.timedOut) {
    throw new GitNetworkTimeoutError(args, timeoutMs);
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      stderr || `git ${args.join(" ")} exited with status ${result.status}`,
    );
  }
  return result.stdout;
}
