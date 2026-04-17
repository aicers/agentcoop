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
        selfCheckAutoIterations: 5,
        reviewAutoRounds: 5,
        ciCheckAutoIterations: 3,
        ciCheckTimeoutMinutes: 10,
        inactivityTimeoutMinutes: 20,
        autoResumeAttempts: 3,
      },
      notifications: { bell: true, desktop: false },
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
        selfCheckAutoIterations: 5,
        reviewAutoRounds: 5,
        ciCheckAutoIterations: 3,
        ciCheckTimeoutMinutes: 10,
        inactivityTimeoutMinutes: 20,
        autoResumeAttempts: 3,
      },
      notifications: { bell: true, desktop: false },
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
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
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
          ciCheckAutoIterations: 4,
          ciCheckTimeoutMinutes: 15,
          inactivityTimeoutMinutes: 30,
          autoResumeAttempts: 1,
        },
      }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 2,
      ciCheckAutoIterations: 4,
      ciCheckTimeoutMinutes: 15,
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
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
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
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
      autoResumeAttempts: 3,
    });
  });

  test("pipelineSettings defaults are isolated from mutations", () => {
    const config1 = loadConfig();
    config1.pipelineSettings.selfCheckAutoIterations = 99;

    rmSync(configPath());

    const config2 = loadConfig();
    expect(config2.pipelineSettings.selfCheckAutoIterations).toBe(5);
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
    expect(config.pipelineSettings.reviewAutoRounds).toBe(5);
    expect(config.pipelineSettings.inactivityTimeoutMinutes).toBe(20);
    expect(config.pipelineSettings.autoResumeAttempts).toBe(5);
  });

  test("zero values fall back to defaults (must be positive)", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        pipelineSettings: {
          selfCheckAutoIterations: 0,
          reviewAutoRounds: 0,
          inactivityTimeoutMinutes: 0,
          autoResumeAttempts: 0,
        },
      }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
      autoResumeAttempts: 3,
    });
  });

  test("very large values are accepted", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        pipelineSettings: {
          selfCheckAutoIterations: 999999,
          reviewAutoRounds: 100,
          inactivityTimeoutMinutes: 1440,
          autoResumeAttempts: 50,
        },
      }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings.selfCheckAutoIterations).toBe(999999);
    expect(config.pipelineSettings.inactivityTimeoutMinutes).toBe(1440);
  });

  test("float values fall back to defaults (must be integer)", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        pipelineSettings: {
          selfCheckAutoIterations: 3.5,
          reviewAutoRounds: 2.1,
          inactivityTimeoutMinutes: 20.5,
          autoResumeAttempts: 1.9,
        },
      }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
      autoResumeAttempts: 3,
    });
  });

  test("string number values fall back to defaults (type check)", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        pipelineSettings: {
          selfCheckAutoIterations: "3",
          reviewAutoRounds: "3",
          inactivityTimeoutMinutes: "20",
          autoResumeAttempts: "3",
        },
      }),
    );
    const config = loadConfig();
    // Strings are not valid — all should fall back.
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
      autoResumeAttempts: 3,
    });
  });

  test("boolean values fall back to defaults", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        pipelineSettings: {
          selfCheckAutoIterations: true,
          reviewAutoRounds: false,
          inactivityTimeoutMinutes: true,
          autoResumeAttempts: false,
        },
      }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
      autoResumeAttempts: 3,
    });
  });

  test("pipelineSettings null falls back to defaults", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: [], pipelineSettings: null }),
    );
    const config = loadConfig();
    expect(config.pipelineSettings).toEqual({
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
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
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 5,
      ciCheckAutoIterations: 3,
      ciCheckTimeoutMinutes: 10,
      inactivityTimeoutMinutes: 20,
      autoResumeAttempts: 3,
    });
  });

  // ---- notifications -------------------------------------------------------

  test("default config includes notification defaults", () => {
    const config = loadConfig();
    expect(config.notifications).toEqual({ bell: true, desktop: false });
  });

  test("reads saved notification settings", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        notifications: { bell: false, desktop: true },
      }),
    );
    const config = loadConfig();
    expect(config.notifications).toEqual({ bell: false, desktop: true });
  });

  test("fills missing notification fields with defaults", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: [], notifications: { desktop: true } }),
    );
    const config = loadConfig();
    expect(config.notifications).toEqual({ bell: true, desktop: true });
  });

  test("falls back to defaults for non-boolean notification values", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        notifications: { bell: "yes", desktop: 1 },
      }),
    );
    const config = loadConfig();
    expect(config.notifications).toEqual({ bell: true, desktop: false });
  });

  test("falls back to defaults when notifications is not an object", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: [], notifications: "on" }),
    );
    const config = loadConfig();
    expect(config.notifications).toEqual({ bell: true, desktop: false });
  });

  test("notifications null falls back to defaults", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: [], notifications: null }),
    );
    const config = loadConfig();
    expect(config.notifications).toEqual({ bell: true, desktop: false });
  });

  test("notifications array falls back to defaults", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: [], notifications: [true, false] }),
    );
    const config = loadConfig();
    expect(config.notifications).toEqual({ bell: true, desktop: false });
  });

  test("notification defaults are isolated from mutations", () => {
    const config1 = loadConfig();
    (config1.notifications as Record<string, unknown>).bell = false;

    rmSync(configPath());

    const config2 = loadConfig();
    expect(config2.notifications.bell).toBe(true);
  });

  // ---- customModels -----------------------------------------------------------

  test("default config has no customModels", () => {
    const config = loadConfig();
    expect(config.customModels).toBeUndefined();
  });

  test("reads valid customModels with both CLIs", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        customModels: {
          claude: [{ name: "Claude Opus 4.7", value: "claude-opus-4-7" }],
          codex: [{ name: "GPT-6", value: "gpt-6" }],
        },
      }),
    );
    const config = loadConfig();
    expect(config.customModels).toEqual({
      claude: [{ name: "Claude Opus 4.7", value: "claude-opus-4-7" }],
      codex: [{ name: "GPT-6", value: "gpt-6" }],
    });
  });

  test("reads customModels with only one CLI key", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        customModels: {
          claude: [{ name: "My Model", value: "my-model" }],
        },
      }),
    );
    const config = loadConfig();
    expect(config.customModels?.claude).toEqual([
      { name: "My Model", value: "my-model" },
    ]);
    expect(config.customModels?.codex).toBeUndefined();
  });

  test("filters out malformed entries in customModels arrays", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        customModels: {
          claude: [
            { name: "Valid", value: "valid" },
            { name: 42, value: "bad-name" },
            { name: "Missing Value" },
            "not-an-object",
            null,
            { name: "Also Valid", value: "also-valid" },
          ],
        },
      }),
    );
    const config = loadConfig();
    expect(config.customModels?.claude).toEqual([
      { name: "Valid", value: "valid" },
      { name: "Also Valid", value: "also-valid" },
    ]);
  });

  test("returns undefined customModels when all entries are invalid", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        customModels: {
          claude: [{ bad: true }, null],
          codex: ["not-object"],
        },
      }),
    );
    const config = loadConfig();
    expect(config.customModels).toBeUndefined();
  });

  test("returns undefined customModels when value is not an object", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: [], customModels: "invalid" }),
    );
    const config = loadConfig();
    expect(config.customModels).toBeUndefined();
  });

  test("returns undefined customModels when value is null", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: [], customModels: null }),
    );
    const config = loadConfig();
    expect(config.customModels).toBeUndefined();
  });

  test("returns undefined customModels when value is an array", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ owners: [], customModels: [1, 2] }),
    );
    const config = loadConfig();
    expect(config.customModels).toBeUndefined();
  });

  test("returns undefined customModels when CLI key is not an array", () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        owners: [],
        customModels: { claude: "not-array", codex: 42 },
      }),
    );
    const config = loadConfig();
    expect(config.customModels).toBeUndefined();
  });

  test("customModels roundtrips with saveConfig", () => {
    const config = loadConfig();
    config.customModels = {
      claude: [{ name: "Test Model", value: "test-model" }],
    };
    saveConfig(config);
    const reloaded = loadConfig();
    expect(reloaded.customModels).toEqual({
      claude: [{ name: "Test Model", value: "test-model" }],
    });
  });
});

