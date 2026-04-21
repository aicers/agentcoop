import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PipelineSettings {
  selfCheckAutoIterations: number;
  reviewAutoRounds: number;
  ciCheckAutoIterations: number;
  ciCheckTimeoutMinutes: number;
  inactivityTimeoutMinutes: number;
  autoResumeAttempts: number;
}

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = {
  selfCheckAutoIterations: 5,
  reviewAutoRounds: 5,
  ciCheckAutoIterations: 3,
  ciCheckTimeoutMinutes: 10,
  inactivityTimeoutMinutes: 20,
  autoResumeAttempts: 3,
};

export interface SavedAgentConfig {
  cli: "claude" | "codex";
  model: string;
  contextWindow?: string;
  effortLevel?: string;
}

export interface NotificationSettings {
  bell: boolean;
  desktop: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  bell: true,
  desktop: false,
};

export interface Config {
  owners: string[];
  cloneBaseDir: string;
  language: "en" | "ko";
  pipelineSettings: PipelineSettings;
  notifications: NotificationSettings;
  agentA?: SavedAgentConfig;
  agentB?: SavedAgentConfig;
  executionMode?: "auto" | "step";
  customModels?: {
    claude?: Array<{ name: string; value: string }>;
    codex?: Array<{ name: string; value: string }>;
  };
  /**
   * Most recently observed CLI versions, updated after the startup
   * version check.  Used as the "previous" side of the comparison on
   * the next run so the user can spot regressions across runs.
   */
  lastKnownVersions?: {
    claude?: string;
    codex?: string;
  };
  /** When `true`, the startup version check is skipped entirely. */
  skipVersionCheck?: boolean;
  /**
   * Epoch milliseconds of the last successful version check.  Used to
   * throttle network calls to roughly once per 24h.
   */
  lastVersionCheckAt?: number;
}

const DEFAULT_CONFIG: Config = {
  owners: [],
  cloneBaseDir: "~/projects",
  language: "en",
  pipelineSettings: { ...DEFAULT_PIPELINE_SETTINGS },
  notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
};

export function configPath(): string {
  return join(homedir(), ".agentcoop", "config.json");
}

const VALID_LANGUAGES = new Set<Config["language"]>(["en", "ko"]);

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function loadSavedAgentConfig(raw: unknown): SavedAgentConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (r.cli !== "claude" && r.cli !== "codex") return undefined;
  if (typeof r.model !== "string") return undefined;
  return {
    cli: r.cli,
    model: r.model,
    contextWindow:
      typeof r.contextWindow === "string" ? r.contextWindow : undefined,
    effortLevel: typeof r.effortLevel === "string" ? r.effortLevel : undefined,
  };
}

function loadModelEntries(
  raw: unknown,
): Array<{ name: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is { name: string; value: string } =>
        typeof e === "object" &&
        e !== null &&
        !Array.isArray(e) &&
        typeof (e as Record<string, unknown>).name === "string" &&
        typeof (e as Record<string, unknown>).value === "string",
    )
    .map((e) => ({ name: e.name, value: e.value }));
}

function loadLastKnownVersions(
  raw: unknown,
): Config["lastKnownVersions"] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const result: NonNullable<Config["lastKnownVersions"]> = {};
  if (typeof r.claude === "string") result.claude = r.claude;
  if (typeof r.codex === "string") result.codex = r.codex;
  if (result.claude === undefined && result.codex === undefined) {
    return undefined;
  }
  return result;
}

function loadCustomModels(raw: unknown): Config["customModels"] | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const claude = loadModelEntries(r.claude);
  const codex = loadModelEntries(r.codex);
  if (claude.length === 0 && codex.length === 0) return undefined;
  const result: NonNullable<Config["customModels"]> = {};
  if (claude.length > 0) result.claude = claude;
  if (codex.length > 0) result.codex = codex;
  return result;
}

function loadNotificationSettings(raw: unknown): NotificationSettings {
  const d = DEFAULT_NOTIFICATION_SETTINGS;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...d };
  }
  const r = raw as Record<string, unknown>;
  return {
    bell: typeof r.bell === "boolean" ? r.bell : d.bell,
    desktop: typeof r.desktop === "boolean" ? r.desktop : d.desktop,
  };
}

