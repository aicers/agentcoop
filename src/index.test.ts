import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

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
});

// ---------------------------------------------------------------------------
// CLI execution
// ---------------------------------------------------------------------------
describe("CLI execution", () => {
  test("node dist/index.js prints agentcoop", () => {
    const output = execFileSync("node", [resolve(distDir, "index.js")], {
      encoding: "utf-8",
    });
    expect(output.trim()).toBe("agentcoop");
  });
});
