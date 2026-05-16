import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildGitNetworkEnv,
  GitNetworkTimeoutError,
  gitNetworkExec,
  hasCoreSshCommandConfigured,
  spawnWithGroupTimeout,
} from "./git-network.js";

// ---------------------------------------------------------------------------
// spawnWithGroupTimeout — timeout + process-group cleanup
// ---------------------------------------------------------------------------

describe("spawnWithGroupTimeout", () => {
  test("returns timedOut=true within the deadline for a hanging child", () => {
    const start = Date.now();
    const result = spawnWithGroupTimeout("/bin/sh", ["-c", "sleep 30"], {
      timeoutMs: 500,
    });
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    // Allow generous slack for slow CI; the key invariant is that
    // the call returns rather than blocking for the full 30s.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("returns stdout and status=0 on success", () => {
    const result = spawnWithGroupTimeout("/bin/sh", ["-c", "echo hello"], {
      timeoutMs: 5_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  test("returns non-zero status on command failure without throwing", () => {
    const result = spawnWithGroupTimeout("/bin/sh", ["-c", "exit 3"], {
      timeoutMs: 5_000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(3);
  });

  test("leaves no descendant processes after a timeout", () => {
    // Use a shell that backgrounds a long-lived child whose pid we can
    // probe afterwards.  The wrapper must propagate SIGKILL to the
    // process group so this grandchild does not outlive the call.
    const tmpDir = process.env.TMPDIR ?? "/tmp";
    const pidFile = `${tmpDir}/agentcoop-test-${process.pid}-${Date.now()}.pid`;

    const result = spawnWithGroupTimeout(
      "/bin/sh",
      [
        "-c",
        // Spawn a sleep, record its pid, then wait so the parent
        // shell itself also hangs until killed.
        `sleep 30 & echo $! > ${pidFile}; wait`,
      ],
      { timeoutMs: 500 },
    );
    expect(result.timedOut).toBe(true);

    // Give the kernel a brief moment to reap the killed descendants
    // before we probe.  This is observation-only — the kill itself is
    // synchronous, but `kill -0` may briefly see a process in the
    // dying state.
    spawnSync("/bin/sleep", ["0.2"]);

    const pid = Number.parseInt(
      spawnSync("/bin/cat", [pidFile], { encoding: "utf-8" }).stdout.trim(),
      10,
    );
    expect(Number.isFinite(pid)).toBe(true);

    // `kill -0` returns 0 if the process exists and we have permission
    // to signal it; non-zero otherwise.  We expect non-zero (gone).
    const probe = spawnSync("/bin/kill", ["-0", String(pid)], {
      stdio: "pipe",
    });
    expect(probe.status).not.toBe(0);

    spawnSync("/bin/rm", ["-f", pidFile]);
  });
});

// ---------------------------------------------------------------------------
// gitNetworkExec — env injection and timeout-error mapping
// ---------------------------------------------------------------------------

describe("gitNetworkExec", () => {
  test("GitNetworkTimeoutError extends Error", () => {
    const err = new GitNetworkTimeoutError(["fetch", "--all"], 1000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GitNetworkTimeoutError");
    expect(err.timeoutMs).toBe(1000);
  });

  test("throws a generic Error with stderr on non-zero git exit", () => {
    expect(() =>
      gitNetworkExec(["fetch", "--this-flag-does-not-exist"], {
        timeoutMs: 10_000,
      }),
    ).toThrow();
  });

  test("maps spawn-level timeout to GitNetworkTimeoutError", () => {
    // Aim git at a TCP black-hole address (RFC 5737 TEST-NET-1) with
    // a tight timeout so the only reachable outcome is timeout.  Use
    // a unique destination so re-runs do not collide with a leftover
    // directory from a prior aborted run.
    const tmpDir = process.env.TMPDIR ?? "/tmp";
    const dest = `${tmpDir}/agentcoop-timeout-${process.pid}-${Date.now()}`;
    try {
      expect(() =>
        gitNetworkExec(["clone", "git://192.0.2.1/x.git", dest], {
          timeoutMs: 500,
        }),
      ).toThrow(GitNetworkTimeoutError);
    } finally {
      spawnSync("/bin/rm", ["-rf", dest]);
    }
  });
});

// ---------------------------------------------------------------------------
// buildGitNetworkEnv — SSH keepalive injection precedence
// ---------------------------------------------------------------------------

describe("buildGitNetworkEnv", () => {
  test("injects GIT_SSH_COMMAND with keepalive when neither var is set", () => {
    const env = buildGitNetworkEnv({ PATH: "/bin" });
    expect(env.GIT_SSH_COMMAND).toContain("ServerAliveInterval=15");
    expect(env.GIT_SSH_COMMAND).toContain("ServerAliveCountMax=4");
    expect(env.GIT_SSH).toBeUndefined();
  });

  test("preserves an existing GIT_SSH_COMMAND", () => {
    const env = buildGitNetworkEnv({
      PATH: "/bin",
      GIT_SSH_COMMAND: "ssh -i ~/.ssh/work",
    });
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i ~/.ssh/work");
  });

  test("does not synthesize GIT_SSH_COMMAND when GIT_SSH is set", () => {
    // Otherwise our injected GIT_SSH_COMMAND would take precedence
    // over the user's GIT_SSH wrapper and silently drop their custom
    // SSH transport.
    const env = buildGitNetworkEnv({
      PATH: "/bin",
      GIT_SSH: "/usr/local/bin/ssh-wrapper",
    });
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_SSH).toBe("/usr/local/bin/ssh-wrapper");
  });

  test("preserves GIT_SSH_COMMAND when both vars are set", () => {
    const env = buildGitNetworkEnv({
      PATH: "/bin",
      GIT_SSH_COMMAND: "ssh -F /etc/ssh/work_config",
      GIT_SSH: "/usr/local/bin/ssh-wrapper",
    });
    expect(env.GIT_SSH_COMMAND).toBe("ssh -F /etc/ssh/work_config");
    expect(env.GIT_SSH).toBe("/usr/local/bin/ssh-wrapper");
  });

  test("does not synthesize GIT_SSH_COMMAND when core.sshCommand is configured", () => {
    // Otherwise our injected GIT_SSH_COMMAND would take precedence
    // over a user's `git config core.sshCommand` and silently drop
    // their custom SSH transport (proxy command, work key, etc.).
    const env = buildGitNetworkEnv({ PATH: "/bin" }, true);
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hasCoreSshCommandConfigured — git config probe
// ---------------------------------------------------------------------------

describe("hasCoreSshCommandConfigured", () => {
  test("reports true when core.sshCommand is set in the repo", () => {
    // Build a throw-away repo with a local `core.sshCommand`, probe
    // it, and assert the probe sees it.  Uses --file rather than
    // --local so we don't need a real `git init` (avoids relying on
    // git being able to initialize anywhere under tmp).
    const dir = mkdtempSync(join(tmpdir(), "agentcoop-sshcmd-"));
    try {
      // `git config --get` walks up to find a repo; create the
      // minimal marker so the probe runs in repo scope.
      spawnSync("git", ["init", "-q"], { cwd: dir });
      spawnSync(
        "git",
        ["config", "--local", "core.sshCommand", "ssh -i ~/.ssh/work_key"],
        { cwd: dir },
      );
      expect(hasCoreSshCommandConfigured(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports false when core.sshCommand is not set", () => {
    // Isolate from the host's system/global git config so the probe
    // cannot pick up a real `core.sshCommand` defined in CI.
    const dir = mkdtempSync(join(tmpdir(), "agentcoop-sshcmd-none-"));
    const emptyConfig = join(dir, "empty.gitconfig");
    writeFileSync(emptyConfig, "");
    const restore: Array<[string, string | undefined]> = [
      ["GIT_CONFIG_NOSYSTEM", process.env.GIT_CONFIG_NOSYSTEM],
      ["GIT_CONFIG_GLOBAL", process.env.GIT_CONFIG_GLOBAL],
    ];
    try {
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      process.env.GIT_CONFIG_GLOBAL = emptyConfig;
      expect(hasCoreSshCommandConfigured(dir)).toBe(false);
    } finally {
      for (const [k, v] of restore) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
