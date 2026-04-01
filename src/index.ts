#!/usr/bin/env node

import type { PipelineOptions } from "./pipeline.js";
import { createDoneStageHandler, runPipeline } from "./pipeline.js";
import { runStartup } from "./startup.js";
import {
  bootstrapRepo,
  createWorktree,
  detectDefaultBranch,
  removeWorktree,
} from "./worktree.js";

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

  // Stage 9 (Done) is always present.  Stages 1–8 come from handler
  // modules that are not yet implemented (see issues #6, #7, #8).
  const doneStage = createDoneStageHandler({
    reportCompletion: async (msg) => console.log(msg),
    confirmMerge: async () => true, // placeholder until real prompts
    cleanup: () =>
      removeWorktree(result.owner, result.repo, result.issue.number, wt.branch),
  });

  const pipelineOpts: PipelineOptions = {
    mode: result.executionMode,
    stages: [doneStage],
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