describe("saveConfig", () => {
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const defaultPS = {
    selfCheckAutoIterations: 5,
    reviewAutoRounds: 5,
    ciCheckAutoIterations: 3,
    ciCheckTimeoutMinutes: 10,
    inactivityTimeoutMinutes: 20,
    autoResumeAttempts: 3,
  };

  const defaultNotif = { bell: true, desktop: false };

  test("creates directories and writes config", () => {
    const config = {
      owners: ["org1"],
      cloneBaseDir: "~/code",
      language: "ko" as const,
      pipelineSettings: { ...defaultPS },
      notifications: { ...defaultNotif },
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
      notifications: { ...defaultNotif },
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
      notifications: { ...defaultNotif },
    });
    saveConfig({
      owners: ["b"],
      cloneBaseDir: "~/y",
      language: "ko",
      pipelineSettings: { ...defaultPS, reviewAutoRounds: 5 },
      notifications: { bell: false, desktop: true },
    });
    const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
    expect(raw.owners).toEqual(["b"]);
    expect(raw.cloneBaseDir).toBe("~/y");
    expect(raw.language).toBe("ko");
    expect(raw.pipelineSettings.reviewAutoRounds).toBe(5);
    expect(raw.notifications).toEqual({ bell: false, desktop: true });
  });

  test("roundtrips correctly with loadConfig", () => {
    const original = {
      owners: ["aicers", "my-org"],
      cloneBaseDir: "~/dev",
      language: "ko" as const,
      pipelineSettings: { ...defaultPS, inactivityTimeoutMinutes: 30 },
      notifications: { bell: false, desktop: true },
    };
    saveConfig(original);
    const loaded = loadConfig();
    expect(loaded).toEqual(original);
  });
});
