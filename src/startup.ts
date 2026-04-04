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
  language: "en" | "ko";
  pipelineSettings: PipelineSettings;
}

export interface AgentConfig {
  cli: "claude" | "codex";
  model: string;
  contextWindow?: string;
  effortLevel?: string;
}

// ---- CLI choices ---------------------------------------------------------

const CLI_CHOICES = [
  { name: "Claude", value: "claude" as const },
  { name: "Codex", value: "codex" as const },
];

// ---- Model choices per CLI -----------------------------------------------

const CLAUDE_MODELS = [
  { name: "Claude Opus 4.6", value: "opus" },
  { name: "Claude Sonnet 4.6", value: "sonnet" },
];

const CODEX_MODELS = [
  { name: "GPT-5.4", value: "gpt-5.4" },
  { name: "GPT-5.3-Codex", value: "gpt-5.3-codex" },
];

// ---- Context window variants ---------------------------------------------

const CLAUDE_CONTEXT_WINDOWS = [
  { name: "200K (default)", value: "200k" },
  { name: "1M (extended)", value: "1m" },
];

// ---- Effort / reasoning levels -------------------------------------------

const CLAUDE_EFFORT_LEVELS = [
  { name: "Low", value: "low" },
  { name: "Medium", value: "medium" },
  { name: "High", value: "high" },
];

const CLAUDE_OPUS_EFFORT_LEVELS = [
  ...CLAUDE_EFFORT_LEVELS,
  { name: "Max", value: "max" },
];

function claudeEffortChoices(model: string) {
  return model === "opus" ? CLAUDE_OPUS_EFFORT_LEVELS : CLAUDE_EFFORT_LEVELS;
}

const CODEX_REASONING_LEVELS = [
  { name: "Low", value: "low" },
  { name: "Medium", value: "medium" },
  { name: "High", value: "high" },
  { name: "Extra High", value: "xhigh" },
];

// ---- Display name helpers ------------------------------------------------

function modelDisplayName(config: AgentConfig): string {
  const modelChoices = config.cli === "claude" ? CLAUDE_MODELS : CODEX_MODELS;
  const modelName =
    modelChoices.find((m) => m.value === config.model)?.name ?? config.model;
  const parts = [modelName];
  if (config.contextWindow) {
    parts[0] = `${modelName} (${config.contextWindow.toUpperCase()})`;
  }
  if (config.effortLevel) {
    const effortChoices =
      config.cli === "claude"
        ? claudeEffortChoices(config.model)
        : CODEX_REASONING_LEVELS;
    const effortName =
      effortChoices.find((e) => e.value === config.effortLevel)?.name ??
      config.effortLevel;
    parts.push(effortName);
  }
  return parts.join(" / ");
}

export { modelDisplayName };

function agentConfigEqual(a: AgentConfig | undefined, b: AgentConfig): boolean {
  if (!a) return false;
  return (
    a.cli === b.cli &&
    a.model === b.model &&
    a.contextWindow === b.contextWindow &&
    a.effortLevel === b.effortLevel
  );
}

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

  // Quick-start: offer to reuse saved configuration when both agents exist.
  if (config.agentA && config.agentB) {
    const m = t();
    console.log();
    console.log(m["quickStart.header"]);
    console.log(m["quickStart.agentA"](modelDisplayName(config.agentA)));
    console.log(m["quickStart.agentB"](modelDisplayName(config.agentB)));
    console.log(m["quickStart.mode"](config.executionMode ?? "auto"));
    console.log(
      m["quickStart.language"](
        config.language === "ko"
          ? m["startup.languageKorean"]
          : m["startup.languageEnglish"],
      ),
    );
    console.log();

    const reuse = await confirm({
      message: m["quickStart.usePrevious"],
      default: true,
    });

    if (reuse) {
      const issue = getIssue(owner, repo, issueNumber);
      const confirmed = await confirmIssue(owner, repo, issue);
      if (!confirmed) {
        throw new Error(m["startup.issueNotConfirmed"]);
      }

      if (configDirty) {
        saveConfig(config);
      }

      return {
        owner,
        repo,
        issue,
        agentA: config.agentA,
        agentB: config.agentB,
        executionMode: config.executionMode ?? "auto",
        language: config.language,
        pipelineSettings: config.pipelineSettings,
      };
    }
  }

  const agentA = await selectAgent(
    t()["agent.labelARole"],
    config.agentA ?? DEFAULT_AGENT_A,
  );
  // Smart default: opposite CLI for agent B
  const defaultBCli = agentA.cli === "claude" ? "codex" : "claude";
  const agentBDefaults: Partial<AgentConfig> = config.agentB
    ? config.agentB
    : CLI_DEFAULTS[defaultBCli];
  const agentB = await selectAgent(t()["agent.labelBRole"], agentBDefaults);
  const executionMode = await selectExecutionMode(config.executionMode);

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

  // Persist agent selections and execution mode only when they actually
  // changed, to avoid rewriting the config file on every run (which
  // would drop unknown keys that loadConfig() normalizes away).
  if (!agentConfigEqual(config.agentA, agentA)) {
    config.agentA = agentA;
    configDirty = true;
  }
  if (!agentConfigEqual(config.agentB, agentB)) {
    config.agentB = agentB;
    configDirty = true;
  }
  if (config.executionMode !== executionMode) {
    config.executionMode = executionMode;
    configDirty = true;
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

// ---- first-run defaults --------------------------------------------------

const CLI_DEFAULTS: Record<"claude" | "codex", AgentConfig> = {
  claude: {
    cli: "claude",
    model: "opus",
    contextWindow: "1m",
    effortLevel: "high",
  },
  codex: { cli: "codex", model: "gpt-5.4", effortLevel: "xhigh" },
};

const DEFAULT_AGENT_A = CLI_DEFAULTS.claude;

async function selectAgent(
  label: string,
  defaults?: Partial<AgentConfig>,
): Promise<AgentConfig> {
  const m = t();

  const cli = await select({
    message: m["startup.agentCli"](label),
    choices: CLI_CHOICES,
    default: defaults?.cli,
  });

  // When the user switches CLI, fall back to the per-CLI defaults so
  // that model/context/effort prompts start with sensible values instead
  // of landing on the first choice.
  const effective = defaults?.cli === cli ? defaults : CLI_DEFAULTS[cli];

  const models = cli === "claude" ? CLAUDE_MODELS : CODEX_MODELS;
  const model = await select({
    message: m["startup.agentModel"](label),
    choices: models,
    default: effective.model,
  });

  let contextWindow: string | undefined;
  if (cli === "claude") {
    contextWindow = await select({
      message: m["startup.agentContext"](label),
      choices: CLAUDE_CONTEXT_WINDOWS,
      default: effective.contextWindow,
    });
  }

  const effortChoices =
    cli === "claude" ? claudeEffortChoices(model) : CODEX_REASONING_LEVELS;
  const effortLevel = await select({
    message: m["startup.agentEffort"](label),
    choices: effortChoices,
    default: effective.effortLevel,
  });

  return { cli, model, contextWindow, effortLevel };
}

async function selectExecutionMode(
  defaultValue?: "auto" | "step",
): Promise<"auto" | "step"> {
  return select({
    message: t()["startup.executionMode"],
    choices: [
      { name: "auto", value: "auto" as const },
      { name: "step", value: "step" as const },
    ],
    default: defaultValue ?? "auto",
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
