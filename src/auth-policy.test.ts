import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const tmpHome = join(import.meta.dirname, "..", ".tmp-auth-policy-home");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

const {
  buildChildEnv,
  detectedAuthEnvVars,
  precheckClaudeOAuth,
  precheckCodexOAuth,
  resolveAuthPolicyForRun,
  CLAUDE_AUTH_ENV_VARS,
  CODEX_AUTH_ENV_VARS,
} = await import("./auth-policy.js");

describe("buildChildEnv", () => {
  test("env mode returns env unchanged", () => {
    const base = {
      ANTHROPIC_API_KEY: "sk-ant-1",
      OPENAI_API_KEY: "sk-1",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv;
    const out = buildChildEnv("claude", "env", base);
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-1");
    expect(out.OPENAI_API_KEY).toBe("sk-1");
  });

  test("oauth strips claude vars but leaves others", () => {
    const base = {
      ANTHROPIC_API_KEY: "sk-ant-1",
      ANTHROPIC_AUTH_TOKEN: "tok",
      OPENAI_API_KEY: "sk-1",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv;
    const out = buildChildEnv("claude", "oauth", base);
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBe("sk-1");
    expect(out.PATH).toBe("/usr/bin");
  });

  test("oauth strips codex vars but leaves others", () => {
    const base = {
      ANTHROPIC_API_KEY: "sk-ant-1",
      OPENAI_API_KEY: "sk-1",
      CODEX_API_KEY: "ck-1",
    } as NodeJS.ProcessEnv;
    const out = buildChildEnv("codex", "oauth", base);
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.CODEX_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-1");
  });

  test("oauth treats both env vars as auth-bearing for each cli", () => {
    expect(CLAUDE_AUTH_ENV_VARS).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ]);
    expect(CODEX_AUTH_ENV_VARS).toEqual(["OPENAI_API_KEY", "CODEX_API_KEY"]);
  });
});

describe("detectedAuthEnvVars", () => {
  test("ignores empty-string values", () => {
    const env = { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "tok" };
    expect(detectedAuthEnvVars("claude", env)).toEqual([
      "ANTHROPIC_AUTH_TOKEN",
    ]);
  });
});

describe("resolveAuthPolicyForRun", () => {
  test("forces oauth and skips prompt when no env vars are set", async () => {
    const promptAuthMode = vi.fn();
    const result = await resolveAuthPolicyForRun({
      cliSet: ["claude"],
      env: {},
      prompter: { promptAuthMode },
    });
    expect(promptAuthMode).not.toHaveBeenCalled();
    expect(result.effective).toEqual({ claude: "oauth" });
    expect(result.toPersist).toBeUndefined();
    expect(result.changed).toBe(false);
  });

  test("prompts when an env var is set, persists answer", async () => {
    const promptAuthMode = vi.fn().mockResolvedValue("oauth");
    const result = await resolveAuthPolicyForRun({
      cliSet: ["claude"],
      env: { ANTHROPIC_API_KEY: "sk-ant-1" },
      prompter: { promptAuthMode },
    });
    expect(promptAuthMode).toHaveBeenCalledWith({
      cli: "claude",
      detectedEnvVars: ["ANTHROPIC_API_KEY"],
      defaultMode: "env",
    });
    expect(result.effective).toEqual({ claude: "oauth" });
    expect(result.toPersist).toEqual({ claude: "oauth" });
    expect(result.changed).toBe(true);
  });

  test("preselects saved choice when prompting", async () => {
    const promptAuthMode = vi.fn().mockResolvedValue("oauth");
    await resolveAuthPolicyForRun({
      cliSet: ["claude"],
      env: { ANTHROPIC_AUTH_TOKEN: "tok" },
      savedPolicy: { claude: "oauth" },
      prompter: { promptAuthMode },
    });
    expect(promptAuthMode).toHaveBeenCalledWith(
      expect.objectContaining({ defaultMode: "oauth" }),
    );
  });

  test("does not overwrite a saved policy for a CLI not in the run", async () => {
    const promptAuthMode = vi.fn().mockResolvedValue("env");
    const result = await resolveAuthPolicyForRun({
      cliSet: ["claude"],
      env: { ANTHROPIC_API_KEY: "sk-ant-1" },
      savedPolicy: { codex: "oauth" },
      prompter: { promptAuthMode },
    });
    // codex (not in cliSet) is preserved.
    expect(result.toPersist).toEqual({ claude: "env", codex: "oauth" });
    // codex is not in the effective set because it is not in cliSet.
    expect(result.effective).toEqual({ claude: "env" });
  });

  test("does not persist when the prompt is skipped (env-var-less CLI)", async () => {
    // A run with codex only and no env var set; saved claude policy
    // must be preserved; codex must not be written.
    const promptAuthMode = vi.fn();
    const result = await resolveAuthPolicyForRun({
      cliSet: ["codex"],
      env: {},
      savedPolicy: { claude: "env" },
      prompter: { promptAuthMode },
    });
    expect(promptAuthMode).not.toHaveBeenCalled();
    expect(result.toPersist).toEqual({ claude: "env" });
    expect(result.changed).toBe(false);
    expect(result.effective).toEqual({ codex: "oauth" });
  });

  test("changed=false when answer matches saved", async () => {
    const promptAuthMode = vi.fn().mockResolvedValue("env");
    const result = await resolveAuthPolicyForRun({
      cliSet: ["claude"],
      env: { ANTHROPIC_API_KEY: "sk-1" },
      savedPolicy: { claude: "env" },
      prompter: { promptAuthMode },
    });
    expect(result.changed).toBe(false);
  });

  test("prompts once per unique CLI even when both agents share the CLI", async () => {
    const promptAuthMode = vi.fn().mockResolvedValue("env");
    await resolveAuthPolicyForRun({
      cliSet: ["claude"],
      env: { ANTHROPIC_API_KEY: "sk-1" },
      prompter: { promptAuthMode },
    });
    expect(promptAuthMode).toHaveBeenCalledTimes(1);
  });

  test("prompts for both CLIs when both have env vars set", async () => {
    const promptAuthMode = vi
      .fn()
      .mockResolvedValueOnce("env")
      .mockResolvedValueOnce("oauth");
    const result = await resolveAuthPolicyForRun({
      cliSet: ["claude", "codex"],
      env: { ANTHROPIC_API_KEY: "sk-1", CODEX_API_KEY: "ck-1" },
      prompter: { promptAuthMode },
    });
    expect(promptAuthMode).toHaveBeenCalledTimes(2);
    expect(result.toPersist).toEqual({ claude: "env", codex: "oauth" });
    expect(result.effective).toEqual({ claude: "env", codex: "oauth" });
  });
});

