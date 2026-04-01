#!/usr/bin/env node

import type { AgentAdapter } from "./agent.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import { createCodexAdapter } from "./codex-adapter.js";
import type { PipelineOptions } from "./pipeline.js";
import { createDoneStageHandler, runPipeline } from "./pipeline.js";
import { createImplementStageHandler } from "./stage-implement.js";
import { createSelfCheckStageHandler } from "./stage-selfcheck.js";
import type { AgentConfig } from "./startup.js";
import { runStartup } from "./startup.js";
import {
  bootstrapRepo,
  createWorktree,
  detectDefaultBranch,
  removeWorktree,
} from "./worktree.js";

const CLAUDE_MODELS = new Set(["opus", "sonnet"]);

function createAdapter(
  agentConfig: AgentConfig,
  permissionMode: "auto" | "bypass",
): AgentAdapter {
  if (CLAUDE_MODELS.has(agentConfig.model)) {
    return createClaudeAdapter({ model: agentConfig.model, permissionMode });
  }
  return createCodexAdapter({ model: agentConfig.model });
}

if (!process.stdin.isTTY) {
  console.error("agentcoop requires an interactive terminal.");
  process.exit(1);
}

try {
  const result = await runStartup();

  console.log();
  console.log(
    `Starting pipeline for ${result.owner}/${result.repo}#${result.issue.number}`,
  );
  console.log(`  Agent A: ${result.agentA.model}`);
  console.log(`  Agent B: ${result.agentB.model}`);
  console.log(`  Mode: ${result.executionMode}`);
  console.log(`  Permission: ${result.claudePermissionMode}`);
  console.log(`  Language: ${result.language}`);

  // Bootstrap the repository and create a worktree.
  console.log();
  console.log("Bootstrapping repository...");
  bootstrapRepo(result.owner, result.repo);

  const defaultBranch = detectDefaultBranch(result.owner, result.repo);
  const wt = createWorktree({
    owner: result.owner,
    repo: result.repo,
    issueNumber: result.issue.number,
    baseBranch: defaultBranch,
    conflictChoice: "reuse",
  });
  console.log(`Worktree ready at ${wt.path} (branch: ${wt.branch})`);

  if (wt.hadUncommittedChanges) {
    console.warn(
      "⚠ The existing worktree had uncommitted changes that were preserved.",
    );
  }

  // Create agent adapters.
  const agentA = createAdapter(result.agentA, result.claudePermissionMode);

  const issueCtx = {
    issueTitle: result.issue.title,
    issueBody: result.issue.body,
  };

  const implementStage = createImplementStageHandler({
    agent: agentA,
    ...issueCtx,
  });

  const selfCheckStage = createSelfCheckStageHandler({
    agent: agentA,
    ...issueCtx,
  });

  const doneStage = createDoneStageHandler({
    reportCompletion: async (msg) => console.log(msg),
    confirmMerge: async () => true, // placeholder until real prompts
    cleanup: () =>
      removeWorktree(result.owner, result.repo, result.issue.number, wt.branch),
  });

  const pipelineOpts: PipelineOptions = {
    mode: result.executionMode,
    stages: [implementStage, selfCheckStage, doneStage],
    prompt: {
      confirmContinueLoop: async () => false,
      confirmNextStage: async () => true,
      handleBlocked: async () => ({ action: "halt" }),
      handleError: async () => ({ action: "abort" }),
      handleAmbiguous: async () => ({ action: "halt" }),
      confirmMerge: async () => true,
      reportCompletion: async () => {},
    },
    context: {
      owner: result.owner,
      repo: result.repo,
      issueNumber: result.issue.number,
      branch: wt.branch,
      worktreePath: wt.path,
    },
  };
  const pipelineResult = await runPipeline(pipelineOpts);
  console.log();
  console.log(pipelineResult.message);
} catch (error) {
  if (
    error instanceof Error &&
    error.message.includes("User force closed the prompt")
  ) {
    process.exit(130);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
