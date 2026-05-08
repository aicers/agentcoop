import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * Authentication mode for an agent CLI child process.
 *
 * - `env` keeps the relevant API-key environment variables in the
 *   child's environment, so the CLI uses the user's API key.
 * - `oauth` strips those variables from the child's environment,
 *   forcing the CLI to fall back to its stored login credentials.
 */
export type AuthMode = "env" | "oauth";

export type CliKind = "claude" | "codex";

export interface AuthPolicy {
  claude?: AuthMode;
  codex?: AuthMode;
}

/**
 * Auth-bearing environment variables for each CLI.  When ANY of these
 * is set in the parent shell, AgentCoop must prompt the user to choose
 * between API-key mode and OAuth.  When `oauth` is selected, ALL of
 * these are stripped from the spawned child's env.
 */
export const CLAUDE_AUTH_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

export const CODEX_AUTH_ENV_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;

export function authEnvVarsFor(cli: CliKind): readonly string[] {
  return cli === "claude" ? CLAUDE_AUTH_ENV_VARS : CODEX_AUTH_ENV_VARS;
}

/** Names of auth-bearing env vars that are present in `env`. */
export function detectedAuthEnvVars(
  cli: CliKind,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return authEnvVarsFor(cli).filter((name) => {
    const v = env[name];
    return typeof v === "string" && v.length > 0;
  });
}

/**
 * Build the env object passed to a child process based on the auth
 * policy for that CLI.  When `oauth`, copies `baseEnv` and removes the
 * auth-bearing keys; otherwise returns a shallow copy of `baseEnv`.
 *
 * `baseEnv` is injectable so tests do not need to monkey-patch
 * `process.env`.
 */
export function buildChildEnv(
  cli: CliKind,
  mode: AuthMode,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (mode === "oauth") {
    for (const name of authEnvVarsFor(cli)) {
      delete env[name];
    }
  }
  return env;
}

export interface AuthPrompter {
  /**
   * Show an env-vs-oauth choice for the given CLI.
   *
   * The implementation must label the `env` option with whichever of
   * the auth-bearing env vars are actually detected (so the user can
   * see which keys are about to be passed through or stripped).
   */
  promptAuthMode(opts: {
    cli: CliKind;
    detectedEnvVars: readonly string[];
    defaultMode: AuthMode;
  }): Promise<AuthMode>;
}

export interface ResolveAuthPolicyInput {
  /** CLIs that will actually be spawned this run (deduplicated). */
  cliSet: readonly CliKind[];
  /** Previously persisted policy, if any. */
  savedPolicy?: AuthPolicy | undefined;
  /** Source of env vars (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Async prompter; only invoked when an auth-bearing env var is set. */
  prompter: AuthPrompter;
}

export interface ResolvedAuthPolicy {
  /** Effective per-CLI mode for the current run (always present per CLI in `cliSet`). */
  effective: { claude?: AuthMode; codex?: AuthMode };
  /**
   * The merged policy to persist to `~/.agentcoop/config.json`.
   *
   * Preserves saved values for CLIs not in `cliSet` and only writes a
   * subfield when the user actually answered a prompt.  When the
   * prompt is skipped (no auth env vars present), the saved value for
   * that CLI is left untouched — i.e. NOT overwritten with `oauth`.
   */
  toPersist: AuthPolicy | undefined;
  /** True when `toPersist` differs from `savedPolicy`. */
  changed: boolean;
}

/**
 * Pure decision helper: derive the per-run auth policy from the saved
 * config, the parent env, and a prompter.
 *
 * Behavior per CLI in `cliSet`:
 * - If none of that CLI's auth-bearing env vars are set, force `oauth`
 *   for the run and do NOT persist (so a saved value for the CLI is
 *   preserved across runs).
 * - Otherwise prompt with the saved choice (or `env`) preselected, and
 *   persist the answer.
 */
