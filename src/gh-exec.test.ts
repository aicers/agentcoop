import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ghExec } from "./gh-exec.js";

// A fake `gh` binary on PATH that writes the requested number of
// bytes to stdout.  Lets us exercise the `maxBuffer` boundary without
// hitting the real GitHub API.
let tmpDir: string;
let originalPath: string | undefined;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agentcoop-gh-exec-"));
  const ghPath = join(tmpDir, "gh");
  writeFileSync(ghPath, '#!/bin/sh\nyes a | head -c "$1"\n');
  chmodSync(ghPath, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${tmpDir}:${originalPath ?? ""}`;
});

afterAll(() => {
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ghExec", () => {
  test("succeeds when output exceeds the legacy 1 MiB execFileSync default", () => {
    // 2 MiB — would have tripped the old 1 MiB default.
    const size = 2 * 1024 * 1024;
    const out = ghExec([String(size)]);
    expect(out.length).toBe(size);
  });

  test("fails with args in message when output exceeds the 64 MiB cap", () => {
    const size = 70 * 1024 * 1024;
    let captured: NodeJS.ErrnoException | undefined;
    try {
      ghExec([String(size), "marker-arg"]);
    } catch (err) {
      captured = err as NodeJS.ErrnoException;
    }
    expect(captured).toBeDefined();
    // The rethrow prepends the args so the next incident points
    // straight at the offending call site.
    expect(captured?.message).toContain(String(size));
    expect(captured?.message).toContain("marker-arg");
  });

  test('no production source under src/ calls execFileSync("gh", ...) directly', () => {
    // Acceptance criterion: every `gh` invocation must go through the
    // helper so the maxBuffer cap cannot be silently re-defaulted.
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    const forbidden = /execFileSync\s*\(\s*["']gh["']/;
    for (const entry of readdirSync(srcDir, {
      withFileTypes: true,
      recursive: true,
    })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts")) continue;
      // Skip tests and the helper itself (the only sanctioned caller).
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
        continue;
      }
      if (entry.name === "gh-exec.ts") continue;
      const full = join(entry.parentPath, entry.name);
      if (forbidden.test(readFileSync(full, "utf-8"))) offenders.push(full);
    }
    expect(offenders).toEqual([]);
  });
});
