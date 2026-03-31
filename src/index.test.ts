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

  test("does not include jsx setting", () => {
    expect(tsconfig.compilerOptions.jsx).toBeUndefined();
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
