import { homedir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import type { Config } from "./config.js";
import {
  checkCliVersion,
  compareVersions,
  detectCodexSource,
  detectInstallSource,
  parseVersion,
  refreshAgentCliVersion,
  resolveLatestVersion,
  runStartupVersionCheck,
  shouldRunVersionCheck,
  VersionCheckAbortError,
  type VersionCheckDeps,
  type VersionCheckPrompts,
  type VersionCheckTranslations,
} from "./version-check.js";

// ---- parseVersion --------------------------------------------------------

describe("parseVersion", () => {
  test("extracts x.y.z from plain output", () => {
    expect(parseVersion("1.2.3")).toBe("1.2.3");
  });

  test("extracts from 'codex-cli 0.46.0' style", () => {
    expect(parseVersion("codex-cli 0.46.0\n")).toBe("0.46.0");
  });

  test("extracts from '1.2.3 (Claude Code)' style", () => {
    expect(parseVersion("1.2.3 (Claude Code)")).toBe("1.2.3");
  });

  test("keeps pre-release suffix", () => {
    expect(parseVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });

  test("strips leading v by *not* capturing it", () => {
    expect(parseVersion("v1.2.3")).toBe("1.2.3");
  });

  test("returns undefined for un-versioned strings", () => {
    expect(parseVersion("nothing useful here")).toBeUndefined();
  });
});

// ---- compareVersions -----------------------------------------------------

describe("compareVersions", () => {
  test("returns -1 when a < b", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.2.3", "1.3.0")).toBe(-1);
    expect(compareVersions("1.9.9", "2.0.0")).toBe(-1);
  });

  test("returns 0 when equal", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  test("returns 1 when a > b", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  test("treats missing segment as 0", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.2")).toBe(0);
  });

  test("release > pre-release of the same base", () => {
    expect(compareVersions("1.2.3", "1.2.3-beta")).toBe(1);
    expect(compareVersions("1.2.3-beta", "1.2.3")).toBe(-1);
  });
});

// ---- detectCodexSource ---------------------------------------------------

describe("detectCodexSource", () => {
  test("npm global prefix", () => {
    expect(
      detectCodexSource(
        "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
      ),
    ).toEqual({ kind: "npm", registryPackage: "@openai/codex" });
    expect(
      detectCodexSource(
        "/Users/user/.nvm/versions/node/v24.0.0/lib/node_modules/@openai/codex/bin/codex",
      ),
    ).toEqual({ kind: "npm", registryPackage: "@openai/codex" });
  });

  test("pnpm global layout resolves to npm", () => {
    // `pnpm add -g @openai/codex` installs under `pnpm/global/<store>/
    // node_modules/@openai/codex/...` — no `lib/` segment — so the
    // `lib/node_modules/` marker alone misses it.  The `/pnpm/global/`
    // segment is unique to the global install (project-local pnpm uses
    // `<repo>/node_modules/.pnpm/...` with no `global`), so this is
    // safe against the project-local false positive.
    //
    // Exercise the cross-platform global roots that `pnpm root -g`
    // returns in practice:
    //   macOS:   ~/Library/pnpm/global/<N>/node_modules
    //   Linux:   ~/.local/share/pnpm/global/<N>/node_modules
    //   Windows: %LOCALAPPDATA%/pnpm/global/<N>/node_modules
    //   $PNPM_HOME: $PNPM_HOME/global/<N>/node_modules
    expect(
      detectCodexSource(
        "/Users/sehkone/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js",
      ),
    ).toEqual({ kind: "npm", registryPackage: "@openai/codex" });
    expect(
      detectCodexSource(
        "/home/alice/.local/share/pnpm/global/5/node_modules/@openai/codex/bin/codex.js",
      ),
    ).toEqual({ kind: "npm", registryPackage: "@openai/codex" });
    expect(
      detectCodexSource(
        "/Users/me/.pnpm-home/pnpm/global/5/node_modules/@openai/codex/bin/codex.js",
      ),
    ).toEqual({ kind: "npm", registryPackage: "@openai/codex" });
    // realpath resolution through the `.pnpm` virtual store still
    // keeps the path under `pnpm/global/<N>/node_modules/...`.
    expect(
      detectCodexSource(
        "/Users/sehkone/Library/pnpm/global/5/node_modules/.pnpm/@openai+codex@0.46.0/node_modules/@openai/codex/bin/codex.js",
      ),
    ).toEqual({ kind: "npm", registryPackage: "@openai/codex" });
  });

  test("project-local pnpm is inconclusive, not guessed as pnpm global", () => {
    // A project using pnpm has `<repo>/node_modules/.pnpm/@openai+codex@<ver>/
    // node_modules/@openai/codex/...` — no `pnpm/global/` segment —
    // so the new pnpm-global marker must not match it.  Otherwise we
    // would reopen the very project-local false positive the
    // `lib/node_modules/` anchor was added to close.
    expect(
      detectCodexSource(
        "/Users/me/proj/node_modules/.pnpm/@openai+codex@0.46.0/node_modules/@openai/codex/bin/codex.js",
      ).kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource(
        "/worktree/node_modules/.pnpm/@openai+codex@0.46.0/node_modules/@openai/codex/bin/codex.js",
      ).kind,
    ).toBe("inconclusive");
  });

  test("project-local node_modules is inconclusive, not guessed as npm", () => {
    // A repo-local install lives at `<repo>/node_modules/@openai/codex/...`
    // — no `lib/` segment in front of `node_modules`.  `realpath(command -v
    // codex)` can resolve to that path via `node_modules/.bin/codex`, so
    // the marker `node_modules/@openai/codex/` alone is not enough — only
    // a global npm prefix (which always uses `lib/node_modules/...`)
    // should route to the npm registry.  Routing a project-local
    // dependency to the global update prompt would tell the user to
    // `npm install -g` a package they intentionally pinned per-project.
    expect(
      detectCodexSource("/worktree/node_modules/@openai/codex/bin/codex.js")
        .kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource(
        "/Users/me/proj/node_modules/@openai/codex/bin/codex.js",
      ).kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource("/tmp/sandbox/node_modules/@openai/codex/bin/codex.js")
        .kind,
    ).toBe("inconclusive");
  });

  test("Homebrew formula path", () => {
    expect(
      detectCodexSource("/opt/homebrew/Cellar/codex/0.46.0/bin/codex"),
    ).toEqual({ kind: "homebrew-formula", formula: "codex" });
    expect(
      detectCodexSource("/usr/local/Cellar/codex/0.46.0/bin/codex"),
    ).toEqual({ kind: "homebrew-formula", formula: "codex" });
    // Homebrew's supported default Linux prefix is
    // `/home/linuxbrew/.linuxbrew`, so a standard Linuxbrew install
    // must be recognized — otherwise a normal Linux install would fall
    // through to `inconclusive` and never get the update check.
    expect(
      detectCodexSource(
        "/home/linuxbrew/.linuxbrew/Cellar/codex/0.46.0/bin/codex",
      ),
    ).toEqual({ kind: "homebrew-formula", formula: "codex" });
  });

  test("Homebrew formula bundling node_modules resolves to formula, not npm", () => {
    // Some `codex` formulae bundle the JS distribution internally
    // under `libexec/lib/node_modules/@openai/codex/...`.  Even though
    // the resolved path contains the npm marker
    // (`node_modules/@openai/codex/`), it is still inside
    // `Cellar/codex/`, so the channel is the Homebrew formula —
    // formula and npm update independently and routing this to npm
    // would produce the wrong update prompt.
    expect(
      detectCodexSource(
        "/opt/homebrew/Cellar/codex/0.46.0/libexec/lib/node_modules/@openai/codex/bin/codex.js",
      ),
    ).toEqual({ kind: "homebrew-formula", formula: "codex" });
    expect(
      detectCodexSource(
        "/usr/local/Cellar/codex/0.46.0/libexec/lib/node_modules/@openai/codex/bin/codex.js",
      ),
    ).toEqual({ kind: "homebrew-formula", formula: "codex" });
    expect(
      detectCodexSource(
        "/home/linuxbrew/.linuxbrew/Cellar/codex/0.46.0/libexec/lib/node_modules/@openai/codex/bin/codex.js",
      ),
    ).toEqual({ kind: "homebrew-formula", formula: "codex" });
  });

  test("Homebrew cask path", () => {
    expect(
      detectCodexSource("/opt/homebrew/Caskroom/codex/0.122.0/codex"),
    ).toEqual({ kind: "homebrew-cask", cask: "codex" });
    expect(
      detectCodexSource("/usr/local/Caskroom/codex/0.122.0/codex"),
    ).toEqual({ kind: "homebrew-cask", cask: "codex" });
    expect(
      detectCodexSource(
        "/home/linuxbrew/.linuxbrew/Caskroom/codex/0.122.0/codex",
      ),
    ).toEqual({ kind: "homebrew-cask", cask: "codex" });
  });

  test("custom Homebrew formula (not codex) is inconclusive, not guessed", () => {
    // Brew stores each formula's files at
    // `<prefix>/Cellar/<formula-name>/<version>/...`.  A custom
    // wrapper formula like `my-codex-wrapper` must not be classified
    // as the official `codex` formula — a wrong update prompt is
    // worse than no prompt.
    expect(
      detectCodexSource("/opt/homebrew/Cellar/my-codex-wrapper/1.0/bin/codex")
        .kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource("/usr/local/Cellar/codex-extras/0.1.0/bin/codex").kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource(
        "/home/linuxbrew/.linuxbrew/Cellar/not-codex/1.0/bin/codex",
      ).kind,
    ).toBe("inconclusive");
  });

  test("custom Homebrew cask (not codex) is inconclusive, not guessed", () => {
    // Casks live at `<prefix>/Caskroom/<cask-name>/<version>/...`.
    // A custom cask like `custom-codex` must not be classified as the
    // official `codex` cask.
    expect(
      detectCodexSource("/opt/homebrew/Caskroom/custom-codex/1.0/codex").kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource("/usr/local/Caskroom/codex-preview/0.1/codex").kind,
    ).toBe("inconclusive");
  });

  test("prefixed Homebrew lookalikes are inconclusive, not guessed", () => {
    // A hand-placed binary under a copied tree like
    // `/tmp/opt/homebrew/Cellar/codex/...` or
    // `/Users/me/sandbox/usr/local/Caskroom/codex/...` is not actually
    // installed under the Homebrew prefix.  Detection must be
    // root-anchored on the prefix so these do not get an official
    // formula/cask update prompt — a wrong prompt is worse than no
    // prompt.
    expect(
      detectCodexSource("/tmp/opt/homebrew/Cellar/codex/0.46.0/bin/codex").kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource(
        "/Users/me/sandbox/usr/local/Cellar/codex/0.46.0/bin/codex",
      ).kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource(
        "/var/tmp/home/linuxbrew/.linuxbrew/Cellar/codex/0.46.0/bin/codex",
      ).kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource("/tmp/opt/homebrew/Caskroom/codex/0.122.0/codex").kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource(
        "/Users/me/sandbox/usr/local/Caskroom/codex/0.122.0/codex",
      ).kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource(
        "/var/tmp/home/linuxbrew/.linuxbrew/Caskroom/codex/0.122.0/codex",
      ).kind,
    ).toBe("inconclusive");
  });

  test("any /Applications/ path is inconclusive, not guessed as cask", () => {
    // A real cask install of the CLI resolves through `realpath` into
    // a Caskroom directory, so if we still see a raw `Applications`
    // path at detection time the binary is *not* a cask symlink.
    // Classifying it as cask would be a guess — exactly the "wrong
    // prompt is worse than no prompt" failure the issue warns
    // against.  All of these shapes — system-wide, home-rooted, and
    // rogue — fall through to `inconclusive`.
    expect(
      detectCodexSource("/Applications/Codex.app/Contents/MacOS/codex").kind,
    ).toBe("inconclusive");
    expect(
      detectCodexSource(
        `${homedir()}/Applications/Codex.app/Contents/MacOS/codex`,
      ).kind,
    ).toBe("inconclusive");
    expect(detectCodexSource("/tmp/Applications/codex").kind).toBe(
      "inconclusive",
    );
    expect(
      detectCodexSource("/opt/shared/Applications/codex/bin/codex").kind,
    ).toBe("inconclusive");
  });

  test("standalone ~/.codex/bin layout", () => {
    expect(detectCodexSource(`${homedir()}/.codex/bin/codex`)).toEqual({
      kind: "github-releases",
      repo: "openai/codex",
    });
  });

  test("standalone ~/.codex/versions/<ver> layout", () => {
    expect(
      detectCodexSource(`${homedir()}/.codex/versions/0.46.0/codex`),
    ).toEqual({ kind: "github-releases", repo: "openai/codex" });
  });

  test("standalone ~/.codex/packages/standalone/releases layout", () => {
    expect(
      detectCodexSource(
        `${homedir()}/.codex/packages/standalone/releases/0.122.0-aarch64-apple-darwin/codex`,
      ),
    ).toEqual({ kind: "github-releases", repo: "openai/codex" });
  });

  test("unknown layout is inconclusive", () => {
    const result = detectCodexSource("/usr/local/bin/my-codex");
    expect(result.kind).toBe("inconclusive");
  });

  test("a rogue /.codex/ path outside $HOME is inconclusive, not guessed", () => {
    // A hand-placed binary that happens to sit under any directory
    // named `.codex` must not be classified as an official standalone
    // install — the update prompt would be wrong.  Only the current
    // user's home directory is accepted.
    expect(detectCodexSource("/tmp/.codex/codex").kind).toBe("inconclusive");
    expect(detectCodexSource("/var/tmp/fake/.codex/bin/codex").kind).toBe(
      "inconclusive",
    );
    expect(
      detectCodexSource("/opt/shared/.codex/versions/0.46.0/codex").kind,
    ).toBe("inconclusive");
  });

  test("unknown subpath inside ~/.codex/ is inconclusive, not guessed", () => {
    // Home-rooted `.codex` is necessary but not sufficient — a binary
    // at a hand-placed subpath like `~/.codex/tools/codex` or
    // `~/.codex/tmp/codex` is not one of the known standalone
    // layouts, so it must fall through to `inconclusive` rather than
    // get a bogus GitHub-releases update prompt.
    expect(detectCodexSource(`${homedir()}/.codex/tools/codex`).kind).toBe(
      "inconclusive",
    );
    expect(detectCodexSource(`${homedir()}/.codex/tmp/codex`).kind).toBe(
      "inconclusive",
    );
    expect(detectCodexSource(`${homedir()}/.codex/codex`).kind).toBe(
      "inconclusive",
    );
    expect(
      detectCodexSource(`${homedir()}/.codex/packages/custom/codex`).kind,
    ).toBe("inconclusive");
  });
});

describe("detectInstallSource", () => {
  test("claude always resolves to npm", () => {
    expect(detectInstallSource("claude", "/random/path")).toEqual({
      kind: "npm",
      registryPackage: "@anthropic-ai/claude-code",
    });
  });

  test("codex delegates to detectCodexSource", () => {
    expect(
      detectInstallSource(
        "codex",
        "/opt/homebrew/Cellar/codex/0.46.0/bin/codex",
      ),
    ).toEqual({ kind: "homebrew-formula", formula: "codex" });
  });
});

// ---- resolveLatestVersion ------------------------------------------------

function makeDeps(overrides: Partial<VersionCheckDeps> = {}): VersionCheckDeps {
  return {
    runVersion: vi.fn(),
    resolveBinary: vi.fn(),
    fetchJson: vi.fn(),
    ...overrides,
  };
}

describe("resolveLatestVersion", () => {
  test("npm fetches /latest and reads version", async () => {
    const deps = makeDeps({
      fetchJson: vi.fn(async (url: string) => {
        expect(url).toBe(
          "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
        );
        return { version: "1.3.0" };
      }),
    });
    const v = await resolveLatestVersion(
      { kind: "npm", registryPackage: "@anthropic-ai/claude-code" },
      deps,
    );
    expect(v).toBe("1.3.0");
  });

  test("homebrew formula reads versions.stable", async () => {
    const deps = makeDeps({
      fetchJson: vi.fn(async (url: string) => {
        expect(url).toBe("https://formulae.brew.sh/api/formula/codex.json");
        return { versions: { stable: "0.46.0" } };
      }),
    });
    const v = await resolveLatestVersion(
      { kind: "homebrew-formula", formula: "codex" },
      deps,
    );
    expect(v).toBe("0.46.0");
  });

  test("homebrew cask reads version", async () => {
    const deps = makeDeps({
      fetchJson: vi.fn(async () => ({ version: "0.122.0" })),
    });
    const v = await resolveLatestVersion(
      { kind: "homebrew-cask", cask: "codex" },
      deps,
    );
    expect(v).toBe("0.122.0");
  });

  test("github-releases strips leading v from tag_name", async () => {
    const deps = makeDeps({
      fetchJson: vi.fn(async () => ({ tag_name: "v0.122.0" })),
    });
    const v = await resolveLatestVersion(
      { kind: "github-releases", repo: "openai/codex" },
      deps,
    );
    expect(v).toBe("0.122.0");
  });

  test("github-releases extracts semver from prefixed tag_name", async () => {
    // openai/codex currently publishes `tag_name: rust-v0.122.0` with
    // `name: 0.122.0` — a bare `^v` strip leaves `rust-v0.122.0` and
    // makes compareVersions treat any real install as ahead of latest.
    const deps = makeDeps({
      fetchJson: vi.fn(async () => ({
        tag_name: "rust-v0.122.0",
        name: "0.122.0",
      })),
    });
    const v = await resolveLatestVersion(
      { kind: "github-releases", repo: "openai/codex" },
      deps,
    );
    expect(v).toBe("0.122.0");
  });

  test("github-releases falls back to tag_name when name is missing", async () => {
    const deps = makeDeps({
      fetchJson: vi.fn(async () => ({ tag_name: "rust-v0.122.0" })),
    });
    const v = await resolveLatestVersion(
      { kind: "github-releases", repo: "openai/codex" },
      deps,
    );
    expect(v).toBe("0.122.0");
  });

  test("github-releases returns undefined when neither field is semver", async () => {
    const deps = makeDeps({
      fetchJson: vi.fn(async () => ({ tag_name: "nightly", name: "" })),
    });
    const v = await resolveLatestVersion(
      { kind: "github-releases", repo: "openai/codex" },
      deps,
    );
    expect(v).toBeUndefined();
  });

  test("inconclusive returns undefined", async () => {
    const deps = makeDeps();
    const v = await resolveLatestVersion(
      { kind: "inconclusive", reason: "test" },
      deps,
    );
    expect(v).toBeUndefined();
  });
});

// ---- checkCliVersion -----------------------------------------------------

describe("checkCliVersion", () => {
  test("reports installed + latest for claude", async () => {
    const deps = makeDeps({
      runVersion: () => "1.2.3 (Claude Code)\n",
      resolveBinary: () => "/usr/local/bin/claude",
      fetchJson: async () => ({ version: "1.3.0" }),
    });
    const r = await checkCliVersion("claude", deps);
    expect(r.installed).toBe("1.2.3");
    expect(r.latest).toBe("1.3.0");
    expect(r.source?.kind).toBe("npm");
  });

  test("surfaces inconclusive codex layout as skippedReason", async () => {
    const deps = makeDeps({
      runVersion: () => "0.46.0\n",
      resolveBinary: () => "/opt/custom/codex",
      fetchJson: vi.fn(),
    });
    const r = await checkCliVersion("codex", deps);
    expect(r.installed).toBe("0.46.0");
    expect(r.source?.kind).toBe("inconclusive");
    expect(r.skippedReason).toBeDefined();
    expect(deps.fetchJson).not.toHaveBeenCalled();
  });

  test("network failure is surfaced as skippedReason", async () => {
    const deps = makeDeps({
      runVersion: () => "0.46.0\n",
      resolveBinary: () => "/opt/homebrew/Cellar/codex/0.46.0/bin/codex",
      fetchJson: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const r = await checkCliVersion("codex", deps);
    expect(r.installed).toBe("0.46.0");
    expect(r.skippedReason).toContain("ECONNREFUSED");
  });

  test("skips when --version fails", async () => {
    const deps = makeDeps({
      runVersion: () => undefined,
    });
    const r = await checkCliVersion("claude", deps);
    expect(r.installed).toBeUndefined();
    expect(r.skippedReason).toContain("--version");
  });

  test("skips when version cannot be parsed", async () => {
    const deps = makeDeps({
      runVersion: () => "totally not a version\n",
    });
    const r = await checkCliVersion("claude", deps);
    expect(r.installed).toBeUndefined();
    expect(r.skippedReason).toContain("parse");
  });
});

// ---- shouldRunVersionCheck ----------------------------------------------

describe("shouldRunVersionCheck", () => {
  const base: Config = {
    owners: [],
    cloneBaseDir: "~/projects",
    language: "en",
    pipelineSettings: {
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
      autoResumeAttempts: 3,
    },
    notifications: { bell: true, desktop: false },
  };

  test("runs when never run before", () => {
    expect(shouldRunVersionCheck(base, Date.now())).toBe(true);
  });

  test("skipped when skipVersionCheck=true", () => {
    expect(
      shouldRunVersionCheck({ ...base, skipVersionCheck: true }, Date.now()),
    ).toBe(false);
  });

  test("skipped within throttle window", () => {
    const now = 1_000_000_000_000;
    expect(
      shouldRunVersionCheck({ ...base, lastVersionCheckAt: now - 60_000 }, now),
    ).toBe(false);
  });

  test("runs after throttle window", () => {
    const now = 1_000_000_000_000;
    const dayAgo = now - 25 * 60 * 60 * 1000;
    expect(
      shouldRunVersionCheck({ ...base, lastVersionCheckAt: dayAgo }, now),
    ).toBe(true);
  });
});

// ---- runStartupVersionCheck ---------------------------------------------

function makeTranslations(): VersionCheckTranslations {
  return {
    checking: "Checking...",
    inconclusive: (c, r) => `${c} inconclusive: ${r}`,
    fetchFailed: (c, r) => `${c} fetch failed: ${r}`,
    upToDate: (c, v) => `${c} v${v} up to date`,
    updatePrompt: (c, f, t) => `${c} ${f} -> ${t}?`,
    updateWaiting: (c) => `update ${c}`,
    versionUnchanged: (v) => `still v${v}`,
    retrySkipAbortPrompt: "proceed?",
    proceedingWith: (c, v) => `${c} now v${v}`,
    abortedByUser: "aborted",
    versionUnknown: (c) => `${c} unknown`,
  };
}

function makeConfig(): Config {
  return {
    owners: [],
    cloneBaseDir: "~/projects",
    language: "en",
    pipelineSettings: {
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
      autoResumeAttempts: 3,
    },
    notifications: { bell: true, desktop: false },
  };
}

function makePrompts(
  overrides: Partial<VersionCheckPrompts> = {},
): VersionCheckPrompts {
  return {
    confirmUpdate: vi.fn(async () => false),
    waitForEnter: vi.fn(async () => {}),
    chooseRetrySkipAbort: vi.fn(async () => "skip"),
    log: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

describe("runStartupVersionCheck", () => {
  test("does not prompt when up to date", async () => {
    const config = makeConfig();
    const persistVersionCheckState = vi.fn();
    const deps = makeDeps({
      runVersion: () => "1.3.0\n",
      resolveBinary: () =>
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
      fetchJson: async () => ({ version: "1.3.0" }),
    });
    const prompts = makePrompts();
    const versions = await runStartupVersionCheck({
      clis: ["claude"],
      config,
      persistVersionCheckState,
      prompts,
      translations: makeTranslations(),
      deps,
    });
    expect(versions.get("claude")).toBe("1.3.0");
    expect(prompts.confirmUpdate).not.toHaveBeenCalled();
    expect(persistVersionCheckState).toHaveBeenCalled();
    // The persistence callback receives only the patchable fields, not
    // a whole Config object.  That's what keeps unknown top-level keys
    // in ~/.agentcoop/config.json from being silently dropped.
    const payload = persistVersionCheckState.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(payload).toBeDefined();
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      "lastKnownVersions",
      "lastVersionCheckAt",
    ]);
    expect(
      (payload as { lastKnownVersions: { claude: string } }).lastKnownVersions
        .claude,
    ).toBe("1.3.0");
    expect(config.lastKnownVersions?.claude).toBe("1.3.0");
    expect(config.lastVersionCheckAt).toBeDefined();
  });

  test("deduplicates CLIs when agentA and agentB share one", async () => {
    const runVersion = vi.fn(() => "1.3.0\n");
    const deps = makeDeps({
      runVersion,
      resolveBinary: () =>
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
      fetchJson: async () => ({ version: "1.3.0" }),
    });
    await runStartupVersionCheck({
      clis: ["claude", "claude"],
      config: makeConfig(),
      persistVersionCheckState: vi.fn(),
      prompts: makePrompts(),
      translations: makeTranslations(),
      deps,
    });
    expect(runVersion).toHaveBeenCalledTimes(1);
  });

  test("prompts and re-checks after successful update", async () => {
    const runVersionMock = vi
      .fn()
      .mockReturnValueOnce("1.2.3\n")
      .mockReturnValueOnce("1.3.0\n");
    const deps = makeDeps({
      runVersion: runVersionMock,
      resolveBinary: () =>
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
      fetchJson: async () => ({ version: "1.3.0" }),
    });
    const prompts = makePrompts({
      confirmUpdate: vi.fn(async () => true),
    });
    const versions = await runStartupVersionCheck({
      clis: ["claude"],
      config: makeConfig(),
      persistVersionCheckState: vi.fn(),
      prompts,
      translations: makeTranslations(),
      deps,
    });
    expect(prompts.confirmUpdate).toHaveBeenCalledTimes(1);
    expect(prompts.waitForEnter).toHaveBeenCalledTimes(1);
    expect(versions.get("claude")).toBe("1.3.0");
  });

  test("retry / skip / abort flow on unchanged version", async () => {
    const runVersionMock = vi.fn(() => "1.2.3\n");
    const deps = makeDeps({
      runVersion: runVersionMock,
      resolveBinary: () =>
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
      fetchJson: async () => ({ version: "1.3.0" }),
    });
    const prompts = makePrompts({
      confirmUpdate: vi.fn(async () => true),
      chooseRetrySkipAbort: vi
        .fn()
        .mockResolvedValueOnce("retry")
        .mockResolvedValueOnce("skip"),
    });
    const versions = await runStartupVersionCheck({
      clis: ["claude"],
      config: makeConfig(),
      persistVersionCheckState: vi.fn(),
      prompts,
      translations: makeTranslations(),
      deps,
    });
    expect(prompts.chooseRetrySkipAbort).toHaveBeenCalledTimes(2);
    // Second --version call after "retry", third after "skip".
    expect(runVersionMock).toHaveBeenCalledTimes(3);
    expect(versions.get("claude")).toBe("1.2.3");
  });

  test("abort throws VersionCheckAbortError", async () => {
    const deps = makeDeps({
      runVersion: () => "1.2.3\n",
      resolveBinary: () =>
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
      fetchJson: async () => ({ version: "1.3.0" }),
    });
    const prompts = makePrompts({
      confirmUpdate: vi.fn(async () => true),
      chooseRetrySkipAbort: vi.fn(async () => "abort"),
    });
    await expect(
      runStartupVersionCheck({
        clis: ["claude"],
        config: makeConfig(),
        persistVersionCheckState: vi.fn(),
        prompts,
        translations: makeTranslations(),
        deps,
      }),
    ).rejects.toBeInstanceOf(VersionCheckAbortError);
  });

  test("inconclusive codex channel is logged and skipped (no prompt)", async () => {
    const deps = makeDeps({
      runVersion: () => "0.46.0\n",
      resolveBinary: () => "/opt/custom/codex",
      fetchJson: vi.fn(),
    });
    const prompts = makePrompts();
    const versions = await runStartupVersionCheck({
      clis: ["codex"],
      config: makeConfig(),
      persistVersionCheckState: vi.fn(),
      prompts,
      translations: makeTranslations(),
      deps,
    });
    expect(versions.get("codex")).toBe("0.46.0");
    expect(prompts.confirmUpdate).not.toHaveBeenCalled();
    expect(deps.fetchJson).not.toHaveBeenCalled();
  });

  test("inconclusive-only run does NOT advance lastVersionCheckAt", async () => {
    // Regression for the 24h throttle semantics: if no CLI reaches a
    // real installed-vs-latest comparison, the throttle timestamp must
    // not move forward — otherwise a transient outage or a custom
    // layout would suppress all re-checks for 24h without ever having
    // made a successful comparison.
    const now = 1_000_000_000_000;
    const config = makeConfig();
    const persistVersionCheckState = vi.fn();
    const deps = makeDeps({
      runVersion: () => "0.46.0\n",
      resolveBinary: () => "/opt/custom/codex",
      fetchJson: vi.fn(),
    });
    await runStartupVersionCheck({
      clis: ["codex"],
      config,
      persistVersionCheckState,
      prompts: makePrompts(),
      translations: makeTranslations(),
      deps,
      now: () => now,
    });
    expect(config.lastVersionCheckAt).toBeUndefined();
    // lastKnownVersions still updates because the installed probe
    // succeeded — only the throttle timestamp is gated.
    expect(config.lastKnownVersions?.codex).toBe("0.46.0");
  });

  test("network fetch failure does NOT advance lastVersionCheckAt", async () => {
    const now = 1_000_000_000_000;
    const config = makeConfig();
    const deps = makeDeps({
      runVersion: () => "1.2.3\n",
      resolveBinary: () =>
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    await runStartupVersionCheck({
      clis: ["claude"],
      config,
      persistVersionCheckState: vi.fn(),
      prompts: makePrompts(),
      translations: makeTranslations(),
      deps,
      now: () => now,
    });
    // Fetch failed before installed-vs-latest comparison completed,
    // so the throttle timestamp must not advance.
    expect(config.lastVersionCheckAt).toBeUndefined();
  });

  test("mixed run advances timestamp when at least one CLI reached comparison", async () => {
    // Claude succeeds, Codex is inconclusive — at least one CLI made
    // a definitive comparison, so the throttle timestamp should
    // advance.  This is the "mixed success" case.
    const now = 1_000_000_000_000;
    const config = makeConfig();
    const deps = makeDeps({
      runVersion: () => "1.3.0\n",
      resolveBinary: (cli) =>
        cli === "claude"
          ? "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude"
          : "/opt/custom/codex",
      fetchJson: async () => ({ version: "1.3.0" }),
    });
    await runStartupVersionCheck({
      clis: ["claude", "codex"],
      config,
      persistVersionCheckState: vi.fn(),
      prompts: makePrompts(),
      translations: makeTranslations(),
      deps,
      now: () => now,
    });
    expect(config.lastVersionCheckAt).toBe(now);
  });

  test("skipVersionCheck=true still records installed version", async () => {
    const config = makeConfig();
    config.skipVersionCheck = true;
    const persistVersionCheckState = vi.fn();
    const fetchJson = vi.fn(async () => ({ version: "1.3.0" }));
    const resolveBinary = vi.fn(
      () =>
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
    );
    const deps = makeDeps({
      runVersion: () => "1.2.3\n",
      resolveBinary,
      fetchJson,
    });
    const prompts = makePrompts();
    const versions = await runStartupVersionCheck({
      clis: ["claude"],
      config,
      persistVersionCheckState,
      prompts,
      translations: makeTranslations(),
      deps,
    });
    expect(versions.get("claude")).toBe("1.2.3");
    expect(prompts.confirmUpdate).not.toHaveBeenCalled();
    // lastVersionCheckAt is NOT set when throttled/skipped.
    expect(config.lastVersionCheckAt).toBeUndefined();
    expect(config.lastKnownVersions?.claude).toBe("1.2.3");
    // No network call and no install-source resolution on a skipped run.
    expect(fetchJson).not.toHaveBeenCalled();
    expect(resolveBinary).not.toHaveBeenCalled();
  });

  test("throttled run (within 24h) does not hit the network", async () => {
    const now = 1_000_000_000_000;
    const config = makeConfig();
    config.lastVersionCheckAt = now - 60_000;
    const persistVersionCheckState = vi.fn();
    const fetchJson = vi.fn(async () => ({ version: "1.3.0" }));
    const resolveBinary = vi.fn(
      () =>
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
    );
    const deps = makeDeps({
      runVersion: () => "1.2.3\n",
      resolveBinary,
      fetchJson,
    });
    const prompts = makePrompts();
    const versions = await runStartupVersionCheck({
      clis: ["claude"],
      config,
      persistVersionCheckState,
      prompts,
      translations: makeTranslations(),
      deps,
      now: () => now,
    });
    expect(versions.get("claude")).toBe("1.2.3");
    expect(prompts.confirmUpdate).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
    expect(resolveBinary).not.toHaveBeenCalled();
    // Throttled timestamp is not refreshed.
    expect(config.lastVersionCheckAt).toBe(now - 60_000);
  });
});

// ---- refreshAgentCliVersion ---------------------------------------------

describe("refreshAgentCliVersion", () => {
  test("overwrites the saved version when a new one is detected", () => {
    // A successful re-probe on resume should capture a CLI upgrade
    // between runs — otherwise the postmortem record would still
    // point at the old build.
    const agent = { cliVersion: "1.2.3" };
    refreshAgentCliVersion(agent, "1.3.0");
    expect(agent.cliVersion).toBe("1.3.0");
  });

  test("keeps the saved version when the re-probe returns undefined", () => {
    // Regression: a failed re-probe (e.g. `--version` crashed, output
    // unparseable, binary temporarily unavailable) used to blank the
    // previously recorded version on resume, erasing the per-run
    // postmortem record that issue #276 asked to preserve.
    const agent = { cliVersion: "1.2.3" };
    refreshAgentCliVersion(agent, undefined);
    expect(agent.cliVersion).toBe("1.2.3");
  });

  test("leaves an undefined saved version undefined when probe fails", () => {
    // Nothing previously recorded and nothing detected now — stay
    // undefined rather than materializing a bogus value.
    const agent: { cliVersion?: string } = {};
    refreshAgentCliVersion(agent, undefined);
    expect(agent.cliVersion).toBeUndefined();
  });

  test("populates cliVersion on first successful probe", () => {
    // Saved state predates version tracking (cliVersion optional) —
    // the first successful probe should fill it in.
    const agent: { cliVersion?: string } = {};
    refreshAgentCliVersion(agent, "0.46.0");
    expect(agent.cliVersion).toBe("0.46.0");
  });
});
