import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const tmpHome = join(import.meta.dirname, "..", ".tmp-test-home");

vi.mock("node:os", () => ({
  homedir: () => tmpHome,
}));

const { configPath, loadConfig, saveConfig } = await import("./config.js");

describe("configPath", () => {
  test("returns path under ~/.agentcoop/", () => {
    expect(configPath()).toBe(join(tmpHome, ".agentcoop", "config.json"));
  });
});

describe("loadConfig", () => {
  beforeEach(() => {
    mkdirSync(join(tmpHome, ".agentcoop"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("creates default config when file does not exist", () => {
    const config = loadConfig();
    expect(config).toEqual({
      owners: [],
      cloneBaseDir: "~/projects",
      language: "en",
    });
    expect(existsSync(configPath())).toBe(true);
  });

  test("created default config is valid JSON on disk", () => {
    loadConfig();
    const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(raw).toEqual({
      owners: [],
      cloneBaseDir: "~/projects",
      language: "en",
    });
  });

  test("reads existing config with all fields", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: ["aicers"],
        cloneBaseDir: "~/dev",
        language: "ko",
      }),
    );
    const config = loadConfig();
    expect(config.owners).toEqual(["aicers"]);
    expect(config.cloneBaseDir).toBe("~/dev");
    expect(config.language).toBe("ko");
  });

  test("fills missing fields with defaults", () => {
    writeFileSync(configPath(), JSON.stringify({ owners: ["foo"] }));
    const config = loadConfig();
    expect(config.owners).toEqual(["foo"]);
    expect(config.cloneBaseDir).toBe("~/projects");
    expect(config.language).toBe("en");
  });

  test("ignores unknown extra fields", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: ["bar"],
        cloneBaseDir: "~/code",
        language: "en",
        unknownField: 42,
        nested: { deep: true },
      }),
    );
    const config = loadConfig();
    expect(config).toEqual({
      owners: ["bar"],
      cloneBaseDir: "~/code",
      language: "en",
    });
    expect("unknownField" in config).toBe(false);
    expect("nested" in config).toBe(false);
  });

  test("falls back to default for invalid language value", () => {
    writeFileSync(configPath(), JSON.stringify({ owners: [], language: "fr" }));
    const config = loadConfig();
    expect(config.language).toBe("en");
  });

  test("falls back to default for non-string language", () => {
    writeFileSync(configPath(), JSON.stringify({ owners: [], language: 123 }));
    const config = loadConfig();
    expect(config.language).toBe("en");
  });

  test("falls back to default when owners is not an array", () => {
    writeFileSync(configPath(), JSON.stringify({ owners: "not-an-array" }));
    const config = loadConfig();
    expect(config.owners).toEqual([]);
  });

  test("falls back to default when cloneBaseDir is not a string", () => {
    writeFileSync(configPath(), JSON.stringify({ cloneBaseDir: 42 }));
    const config = loadConfig();
    expect(config.cloneBaseDir).toBe("~/projects");
  });

  test("throws on malformed JSON", () => {
    writeFileSync(configPath(), "{ broken json");
    expect(() => loadConfig()).toThrow();
  });

  test("default config owners array is isolated from mutations", () => {
    // Simulate the scenario: file doesn't exist, loadConfig creates default,
    // caller mutates the returned owners array, then file is deleted and
    // loadConfig is called again — should still get empty owners.
    const config1 = loadConfig();
    config1.owners.push("mutated-org");

    // Delete the config file to force default path again
    rmSync(configPath());

    const config2 = loadConfig();
    expect(config2.owners).toEqual([]);
  });

  test("returns a new object each time (no shared references)", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: ["org1"], cloneBaseDir: "~/x", language: "ko" }),
    );
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.owners.push("mutated");
    expect(b.owners).not.toContain("mutated");
  });
});

describe("saveConfig", () => {
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("creates directories and writes config", () => {
    const config = {
      owners: ["org1"],
      cloneBaseDir: "~/code",
      language: "ko" as const,
    };
    saveConfig(config);
    const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(raw).toEqual(config);
  });

  test("written file ends with newline", () => {
    saveConfig({ owners: [], cloneBaseDir: "~/x", language: "en" });
    const content = readFileSync(configPath(), "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });

  test("overwrites existing config", () => {
    saveConfig({ owners: ["a"], cloneBaseDir: "~/x", language: "en" });
    saveConfig({ owners: ["b"], cloneBaseDir: "~/y", language: "ko" });
    const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(raw.owners).toEqual(["b"]);
    expect(raw.cloneBaseDir).toBe("~/y");
    expect(raw.language).toBe("ko");
  });

  test("roundtrips correctly with loadConfig", () => {
    const original = {
      owners: ["aicers", "my-org"],
      cloneBaseDir: "~/dev",
      language: "ko" as const,
    };
    saveConfig(original);
    const loaded = loadConfig();
    expect(loaded).toEqual(original);
  });
});