describe("precheckClaudeOAuth", () => {
  beforeEach(() => {
    mkdirSync(tmpHome, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("on macOS, skip pre-check (Keychain backed)", () => {
    const result = precheckClaudeOAuth({}, "darwin");
    expect(result.ok).toBe(true);
  });

  test("on Linux, fails when ~/.claude/.credentials.json missing", () => {
    const result = precheckClaudeOAuth({}, "linux");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(".credentials.json");
    expect(result.reason).toContain("claude login");
  });

  test("on Linux, succeeds when credentials file present", () => {
    const dir = join(tmpHome, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), "{}");
    const result = precheckClaudeOAuth({}, "linux");
    expect(result.ok).toBe(true);
  });

  test("on Linux, honors CLAUDE_CONFIG_DIR override", () => {
    const dir = join(tmpHome, "custom-claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), "{}");
    const result = precheckClaudeOAuth({ CLAUDE_CONFIG_DIR: dir }, "linux");
    expect(result.ok).toBe(true);
  });
});

describe("precheckCodexOAuth", () => {
  test("invokes the probe with codex env vars stripped", () => {
    const probe = vi.fn().mockReturnValue({
      status: 0,
      stdout: "Logged in as foo@example.com",
      stderr: "",
    });
    const result = precheckCodexOAuth(
      {
        OPENAI_API_KEY: "sk-stale",
        CODEX_API_KEY: "ck-stale",
        PATH: "/usr/bin",
      },
      probe,
    );
    expect(result.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    const env = probe.mock.calls[0][0] as NodeJS.ProcessEnv;
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("treats non-zero exit as missing credentials", () => {
    const probe = vi.fn().mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "not logged in",
    });
    const result = precheckCodexOAuth({}, probe);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("codex login");
  });

  test('treats "not logged in" stdout/stderr as missing credentials even on exit 0', () => {
    const probe = vi.fn().mockReturnValue({
      status: 0,
      stdout: "Not logged in",
      stderr: "",
    });
    const result = precheckCodexOAuth({}, probe);
    expect(result.ok).toBe(false);
  });

  test("ENOENT (codex CLI missing) reports actionable message", () => {
    const err = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    const probe = vi.fn().mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: err,
    });
    const result = precheckCodexOAuth({}, probe);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("codex CLI not found");
  });
});
