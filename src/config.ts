import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface PipelineSettings {
  selfCheckAutoIterations: number;
  reviewAutoRounds: number;
  inactivityTimeoutMinutes: number;
  autoResumeAttempts: number;
}

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = {
  selfCheckAutoIterations: 5,
  reviewAutoRounds: 5,
  inactivityTimeoutMinutes: 20,
  autoResumeAttempts: 3,
};

export interface SavedAgentConfig {
  cli: "claude" | "codex";
  model: string;
  contextWindow?: string;
  effortLevel?: string;
}

export interface Config {
  owners: string[];
  cloneBaseDir: string;
  language: "en" | "ko";
  pipelineSettings: PipelineSettings;
  agentA?: SavedAgentConfig;
  agentB?: SavedAgentConfig;
  executionMode?: "auto" | "step";
}

const DEFAULT_CONFIG: Config = {
  owners: [],
  cloneBaseDir: "~/projects",
  language: "en",
  pipelineSettings: { ...DEFAULT_PIPELINE_SETTINGS },
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
    };
  }
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ...DEFAULT_CONFIG,
      owners: [...DEFAULT_CONFIG.owners],
      pipelineSettings: { ...DEFAULT_CONFIG.pipelineSettings },
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
    agentA: loadSavedAgentConfig(raw.agentA),
    agentB: loadSavedAgentConfig(raw.agentB),
    executionMode:
      raw.executionMode === "auto" || raw.executionMode === "step"
        ? raw.executionMode
        : undefined,
  };
}

export function saveConfig(config: Config): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
