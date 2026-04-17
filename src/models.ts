import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ModelEntry {
  name: string;
  value: string;
}

export type CliType = "claude" | "codex";

interface ModelsFile {
  claude: ModelEntry[];
  codex: ModelEntry[];
}

/**
 * Thrown when `models.json` cannot be loaded or has an invalid shape.
 *
 * The entry point catches this and treats it as a startup-blocking
 * failure — `models.json` ships with the release and must be present.
 */
export class ModelsLoadError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ModelsLoadError";
  }
}

// ---- module state -----------------------------------------------------------

let defaults: ModelsFile | undefined;
let customs: Record<CliType, ModelEntry[]> = { claude: [], codex: [] };

// ---- loading & validation ---------------------------------------------------

function parseModelArray(raw: unknown, key: string): ModelEntry[] {
  if (!Array.isArray(raw)) {
    throw new ModelsLoadError(`"${key}" must be an array`);
  }
  const result: ModelEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ModelsLoadError(`entries in "${key}" must be objects`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || typeof e.value !== "string") {
      throw new ModelsLoadError(
        `entries in "${key}" must have string "name" and "value"`,
      );
    }
    result.push({ name: e.name, value: e.value });
  }
  return result;
}

/**
 * Read and validate `models.json`.
 *
 * @param filePath  Explicit path; defaults to `../models.json` relative
 *                  to this compiled module (i.e. repo root).
 */
export function loadModelsFile(filePath?: string): ModelsFile {
  const path =
    filePath ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "models.json");
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    throw new ModelsLoadError(
      `Cannot read models.json at ${path}: ${err instanceof Error ? err.message : err}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new ModelsLoadError("models.json contains invalid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ModelsLoadError("models.json must contain an object");
  }
  const obj = raw as Record<string, unknown>;
  return {
    claude: parseModelArray(obj.claude, "claude"),
    codex: parseModelArray(obj.codex, "codex"),
  };
}

// ---- registry lifecycle -----------------------------------------------------

/**
 * Load `models.json` and store the repo-shipped defaults.
 *
 * Must be called once at startup before any `getModels` /
 * `getModelDisplayName` calls.
 *
 * @throws {ModelsLoadError} when the file is missing, unreadable,
 *         contains invalid JSON, or has a shape mismatch.
 */
export function initModels(modelsJsonPath?: string): void {
  defaults = loadModelsFile(modelsJsonPath);
}

/**
 * Replace the user-defined custom models used for merging.
 *
 * Call after `initModels` whenever the config is (re)loaded or a new
 * custom model is persisted.
 */
export function setCustomModels(custom?: {
  claude?: ModelEntry[];
  codex?: ModelEntry[];
}): void {
  customs = {
    claude: custom?.claude ?? [],
    codex: custom?.codex ?? [],
  };
}

// ---- queries ----------------------------------------------------------------

function mergeModels(base: ModelEntry[], extra: ModelEntry[]): ModelEntry[] {
  const seen = new Set<string>();
  const result: ModelEntry[] = [];
  for (const entry of base) {
    if (!seen.has(entry.value)) {
      seen.add(entry.value);
      result.push(entry);
    }
  }
  for (const entry of extra) {
    if (!seen.has(entry.value)) {
      seen.add(entry.value);
      result.push(entry);
    }
  }
  return result;
}

/**
 * Return only the repo-default model list for a CLI (from `models.json`).
 *
 * This excludes user-defined custom models and is useful for duplicate
 * checks that must distinguish repo defaults from customs.
 */
export function getDefaultModels(cli: CliType): ModelEntry[] {
  if (!defaults) {
    throw new Error("Model registry not initialized — call initModels() first");
  }
  return defaults[cli];
}

/**
 * Return the merged model list for a CLI (repo defaults + user customs).
 *
 * Repo defaults appear first; user customs are appended.  Duplicate
 * `value` entries keep the first occurrence (repo defaults win).
 */
export function getModels(cli: CliType): ModelEntry[] {
  if (!defaults) {
    throw new Error("Model registry not initialized — call initModels() first");
  }
  return mergeModels(defaults[cli], customs[cli]);
}

/**
 * Return `true` when the model value refers to a Claude Opus variant.
 *
 * Recognises the short alias (`"opus"`) and explicit IDs that follow
 * the `claude-opus-*` naming convention (e.g. `claude-opus-4-7`).
 */
export function isOpusModel(value: string): boolean {
  return value === "opus" || value.startsWith("claude-opus-");
}

/**
 * Look up the display name for a model value, falling back to the raw
 * value when not found.
 */
export function getModelDisplayName(cli: CliType, value: string): string {
  const models = getModels(cli);
  return models.find((m) => m.value === value)?.name ?? value;
}
