import { checkbox, confirm, input, search, select } from "@inquirer/prompts";
import type { Config, PipelineSettings } from "./config.js";
import { loadConfig, saveConfig } from "./config.js";
import type { Issue } from "./github.js";
import { getIssue, listRepositories } from "./github.js";
import { initI18n, t } from "./i18n/index.js";

export interface TargetResult {
  owner: string;
  repo: string;
  issueNumber: number;
  config: Config;
  configDirty: boolean;
}

export interface StartupResult {
  owner: string;
  repo: string;
  issue: Issue;
  agentA: AgentConfig;
  agentB: AgentConfig;
  executionMode: "auto" | "step";
  claudePermissionMode: "auto" | "bypass";
  language: "en" | "ko";
  pipelineSettings: PipelineSettings;
}

export interface AgentConfig {
  model: string;
}

const CLAUDE_MODELS = [
  { name: "Claude Opus 4", value: "opus" },
  { name: "Claude Sonnet 4", value: "sonnet" },
];

const CODEX_MODELS = [
  { name: "GPT-5.4", value: "gpt-5.4" },
  { name: "GPT-5.3-Codex", value: "gpt-5.3-codex" },
];

const ALL_MODELS = [...CLAUDE_MODELS, ...CODEX_MODELS];

/**
 * First phase of startup: select owner, repo, and issue number.
 * Returns early so the caller can check for a resumable run state
 * before collecting the remaining options.
 */
export async function selectTarget(): Promise<TargetResult> {
  const config = loadConfig();
  let configDirty = false;

  const { owner, dirty: ownerDirty } = await selectOwner(config);
  configDirty ||= ownerDirty;

  const repo = await selectRepository(owner);
  const issueNumber = await inputIssueNumber();

  return { owner, repo, issueNumber, config, configDirty };
}

/**
 * Second phase of startup: collect agent models, execution mode,
 * language, and pipeline settings.  Confirm the issue before returning.
 */
export async function runStartup(
  target?: TargetResult,
): Promise<StartupResult> {
  const {
    owner,
    repo,
    issueNumber,
    config,
    configDirty: initialDirty,
  } = target ?? (await selectTarget());
  let configDirty = initialDirty;

  const agentA = await selectAgentModel(t()["agent.labelARole"]);
  const agentB = await selectAgentModel(t()["agent.labelBRole"]);
  const executionMode = await selectExecutionMode();
  const claudePermissionMode = await selectClaudePermissionMode();

  const { language, dirty: langDirty } = await selectLanguage(config);
  configDirty ||= langDirty;

  const { pipelineSettings, dirty: settingsDirty } =
    await adjustPipelineSettings(config.pipelineSettings);
  if (settingsDirty) {
    config.pipelineSettings = pipelineSettings;
  }
  configDirty ||= settingsDirty;

  const issue = getIssue(owner, repo, issueNumber);
  const confirmed = await confirmIssue(owner, repo, issue);
  if (!confirmed) {
    throw new Error(t()["startup.issueNotConfirmed"]);
  }

  // Only write config when something actually changed, to avoid
  // dropping unknown keys that loadConfig() normalizes away.
  if (configDirty) {
    saveConfig(config);
  }

  return {
    owner,
    repo,
    issue,
    agentA,
    agentB,
    executionMode,
    claudePermissionMode,
    language,
    pipelineSettings,
  };
}

async function selectOwner(
  config: Config,
): Promise<{ owner: string; dirty: boolean }> {
  if (config.owners.length === 0) {
    const raw = await input({
      message: t()["startup.enterOwner"],
      validate: (v) => {
        if (!v.trim()) return t()["startup.ownerEmpty"];
        return true;
      },
    });
    const owner = raw.trim();
    config.owners.push(owner);
    return { owner, dirty: true };
  }

  const owner = await select({
    message: t()["startup.selectOrg"],
    choices: config.owners.map((o) => ({ name: o, value: o })),
  });
  return { owner, dirty: false };
}

async function selectRepository(owner: string): Promise<string> {
  const repos = listRepositories(owner);
  if (repos.length === 0) {
    throw new Error(t()["startup.noRepos"](owner));
  }

  return search({
    message: t()["startup.selectRepo"],
    source: (term) => {
      const filtered = term
        ? repos.filter(
            (r) =>
              r.name.toLowerCase().includes(term.toLowerCase()) ||
              r.description?.toLowerCase().includes(term.toLowerCase()),
          )
        : repos;
      return filtered.map((r) => ({
        name: r.description ? `${r.name} — ${r.description}` : r.name,
        value: r.name,
      }));
    },
  });
}

