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
      pipelineSettings: {
        selfCheckAutoIterations: 3,
        reviewAutoRounds: 3,
        inactivityTimeoutMinutes: 15,
        autoResumeAttempts: 3,
      },
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
      pipelineSettings: {
        selfCheckAutoIterations: 3,
        reviewAutoRounds: 3,
        inactivityTimeoutMinutes: 15,
        autoResumeAttempts: 3,
      },
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
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 3,
      reviewAutoRounds: 3,
      inactivityTimeoutMinutes: 15,
      autoResumeAttempts: 3,
    });
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
    expect(config.owners).toEqual(["bar"]);
    expect(config.cloneBaseDir).toBe("~/code");
    expect(config.language).toBe("en");
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

  test("filters out non-string elements from owners array", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: ["valid", 42, null, true, "also-valid"] }),
    );
    const config = loadConfig();
    expect(config.owners).toEqual(["valid", "also-valid"]);
  });

  test("falls back to default when cloneBaseDir is not a string", () => {
    writeFileSync(configPath(), JSON.stringify({ cloneBaseDir: 42 }));
    const config = loadConfig();
    expect(config.cloneBaseDir).toBe("~/projects");
  });

  test("falls back to default when root value is null", () => {
    writeFileSync(configPath(), "null");
    const config = loadConfig();
    expect(config.owners).toEqual([]);
    expect(config.cloneBaseDir).toBe("~/projects");
    expect(config.language).toBe("en");
  });

  test("falls back to default when root value is a number", () => {
    writeFileSync(configPath(), "42");
    const config = loadConfig();
    expect(config.owners).toEqual([]);
    expect(config.cloneBaseDir).toBe("~/projects");
    expect(config.language).toBe("en");
  });

  test("falls back to default when root value is a string", () => {
    writeFileSync(configPath(), JSON.stringify("hello"));
    const config = loadConfig();
    expect(config.owners).toEqual([]);
    expect(config.cloneBaseDir).toBe("~/projects");
    expect(config.language).toBe("en");
  });

  test("falls back to default when root value is an array", () => {
    writeFileSync(configPath(), JSON.stringify([1, 2, 3]));
    const config = loadConfig();
    expect(config.owners).toEqual([]);
    expect(config.cloneBaseDir).toBe("~/projects");
    expect(config.language).toBe("en");
  });

  test("filters out whitespace-only strings from owners array", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: ["valid", "   ", "", "\t", "also-valid"] }),
    );
    const config = loadConfig();
    expect(config.owners).toEqual(["valid", "also-valid"]);
  });

  test("trims leading and trailing whitespace from owner strings", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: ["  aicers  ", "my-org\t"] }),
    );
    const config = loadConfig();
    expect(config.owners).toEqual(["aicers", "my-org"]);
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

  test("reads saved pipelineSettings from config", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        pipelineSettings: {
          selfCheckAutoIterations: 5,
          reviewAutoRounds: 2,
          inactivityTimeoutMinutes: 30,
          autoResumeAttempts: 1,
        },
      }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 2,
      inactivityTimeoutMinutes: 30,
      autoResumeAttempts: 1,
    });
  });

  test("falls back to defaults for invalid pipelineSettings values", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        pipelineSettings: {
          selfCheckAutoIterations: -1,
          reviewAutoRounds: "abc",
          inactivityTimeoutMinutes: 0,
          autoResumeAttempts: 3.5,
        },
      }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 3,
      reviewAutoRounds: 3,
      inactivityTimeoutMinutes: 15,
      autoResumeAttempts: 3,
    });
  });

  test("falls back to defaults when pipelineSettings is not an object", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: [], pipelineSettings: "invalid" }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 3,
      reviewAutoRounds: 3,
      inactivityTimeoutMinutes: 15,
      autoResumeAttempts: 3,
    });
  });

  test("pipelineSettings defaults are isolated from mutations", () => {
    const config1 = loadConfig();
    config1.pipelineSettings.selfCheckAutoIterations = 99;

    rmSync(configPath());

    const config2 = loadConfig();
    expect(config2.pipelineSettings.selfCheckAutoIterations).toBe(3);
  });

  test("partially valid pipelineSettings keeps valid values", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        pipelineSettings: {
          selfCheckAutoIterations: 10,
          reviewAutoRounds: -1,
          inactivityTimeoutMinutes: "bad",
          autoResumeAttempts: 5,
        },
      }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings.selfCheckAutoIterations).toBe(10);
    expect(config.pipelineSettings.reviewAutoRounds).toBe(3);
    expect(config.pipelineSettings.inactivityTimeoutMinutes).toBe(15);
    expect(config.pipelineSettings.autoResumeAttempts).toBe(5);
  });

  test("pipelineSettings null falls back to defaults", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: [], pipelineSettings: null }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 3,
      reviewAutoRounds: 3,
      inactivityTimeoutMinutes: 15,
      autoResumeAttempts: 3,
    });
  });

  test("pipelineSettings array falls back to defaults", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: [], pipelineSettings: [1, 2, 3] }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 3,
      reviewAutoRounds: 3,
      inactivityTimeoutMinutes: 15,
      autoResumeAttempts: 3,
    });
  });
});

describe("saveConfig", () => {
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const defaultPS = {
    selfCheckAutoIterations: 3,
    reviewAutoRounds: 3,
    inactivityTimeoutMinutes: 15,
    autoResumeAttempts: 3,
  };

  test("creates directories and writes config", () => {
    const config = {
      owners: ["org1"],
      cloneBaseDir: "~/code",
      language: "ko" as const,
      pipelineSettings: { ...defaultPS },
    };
    saveConfig(config);
    const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(raw).toEqual(config);
  });

  test("written file ends with newline", () => {
    saveConfig({
      owners: [],
      cloneBaseDir: "~/x",
      language: "en",
      pipelineSettings: { ...defaultPS },
    });
    const content = readFileSync(configPath(), "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });

  test("overwrites existing config", () => {
    saveConfig({
      owners: ["a"],
      cloneBaseDir: "~/x",
      language: "en",
      pipelineSettings: { ...defaultPS },
    });
    saveConfig({
      owners: ["b"],
      cloneBaseDir: "~/y",
      language: "ko",
      pipelineSettings: { ...defaultPS, reviewAutoRounds: 5 },
    });
    const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(raw.owners).toEqual(["b"]);
    expect(raw.cloneBaseDir).toBe("~/y");
    expect(raw.language).toBe("ko");
    expect(raw.pipelineSettings.reviewAutoRounds).toBe(5);
  });

  test("roundtrips correctly with loadConfig", () => {
    const original = {
      owners: ["aicers", "my-org"],
      cloneBaseDir: "~/dev",
      language: "ko" as const,
      pipelineSettings: { ...defaultPS, inactivityTimeoutMinutes: 30 },
    };
    saveConfig(original);
    const loaded = loadConfig();
    expect(loaded).toEqual(original);
  });
});
