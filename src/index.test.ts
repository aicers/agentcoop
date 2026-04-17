import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");
const distDir = resolve(root, "dist");

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------
describe("package.json", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));

  test("type is module", () => {
    expect(pkg.type).toBe("module");
  });

  test("engine requires Node 24.x", () => {
    expect(pkg.engines.node).toMatch(/^>=24/);
  });

  test("bin points to dist/index.js", () => {
    expect(pkg.bin.agentcoop).toBe("./dist/index.js");
  });

  test("required scripts exist", () => {
    for (const script of [
      "build",
      "check",
      "lint",
      "format",
      "test",
      "typecheck",
    ]) {
      expect(pkg.scripts).toHaveProperty(script);
    }
  });

  test("packageManager specifies pnpm", () => {
    expect(pkg.packageManager).toMatch(/^pnpm@/);
  });

  test("@inquirer/prompts is a dependency", () => {
    expect(pkg.dependencies).toHaveProperty("@inquirer/prompts");
  });
});

// ---------------------------------------------------------------------------
// tsconfig.json
// ---------------------------------------------------------------------------
describe("tsconfig.json", () => {
  const tsconfig = JSON.parse(
    readFileSync(resolve(root, "tsconfig.json"), "utf-8"),
  );

  test("module is NodeNext", () => {
    expect(tsconfig.compilerOptions.module).toBe("NodeNext");
  });

  test("moduleResolution is NodeNext", () => {
    expect(tsconfig.compilerOptions.moduleResolution).toBe("NodeNext");
  });

  test("strict mode enabled", () => {
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  test("outDir is dist", () => {
    expect(tsconfig.compilerOptions.outDir).toBe("./dist");
  });

  test("rootDir is src", () => {
    expect(tsconfig.compilerOptions.rootDir).toBe("./src");
  });

  test("does not include browser libs", () => {
    const libs = tsconfig.compilerOptions.lib as string[];
    for (const lib of libs) {
      expect(lib.toLowerCase()).not.toContain("dom");
    }
  });

  test("includes jsx setting for ink TUI", () => {
    expect(tsconfig.compilerOptions.jsx).toBe("react-jsx");
  });

  test("excludes test files from compilation", () => {
    expect(tsconfig.exclude).toContain("src/**/*.test.ts");
  });
});

// ---------------------------------------------------------------------------
// biome.json
// ---------------------------------------------------------------------------
describe("biome.json", () => {
  const biome = JSON.parse(readFileSync(resolve(root, "biome.json"), "utf-8"));

  test("linter is enabled with recommended rules", () => {
    expect(biome.linter.enabled).toBe(true);
    expect(biome.linter.rules.recommended).toBe(true);
  });

  test("formatter uses 2-space indent", () => {
    expect(biome.formatter.indentStyle).toBe("space");
    expect(biome.formatter.indentWidth).toBe(2);
  });

  test("does not include React or Next.js domains", () => {
    expect(biome.linter.domains).toBeUndefined();
  });

  test("does not include CSS parser config", () => {
    expect(biome.css).toBeUndefined();
  });

  test("organize imports is enabled", () => {
    expect(biome.assist.actions.source.organizeImports).toBe("on");
  });
});

// ---------------------------------------------------------------------------
// Build output
// ---------------------------------------------------------------------------
describe("build output", () => {
  test("dist/index.js exists after build", () => {
    expect(existsSync(resolve(distDir, "index.js"))).toBe(true);
  });

  test("dist/index.js starts with shebang", () => {
    const content = readFileSync(resolve(distDir, "index.js"), "utf-8");
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  test("dist/index.d.ts declaration file exists", () => {
    expect(existsSync(resolve(distDir, "index.d.ts"))).toBe(true);
  });

  test("dist/index.js.map source map exists", () => {
    expect(existsSync(resolve(distDir, "index.js.map"))).toBe(true);
  });

  test("dist/config.js exists", () => {
    expect(existsSync(resolve(distDir, "config.js"))).toBe(true);
  });

  test("dist/github.js exists", () => {
    expect(existsSync(resolve(distDir, "github.js"))).toBe(true);
  });

  test("dist/startup.js exists", () => {
    expect(existsSync(resolve(distDir, "startup.js"))).toBe(true);
  });

  test("all dist files have corresponding declaration files", () => {
    for (const mod of ["config", "github", "startup"]) {
      expect(existsSync(resolve(distDir, `${mod}.d.ts`))).toBe(true);
    }
  });

  test("all dist files have corresponding source maps", () => {
    for (const mod of ["index", "config", "github", "startup"]) {
      expect(existsSync(resolve(distDir, `${mod}.js.map`))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
describe("module exports", () => {
  test("config module exports loadConfig, saveConfig, configPath", async () => {
    const config = await import("../dist/config.js");
    expect(typeof config.loadConfig).toBe("function");
    expect(typeof config.saveConfig).toBe("function");
    expect(typeof config.configPath).toBe("function");
  });

  test("config module exports DEFAULT_PIPELINE_SETTINGS", async () => {
    const config = await import("../dist/config.js");
    expect(config.DEFAULT_PIPELINE_SETTINGS).toEqual({
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
      autoResumeAttempts: 3,
    });
  });

  test("assembleCiCheckStage passes pollTimeoutMs to handler and sets autoBudget", async () => {
    const { assembleCiCheckStage, DEFAULT_PIPELINE_SETTINGS } = await import(
      "../dist/config.js"
    );
    // Use non-default values to prove the mapping, not just the defaults.
    const settings = {
      ...DEFAULT_PIPELINE_SETTINGS,
      ciCheckAutoIterations: 7,
      ciCheckTimeoutMinutes: 15,
    };
    let receivedOpts: { pollTimeoutMs: number } | undefined;
    const handlerStub = { name: "CI check", number: 5, handler: () => {} };
    const result = assembleCiCheckStage((opts: { pollTimeoutMs: number }) => {
      receivedOpts = opts;
      return handlerStub;
    }, settings);
    // The factory received the converted timeout.
    expect(receivedOpts).toEqual({ pollTimeoutMs: 15 * 60_000 });
    // The returned object spreads the handler and adds autoBudget.
    expect(result.autoBudget).toBe(7);
    expect(result.name).toBe("CI check");
  });

  test("assembleSquashStage passes pollTimeoutMs to handler", async () => {
    const { assembleSquashStage, DEFAULT_PIPELINE_SETTINGS } = await import(
      "../dist/config.js"
    );
    const settings = {
      ...DEFAULT_PIPELINE_SETTINGS,
      ciCheckTimeoutMinutes: 20,
    };
    let receivedOpts: { pollTimeoutMs: number } | undefined;
    const handlerStub = { name: "Squash", number: 8, handler: () => {} };
    const result = assembleSquashStage((opts: { pollTimeoutMs: number }) => {
      receivedOpts = opts;
      return handlerStub;
    }, settings);
    expect(receivedOpts).toEqual({ pollTimeoutMs: 20 * 60_000 });
    expect(result.name).toBe("Squash");
  });

  test("assembleReviewStage passes pollTimeoutMs to handler and sets autoBudget", async () => {
    const { assembleReviewStage, DEFAULT_PIPELINE_SETTINGS } = await import(
      "../dist/config.js"
    );
    const settings = {
      ...DEFAULT_PIPELINE_SETTINGS,
      ciCheckTimeoutMinutes: 25,
      reviewAutoRounds: 3,
    };
    let receivedOpts: { pollTimeoutMs: number } | undefined;
    const handlerStub = { name: "Review", number: 7, handler: () => {} };
    const result = assembleReviewStage((opts: { pollTimeoutMs: number }) => {
      receivedOpts = opts;
      return handlerStub;
    }, settings);
    expect(receivedOpts).toEqual({ pollTimeoutMs: 25 * 60_000 });
    expect(result.autoBudget).toBe(3);
    expect(result.name).toBe("Review");
  });

  test("github module exports listRepositories and getIssue", async () => {
    const github = await import("../dist/github.js");
    expect(typeof github.listRepositories).toBe("function");
    expect(typeof github.getIssue).toBe("function");
  });

  test("startup module exports runStartup", async () => {
    const startup = await import("../dist/startup.js");
    expect(typeof startup.runStartup).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// CLI E2E smoke test
// ---------------------------------------------------------------------------
describe("CLI E2E", () => {
  const tmpHome = resolve(root, ".tmp-e2e-home");

  beforeAll(() => {
    mkdirSync(tmpHome, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("exits with code 1 and clean error when run non-interactively", () => {
    try {
      execFileSync("node", [resolve(distDir, "index.js")], {
        encoding: "utf-8",
        env: { ...process.env, HOME: tmpHome },
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect.unreachable("CLI should have exited with non-zero code");
    } catch (error) {
      const e = error as { status: number; stderr: string };
      expect(e.status).toBe(1);
      expect(e.stderr).toContain("interactive terminal");
    }
  });
});
