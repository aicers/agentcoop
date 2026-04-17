import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getModelDisplayName,
  getModels,
  initModels,
  isOpusModel,
  loadModelsFile,
  ModelsLoadError,
  setCustomModels,
} from "./models.js";

const tmpDir = join(import.meta.dirname, "..", ".tmp-test-models");

function tmpPath(name = "models.json"): string {
  return join(tmpDir, name);
}

function writeModels(data: unknown, name = "models.json"): string {
  const path = tmpPath(name);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

// ---- loadModelsFile ---------------------------------------------------------

describe("loadModelsFile", () => {
  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("parses valid models.json", () => {
    const path = writeModels({
      claude: [{ name: "Claude Opus 4.6", value: "opus" }],
      codex: [{ name: "GPT-5.4", value: "gpt-5.4" }],
    });
    const result = loadModelsFile(path);
    expect(result.claude).toEqual([{ name: "Claude Opus 4.6", value: "opus" }]);
    expect(result.codex).toEqual([{ name: "GPT-5.4", value: "gpt-5.4" }]);
  });

  test("parses multiple entries per CLI", () => {
    const path = writeModels({
      claude: [
        { name: "Claude Opus 4.6", value: "opus" },
        { name: "Claude Sonnet 4.6", value: "sonnet" },
      ],
      codex: [
        { name: "GPT-5.4", value: "gpt-5.4" },
        { name: "GPT-5.3-Codex", value: "gpt-5.3-codex" },
      ],
    });
    const result = loadModelsFile(path);
    expect(result.claude).toHaveLength(2);
    expect(result.codex).toHaveLength(2);
  });

  test("throws ModelsLoadError when file is missing", () => {
    expect(() => loadModelsFile(join(tmpDir, "nonexistent.json"))).toThrow(
      ModelsLoadError,
    );
  });

  test("throws ModelsLoadError on invalid JSON", () => {
    const path = tmpPath();
    writeFileSync(path, "{ broken json");
    expect(() => loadModelsFile(path)).toThrow(ModelsLoadError);
    expect(() => loadModelsFile(path)).toThrow("invalid JSON");
  });

  test("throws ModelsLoadError when root is not an object", () => {
    const path = writeModels([1, 2, 3]);
    expect(() => loadModelsFile(path)).toThrow(ModelsLoadError);
    expect(() => loadModelsFile(path)).toThrow("must contain an object");
  });

  test("throws ModelsLoadError when root is null", () => {
    const path = tmpPath();
    writeFileSync(path, "null");
    expect(() => loadModelsFile(path)).toThrow(ModelsLoadError);
  });

  test("throws ModelsLoadError when claude key is not an array", () => {
    const path = writeModels({
      claude: "not-an-array",
      codex: [],
    });
    expect(() => loadModelsFile(path)).toThrow(ModelsLoadError);
    expect(() => loadModelsFile(path)).toThrow('"claude" must be an array');
  });

  test("throws ModelsLoadError when codex key is not an array", () => {
    const path = writeModels({
      claude: [],
      codex: { foo: "bar" },
    });
    expect(() => loadModelsFile(path)).toThrow(ModelsLoadError);
    expect(() => loadModelsFile(path)).toThrow('"codex" must be an array');
  });

  test("throws ModelsLoadError when claude key is missing", () => {
    const path = writeModels({
      codex: [{ name: "GPT-5.4", value: "gpt-5.4" }],
    });
    expect(() => loadModelsFile(path)).toThrow(ModelsLoadError);
  });

  test("throws ModelsLoadError when entry is missing name", () => {
    const path = writeModels({
      claude: [{ value: "opus" }],
      codex: [],
    });
    expect(() => loadModelsFile(path)).toThrow(ModelsLoadError);
    expect(() => loadModelsFile(path)).toThrow('string "name" and "value"');
  });

  test("throws ModelsLoadError when entry is missing value", () => {
    const path = writeModels({
      claude: [{ name: "Claude Opus 4.6" }],
      codex: [],
    });
    expect(() => loadModelsFile(path)).toThrow(ModelsLoadError);
  });

  test("throws ModelsLoadError when entry has non-string name", () => {
    const path = writeModels({
      claude: [{ name: 42, value: "opus" }],
      codex: [],
    });
    expect(() => loadModelsFile(path)).toThrow(ModelsLoadError);
  });

  test("throws ModelsLoadError when entry is a primitive", () => {
    const path = writeModels({
      claude: ["not-an-object"],
      codex: [],
    });
    expect(() => loadModelsFile(path)).toThrow(ModelsLoadError);
    expect(() => loadModelsFile(path)).toThrow("must be objects");
  });

  test("accepts empty arrays", () => {
    const path = writeModels({ claude: [], codex: [] });
    const result = loadModelsFile(path);
    expect(result.claude).toEqual([]);
    expect(result.codex).toEqual([]);
  });
});

// ---- initModels + getModels -------------------------------------------------

describe("getModels", () => {
  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    const path = writeModels({
      claude: [
        { name: "Claude Opus 4.6", value: "opus" },
        { name: "Claude Sonnet 4.6", value: "sonnet" },
      ],
      codex: [{ name: "GPT-5.4", value: "gpt-5.4" }],
    });
    initModels(path);
    setCustomModels({});
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns defaults when no customs", () => {
    const models = getModels("claude");
    expect(models).toEqual([
      { name: "Claude Opus 4.6", value: "opus" },
      { name: "Claude Sonnet 4.6", value: "sonnet" },
    ]);
  });

  test("returns codex defaults", () => {
    expect(getModels("codex")).toEqual([{ name: "GPT-5.4", value: "gpt-5.4" }]);
  });

  test("merges customs after defaults", () => {
    setCustomModels({
      claude: [{ name: "Claude Opus 4.7", value: "claude-opus-4-7" }],
    });
    const models = getModels("claude");
    expect(models).toEqual([
      { name: "Claude Opus 4.6", value: "opus" },
      { name: "Claude Sonnet 4.6", value: "sonnet" },
      { name: "Claude Opus 4.7", value: "claude-opus-4-7" },
    ]);
  });

  test("defaults win over customs with same value", () => {
    setCustomModels({
      claude: [{ name: "My Custom Opus", value: "opus" }],
    });
    const models = getModels("claude");
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ name: "Claude Opus 4.6", value: "opus" });
  });

  test("custom codex models append after defaults", () => {
    setCustomModels({
      codex: [{ name: "GPT-6", value: "gpt-6" }],
    });
    expect(getModels("codex")).toEqual([
      { name: "GPT-5.4", value: "gpt-5.4" },
      { name: "GPT-6", value: "gpt-6" },
    ]);
  });

  test("missing CLI key in customs treated as empty", () => {
    setCustomModels({ claude: [{ name: "New", value: "new" }] });
    // codex should still return just defaults
    expect(getModels("codex")).toEqual([{ name: "GPT-5.4", value: "gpt-5.4" }]);
  });

  test("setCustomModels with undefined resets customs", () => {
    setCustomModels({
      claude: [{ name: "X", value: "x" }],
    });
    expect(getModels("claude")).toHaveLength(3);
    setCustomModels(undefined);
    expect(getModels("claude")).toHaveLength(2);
  });

  test("deduplicates within customs", () => {
    setCustomModels({
      claude: [
        { name: "A", value: "custom-a" },
        { name: "A duplicate", value: "custom-a" },
      ],
    });
    const models = getModels("claude");
    const customA = models.filter((m) => m.value === "custom-a");
    expect(customA).toHaveLength(1);
    expect(customA[0].name).toBe("A");
  });
});