export async function resolveAuthPolicyForRun(
  input: ResolveAuthPolicyInput,
): Promise<ResolvedAuthPolicy> {
  const env = input.env ?? process.env;
  const saved = input.savedPolicy ?? {};
  const effective: { claude?: AuthMode; codex?: AuthMode } = {};
  const persisted: AuthPolicy = { ...saved };
  let changed = false;

  for (const cli of input.cliSet) {
    const detected = detectedAuthEnvVars(cli, env);
    if (detected.length === 0) {
      effective[cli] = "oauth";
      continue;
    }

    const defaultMode: AuthMode = saved[cli] ?? "env";
    const chosen = await input.prompter.promptAuthMode({
      cli,
      detectedEnvVars: detected,
      defaultMode,
    });

    effective[cli] = chosen;
    if (persisted[cli] !== chosen) {
      persisted[cli] = chosen;
      changed = true;
    }
  }

  const hasAny =
    persisted.claude !== undefined || persisted.codex !== undefined;
  return {
    effective,
    toPersist: hasAny ? persisted : undefined,
    changed,
  };
}

export interface OAuthPrecheckResult {
  ok: boolean;
  /** When `ok` is false, a short explanation suitable for printing. */
  reason?: string;
}

/**
 * Verify that login credentials exist for `claude` on the current OS.
 *
 * Linux: file under `$CLAUDE_CONFIG_DIR/.credentials.json` or
 *   `~/.claude/.credentials.json`.
 * macOS: credentials live in the system Keychain — skip the check and
 *   let the spawned `claude` process surface its own error if needed.
 */
export function precheckClaudeOAuth(
  env: NodeJS.ProcessEnv = process.env,
  os: NodeJS.Platform = platform(),
): OAuthPrecheckResult {
  if (os === "darwin") {
    return { ok: true };
  }
  const dir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const credPath = join(dir, ".credentials.json");
  if (existsSync(credPath)) return { ok: true };
  return {
    ok: false,
    reason: `Claude OAuth credentials not found at ${credPath}. Please run \`claude login\` first, then re-launch agentcoop.`,
  };
}

export type CodexProbeRunner = (env: NodeJS.ProcessEnv) => {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
};

/**
 * Default Codex login-status probe: invokes `codex login status` with
 * the supplied env (caller is responsible for stripping auth env vars).
 */
export const defaultCodexProbe: CodexProbeRunner = (env) => {
  const result = spawnSync("codex", ["login", "status"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error as NodeJS.ErrnoException | undefined,
  };
};

/**
 * Verify that Codex has stored login credentials.
 *
 * The probe MUST run with `OPENAI_API_KEY` and `CODEX_API_KEY`
 * stripped from the env, so a stale API key in the parent shell does
 * not produce a false-positive "logged in" response.
 *
 * The probe is injectable for tests.
 */
export function precheckCodexOAuth(
  baseEnv: NodeJS.ProcessEnv = process.env,
  probe: CodexProbeRunner = defaultCodexProbe,
): OAuthPrecheckResult {
  const env = buildChildEnv("codex", "oauth", baseEnv);
  let res: ReturnType<CodexProbeRunner>;
  try {
    res = probe(env);
  } catch (err) {
    return {
      ok: false,
      reason: `Codex login-status probe failed: ${(err as Error).message}`,
    };
  }
  if (res.error?.code === "ENOENT") {
    return {
      ok: false,
      reason:
        "codex CLI not found on PATH. Install Codex and run `codex login`.",
    };
  }
  if (res.status === 0) {
    const combined = `${res.stdout}\n${res.stderr}`.toLowerCase();
    if (
      combined.includes("not logged in") ||
      combined.includes("not signed in") ||
      combined.includes("no credentials")
    ) {
      return {
        ok: false,
        reason:
          "Codex OAuth credentials not found. Please run `codex login` first, then re-launch agentcoop.",
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      "Codex OAuth credentials not found. Please run `codex login` first, then re-launch agentcoop.",
  };
}

export function runOAuthPrechecks(
  effective: { claude?: AuthMode; codex?: AuthMode },
  baseEnv: NodeJS.ProcessEnv = process.env,
  os: NodeJS.Platform = platform(),
  codexProbe: CodexProbeRunner = defaultCodexProbe,
): OAuthPrecheckResult[] {
  const results: OAuthPrecheckResult[] = [];
  if (effective.claude === "oauth") {
    results.push(precheckClaudeOAuth(baseEnv, os));
  }
  if (effective.codex === "oauth") {
    results.push(precheckCodexOAuth(baseEnv, codexProbe));
  }
  return results;
}
