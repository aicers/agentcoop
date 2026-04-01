import { checkbox, confirm, input, search, select } from "@inquirer/prompts";
import type { Config, PipelineSettings } from "./config.js";
import { loadConfig, saveConfig } from "./config.js";
import type { Issue } from "./github.js";
import { getIssue, listRepositories } from "./github.js";

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

export async function runStartup(): Promise<StartupResult> {
  const config = loadConfig();
  let configDirty = false;

  const { owner, dirty: ownerDirty } = await selectOwner(config);
  configDirty ||= ownerDirty;

  const repo = await selectRepository(owner);
  const issueNumber = await inputIssueNumber();
  const agentA = await selectAgentModel("Agent A (implementer)");
  const agentB = await selectAgentModel("Agent B (reviewer)");
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
    throw new Error("Issue not confirmed. Aborting.");
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
      message: "Enter GitHub owner:",
      validate: (v) => {
        if (!v.trim()) return "Owner cannot be empty";
        return true;
      },
    });
    const owner = raw.trim();
    config.owners.push(owner);
    return { owner, dirty: true };
  }

  const owner = await select({
    message: "Select organization:",
    choices: config.owners.map((o) => ({ name: o, value: o })),
  });
  return { owner, dirty: false };
}

async function selectRepository(owner: string): Promise<string> {
  const repos = listRepositories(owner);
  if (repos.length === 0) {
    throw new Error(`No repositories found for ${owner}`);
  }

  return search({
    message: "Select repository: (type to filter)",
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
    message: "Issue number:",
    validate: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) return "Enter a valid issue number";
      return true;
    },
  });
  return Number(raw);
}

async function selectAgentModel(label: string): Promise<AgentConfig> {
  const model = await select({
    message: `${label} model:`,
    choices: ALL_MODELS,
  });
  return { model };
}

async function selectExecutionMode(): Promise<"auto" | "step"> {
  return select({
    message: "Execution mode:",
    choices: [
      { name: "auto", value: "auto" as const },
      { name: "step", value: "step" as const },
    ],
  });
}

async function selectClaudePermissionMode(): Promise<"auto" | "bypass"> {
  return select({
    message: "Claude permission mode:",
    choices: [
      { name: "auto", value: "auto" as const },
      { name: "bypass", value: "bypass" as const },
    ],
  });
}

async function selectLanguage(
  config: Config,
): Promise<{ language: "en" | "ko"; dirty: boolean }> {
  const language = await select({
    message: "Language:",
    choices: [
      { name: "English", value: "en" as const },
      { name: "Korean", value: "ko" as const },
    ],
    default: config.language,
  });
  const dirty = language !== config.language;
  config.language = language;
  return { language, dirty };
}

type SettingKey = keyof PipelineSettings;

const SETTING_LABELS: Record<SettingKey, string> = {
  selfCheckAutoIterations: "Self-check auto iterations",
  reviewAutoRounds: "Review auto rounds",
  inactivityTimeoutMinutes: "Inactivity timeout",
  autoResumeAttempts: "Auto-resume attempts",
};

const SETTING_SUFFIXES: Partial<Record<SettingKey, string>> = {
  inactivityTimeoutMinutes: "min",
};

const SETTING_KEYS: SettingKey[] = [
  "selfCheckAutoIterations",
  "reviewAutoRounds",
  "inactivityTimeoutMinutes",
  "autoResumeAttempts",
];

function formatSettingValue(key: SettingKey, value: number): string {
  const suffix = SETTING_SUFFIXES[key];
  return suffix ? `${value} ${suffix}` : String(value);
}

function displayPipelineSettings(settings: PipelineSettings): void {
  console.log();
  console.log("  Pipeline settings (press Enter to keep defaults):");
  for (const key of SETTING_KEYS) {
    const label = SETTING_LABELS[key].padEnd(30);
    console.log(`    ${label} ${formatSettingValue(key, settings[key])}`);
  }
  console.log();
}

async function adjustPipelineSettings(
  current: PipelineSettings,
): Promise<{ pipelineSettings: PipelineSettings; dirty: boolean }> {
  displayPipelineSettings(current);

  const toAdjust = await checkbox<SettingKey>({
    message: "Adjust any settings?",
    choices: SETTING_KEYS.map((key) => ({
      name: `${SETTING_LABELS[key]}: ${formatSettingValue(key, current[key])}`,
      value: key,
    })),
  });

  if (toAdjust.length === 0) {
    return { pipelineSettings: { ...current }, dirty: false };
  }

  const updated = { ...current };
  for (const key of toAdjust) {
    const raw = await input({
      message: `${SETTING_LABELS[key]}:`,
      default: String(current[key]),
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) return "Enter a positive integer";
        return true;
      },
    });
    updated[key] = Number(raw);
  }

  const save = await confirm({
    message: "Save changes to config?",
    default: false,
  });

  return { pipelineSettings: updated, dirty: save };
}

async function confirmIssue(
  owner: string,
  repo: string,
  issue: Issue,
): Promise<boolean> {
  console.log();
  console.log(`  ${owner}/${repo}#${issue.number}: ${issue.title}`);
  console.log(`  State: ${issue.state}`);
  if (issue.labels.length > 0) {
    console.log(`  Labels: ${issue.labels.join(", ")}`);
  }
  if (issue.body) {
    console.log();
    const preview = issue.body.slice(0, 500);
    console.log(preview.length < issue.body.length ? `${preview}…` : preview);
  }
  console.log();

  return confirm({ message: "Proceed with this issue?" });
}