// ---- isOpusModel ------------------------------------------------------------

describe("isOpusModel", () => {
  test("recognises the short alias", () => {
    expect(isOpusModel("opus")).toBe(true);
  });

  test("recognises explicit Opus IDs", () => {
    expect(isOpusModel("claude-opus-4-6")).toBe(true);
    expect(isOpusModel("claude-opus-4-7")).toBe(true);
    expect(isOpusModel("claude-opus-5-0")).toBe(true);
  });

  test("rejects non-Opus models", () => {
    expect(isOpusModel("sonnet")).toBe(false);
    expect(isOpusModel("haiku")).toBe(false);
    expect(isOpusModel("claude-sonnet-4-6")).toBe(false);
    expect(isOpusModel("claude-haiku-4-5")).toBe(false);
    expect(isOpusModel("gpt-5.4")).toBe(false);
  });

  test("rejects partial matches", () => {
    expect(isOpusModel("opus-extra")).toBe(false);
    expect(isOpusModel("my-opus")).toBe(false);
    expect(isOpusModel("claude-opus")).toBe(false);
  });
});

// ---- getModelDisplayName ----------------------------------------------------

describe("getModelDisplayName", () => {
  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    const path = writeModels({
      claude: [{ name: "Claude Opus 4.6", value: "opus" }],
      codex: [{ name: "GPT-5.4", value: "gpt-5.4" }],
    });
    initModels(path);
    setCustomModels({});
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns display name for known model", () => {
    expect(getModelDisplayName("claude", "opus")).toBe("Claude Opus 4.6");
    expect(getModelDisplayName("codex", "gpt-5.4")).toBe("GPT-5.4");
  });

  test("falls back to raw value for unknown model", () => {
    expect(getModelDisplayName("claude", "claude-opus-4-7")).toBe(
      "claude-opus-4-7",
    );
  });

  test("resolves custom model display name", () => {
    setCustomModels({
      claude: [{ name: "Claude Opus 4.7", value: "claude-opus-4-7" }],
    });
    expect(getModelDisplayName("claude", "claude-opus-4-7")).toBe(
      "Claude Opus 4.7",
    );
  });
});