async function inputIssueNumber(): Promise<number> {
  const raw = await input({
    message: t()["startup.issueNumber"],
    validate: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0)
        return t()["startup.invalidIssueNumber"];
      return true;
    },
  });
  return Number(raw);
}

async function selectAgentModel(label: string): Promise<AgentConfig> {
  const model = await select({
    message: t()["startup.agentModel"](label),
    choices: ALL_MODELS,
  });
  return { model };
}

async function selectExecutionMode(): Promise<"auto" | "step"> {
  return select({
    message: t()["startup.executionMode"],
    choices: [
      { name: "auto", value: "auto" as const },
      { name: "step", value: "step" as const },
    ],
  });
}

async function selectClaudePermissionMode(): Promise<"auto" | "bypass"> {
  return select({
    message: t()["startup.claudePermission"],
    choices: [
      { name: "auto", value: "auto" as const },
      { name: "bypass", value: "bypass" as const },
    ],
  });
}

async function selectLanguage(
  config: Config,
): Promise<{ language: "en" | "ko"; dirty: boolean }> {
  const m = t();
  const language = await select({
    message: m["startup.language"],
    choices: [
      { name: m["startup.languageEnglish"], value: "en" as const },
      { name: m["startup.languageKorean"], value: "ko" as const },
    ],
    default: config.language,
  });
  const dirty = language !== config.language;
  config.language = language;
  if (dirty) {
    await initI18n(language);
  }
  return { language, dirty };
}

type SettingKey = keyof PipelineSettings;

function settingLabels(): Record<SettingKey, string> {
  const m = t();
  return {
    selfCheckAutoIterations: m["startup.settingSelfCheck"],
    reviewAutoRounds: m["startup.settingReviewRounds"],
    inactivityTimeoutMinutes: m["startup.settingInactivityTimeout"],
    autoResumeAttempts: m["startup.settingAutoResume"],
  };
}

function settingSuffixes(): Partial<Record<SettingKey, string>> {
  return {
    inactivityTimeoutMinutes: t()["startup.settingSuffixMin"],
  };
}

const SETTING_KEYS: SettingKey[] = [
  "selfCheckAutoIterations",
  "reviewAutoRounds",
  "inactivityTimeoutMinutes",
  "autoResumeAttempts",
];

function formatSettingValue(key: SettingKey, value: number): string {
  const suffix = settingSuffixes()[key];
  return suffix ? `${value} ${suffix}` : String(value);
}

function displayPipelineSettings(settings: PipelineSettings): void {
  const labels = settingLabels();
  console.log();
  console.log(t()["startup.pipelineSettingsHeader"]);
  for (const key of SETTING_KEYS) {
    const label = labels[key].padEnd(30);
    console.log(`    ${label} ${formatSettingValue(key, settings[key])}`);
  }
  console.log();
}

async function adjustPipelineSettings(
  current: PipelineSettings,
): Promise<{ pipelineSettings: PipelineSettings; dirty: boolean }> {
  displayPipelineSettings(current);

  const labels = settingLabels();
  const toAdjust = await checkbox<SettingKey>({
    message: t()["startup.adjustSettings"],
    choices: SETTING_KEYS.map((key) => ({
      name: `${labels[key]}: ${formatSettingValue(key, current[key])}`,
      value: key,
    })),
  });

  if (toAdjust.length === 0) {
    return { pipelineSettings: { ...current }, dirty: false };
  }

  const updated = { ...current };
  for (const key of toAdjust) {
    const raw = await input({
      message: `${labels[key]}:`,
      default: String(current[key]),
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0)
          return t()["startup.positiveInteger"];
        return true;
      },
    });
    updated[key] = Number(raw);
  }

  const save = await confirm({
    message: t()["startup.saveChanges"],
    default: false,
  });

  return { pipelineSettings: updated, dirty: save };
}

async function confirmIssue(
  owner: string,
  repo: string,
  issue: Issue,
): Promise<boolean> {
  const m = t();
  console.log();
  console.log(`  ${owner}/${repo}#${issue.number}: ${issue.title}`);
  console.log(m["startup.issueState"](issue.state));
  if (issue.labels.length > 0) {
    console.log(m["startup.issueLabels"](issue.labels.join(", ")));
  }
  if (issue.body) {
    console.log();
    const preview = issue.body.slice(0, 500);
    console.log(preview.length < issue.body.length ? `${preview}…` : preview);
  }
  console.log();

  return confirm({ message: m["startup.proceedWithIssue"] });
}