function loadPipelineSettings(raw: unknown): PipelineSettings {
  const d = DEFAULT_PIPELINE_SETTINGS;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...d };
  }
  const r = raw as Record<string, unknown>;
  return {
    selfCheckAutoIterations: isPositiveInt(r.selfCheckAutoIterations)
      ? r.selfCheckAutoIterations
      : d.selfCheckAutoIterations,
    reviewAutoRounds: isPositiveInt(r.reviewAutoRounds)
      ? r.reviewAutoRounds
      : d.reviewAutoRounds,
    ciCheckAutoIterations: isPositiveInt(r.ciCheckAutoIterations)
      ? r.ciCheckAutoIterations
      : d.ciCheckAutoIterations,
    ciCheckTimeoutMinutes: isPositiveInt(r.ciCheckTimeoutMinutes)
      ? r.ciCheckTimeoutMinutes
      : d.ciCheckTimeoutMinutes,
    inactivityTimeoutMinutes: isPositiveInt(r.inactivityTimeoutMinutes)
      ? r.inactivityTimeoutMinutes
      : d.inactivityTimeoutMinutes,
    autoResumeAttempts: isPositiveInt(r.autoResumeAttempts)
      ? r.autoResumeAttempts
      : d.autoResumeAttempts,
  };
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    saveConfig(DEFAULT_CONFIG);
    return {
      ...DEFAULT_CONFIG,
      owners: [...DEFAULT_CONFIG.owners],
      pipelineSettings: { ...DEFAULT_CONFIG.pipelineSettings },
      notifications: { ...DEFAULT_CONFIG.notifications },
    };
  }
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ...DEFAULT_CONFIG,
      owners: [...DEFAULT_CONFIG.owners],
      pipelineSettings: { ...DEFAULT_CONFIG.pipelineSettings },
      notifications: { ...DEFAULT_CONFIG.notifications },
    };
  }
  const language = VALID_LANGUAGES.has(raw.language)
    ? raw.language
    : DEFAULT_CONFIG.language;
  return {
    owners: Array.isArray(raw.owners)
      ? raw.owners
          .filter((o: unknown) => typeof o === "string" && o.trim() !== "")
          .map((o: string) => o.trim())
      : DEFAULT_CONFIG.owners,
    cloneBaseDir:
      typeof raw.cloneBaseDir === "string"
        ? raw.cloneBaseDir
        : DEFAULT_CONFIG.cloneBaseDir,
    language,
    pipelineSettings: loadPipelineSettings(raw.pipelineSettings),
    notifications: loadNotificationSettings(raw.notifications),
    agentA: loadSavedAgentConfig(raw.agentA),
    agentB: loadSavedAgentConfig(raw.agentB),
    executionMode:
      raw.executionMode === "auto" || raw.executionMode === "step"
        ? raw.executionMode
        : undefined,
    customModels: loadCustomModels(raw.customModels),
    lastKnownVersions: loadLastKnownVersions(raw.lastKnownVersions),
    skipVersionCheck:
      typeof raw.skipVersionCheck === "boolean"
        ? raw.skipVersionCheck
        : undefined,
    lastVersionCheckAt:
      typeof raw.lastVersionCheckAt === "number" &&
      Number.isFinite(raw.lastVersionCheckAt)
        ? raw.lastVersionCheckAt
        : undefined,
  };
}

/**
 * Assembles the CI-check stage definition fragment from pipeline settings.
 *
 * Accepts a factory that builds the stage handler (so the caller can
 * inject agent/issue context) and returns the handler spread with
 * `autoBudget` set.  This keeps the minutes→ms conversion and the
 * settings→stage wiring in one testable place, independent of the CLI
 * entry point.
 */
export function assembleCiCheckStage<T>(
  createHandler: (opts: { pollTimeoutMs: number }) => T,
  settings: PipelineSettings,
): T & { autoBudget: number } {
  return {
    ...createHandler({
      pollTimeoutMs: settings.ciCheckTimeoutMinutes * 60_000,
    }),
    autoBudget: settings.ciCheckAutoIterations,
  };
}

/**
 * Assembles the squash stage definition fragment from pipeline settings.
 *
 * Keeps the minutes→ms conversion in one testable place, matching the
 * pattern used by {@link assembleCiCheckStage}.
 */
export function assembleSquashStage<T>(
  createHandler: (opts: { pollTimeoutMs: number }) => T,
  settings: PipelineSettings,
): T {
  return createHandler({
    pollTimeoutMs: settings.ciCheckTimeoutMinutes * 60_000,
  });
}

/**
 * Assembles the review stage definition fragment from pipeline settings.
 *
 * Converts `ciCheckTimeoutMinutes` to `pollTimeoutMs` and maps
 * `reviewAutoRounds` to `autoBudget`, keeping the settings→stage wiring
 * in one testable place.
 */
export function assembleReviewStage<T>(
  createHandler: (opts: { pollTimeoutMs: number }) => T,
  settings: PipelineSettings,
): T & { autoBudget: number } {
  return {
    ...createHandler({
      pollTimeoutMs: settings.ciCheckTimeoutMinutes * 60_000,
    }),
    autoBudget: settings.reviewAutoRounds,
  };
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Patch only the version-check state fields in `~/.agentcoop/config.json`
 * without round-tripping through the normalized `Config` shape.
 *
 * `loadConfig` / `saveConfig` drop top-level keys that the schema does
 * not recognize, so using `saveConfig` to persist these fields would
 * silently delete any unknown entries a user or future version may have
 * added.  This helper reads the raw JSON, merges the supplied fields,
 * and writes the file back, preserving unknown keys.
 */
export function patchVersionCheckState(updates: {
  lastKnownVersions?: NonNullable<Config["lastKnownVersions"]>;
  lastVersionCheckAt?: number;
}): void {
  const path = configPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // Unreadable or invalid JSON — fall through and write a fresh file.
    }
  }
  if (updates.lastKnownVersions !== undefined) {
    // Merge against the existing nested object instead of replacing
    // it wholesale.  `loadLastKnownVersions` filters the runtime view
    // down to `{ claude?, codex? }`, so an `updates.lastKnownVersions`
    // built from that view does not know about other CLI entries
    // (e.g. a `gemini` field a future AgentCoop version may write, or
    // a hand-added user entry).  Replacing would silently drop those
    // — the same class of failure that motivated this helper for
    // unknown top-level keys.
    const existing =
      typeof raw.lastKnownVersions === "object" &&
      raw.lastKnownVersions !== null &&
      !Array.isArray(raw.lastKnownVersions)
        ? (raw.lastKnownVersions as Record<string, unknown>)
        : {};
    raw.lastKnownVersions = { ...existing, ...updates.lastKnownVersions };
  }
  if (updates.lastVersionCheckAt !== undefined) {
    raw.lastVersionCheckAt = updates.lastVersionCheckAt;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}
