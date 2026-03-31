import { confirm, input, search, select } from "@inquirer/prompts";
import type { Config } from "./config.js";
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
}

export interface AgentConfig {
  model: string;
}

const CLAUDE_MODELS = [
  { name: "Claude Opus 4", value: "opus" },
  { name: "Claude Sonnet 4", value: "sonnet" },
];

const CODEX_MODELS = [
  { name: "Codex o3", value: "o3" },
  { name: "Codex o4-mini", value: "o4-mini" },
];

const ALL_MODELS = [...CLAUDE_MODELS, ...CODEX_MODELS];

export async function runStartup(): Promise<StartupResult> {
  const config = loadConfig();

  const owner = await selectOwner(config);
  const repo = await selectRepository(owner);
  const issueNumber = await inputIssueNumber();
  const agentA = await selectAgentModel("Agent A (implementer)");
  const agentB = await selectAgentModel("Agent B (reviewer)");
  const executionMode = await selectExecutionMode();
  const claudePermissionMode = await selectClaudePermissionMode();
  const language = await selectLanguage(config);

  const issue = getIssue(owner, repo, issueNumber);
  const confirmed = await confirmIssue(owner, repo, issue);
  if (!confirmed) {
    throw new Error("Issue not confirmed. Aborting.");
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
  };
}

async function selectOwner(config: Config): Promise<string> {
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
    saveConfig(config);
    return owner;
  }

  return select({
    message: "Select organization:",
    choices: config.owners.map((o) => ({ name: o, value: o })),
  });
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

async function selectLanguage(config: Config): Promise<"en" | "ko"> {
  const language = await select({
    message: "Language:",
    choices: [
      { name: "English", value: "en" as const },
      { name: "Korean", value: "ko" as const },
    ],
    default: config.language,
  });
  if (language !== config.language) {
    config.language = language;
    saveConfig(config);
  }
  return language;
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
