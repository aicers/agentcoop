#!/usr/bin/env node

import { confirm, select } from "@inquirer/prompts";

import type { AgentAdapter } from "./agent.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import { createCodexAdapter } from "./codex-adapter.js";
import type { PipelineSettings } from "./config.js";
import { getIssue } from "./github.js";
import type { PipelineOptions } from "./pipeline.js";
import { createDoneStageHandler, runPipeline } from "./pipeline.js";
import { findPrNumber } from "./pr.js";
import {
  deleteRunState,
  loadRunState,
  type RunState,
  saveRunState,
} from "./run-state.js";
import { createCiCheckStageHandler } from "./stage-cicheck.js";
import { createCreatePrStageHandler } from "./stage-createpr.js";
import { createImplementStageHandler } from "./stage-implement.js";
import { createReviewStageHandler } from "./stage-review.js";
import { createSelfCheckStageHandler } from "./stage-selfcheck.js";
import { createSquashStageHandler } from "./stage-squash.js";
import { createTestPlanStageHandler } from "./stage-testplan.js";
import type { AgentConfig } from "./startup.js";
import { runStartup, selectTarget } from "./startup.js";
import {
  bootstrapRepo,
  createWorktree,
  detectDefaultBranch,
  hasUncommittedChanges,
  removeWorktree,
  worktreePath,
} from "./worktree.js";

// ---- types ---------------------------------------------------------------

interface RunParams {
  agentAConfig: AgentConfig;
  agentBConfig: AgentConfig;
  executionMode: "auto" | "step";
  claudePermissionMode: "auto" | "bypass";
  pipelineSettings: PipelineSettings;
  issueTitle: string;
  issueBody: string;
  startFromStage: number | undefined;
  resuming: boolean;
  /** True when user chose "Start fresh" — worktree should be cleaned. */
  startFresh: boolean;
}

// ---- helpers -------------------------------------------------------------

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

function cliForModel(model: string): string {
  return CLAUDE_MODELS.has(model) ? "claude" : "codex";
}

// ---- stage name lookup (for display) -------------------------------------

const STAGE_NAMES: Record<number, string> = {
  2: "Implement",
  3: "Self-check",
  4: "Create PR",
  5: "CI check",
  6: "Test plan verification",
  7: "Squash commits",
  8: "Review",
  9: "Done",
};

function formatStateSummary(state: RunState): string {
  const stageName =
    STAGE_NAMES[state.currentStage] ?? `Stage ${state.currentStage}`;
  const lines = [
    `  Saved run state found:`,
    `    Stage: ${state.currentStage} (${stageName})`,
    `    Loop count: ${state.stageLoopCount}`,
    `    Branch: ${state.branch}`,
  ];
  if (state.prNumber !== undefined) {
    lines.push(`    PR: #${state.prNumber}`);
  }
  if (state.reviewRound > 0) {
    lines.push(`    Review round: ${state.reviewRound}`);
  }
  lines.push(
    `    Mode: ${state.executionMode}`,
    `    Agent A: ${state.agentA.model}`,
    `    Agent B: ${state.agentB.model}`,
  );
  return lines.join("\n");
}

if (!process.stdin.isTTY) {
  console.error("agentcoop requires an interactive terminal.");
  process.exit(1);
}

try {
  // Phase 1: select target (owner / repo / issue).
  const target = await selectTarget();
  const { owner, repo, issueNumber } = target;

  // Phase 2: check for resumable state and collect run parameters.
  const savedState = loadRunState(owner, repo, issueNumber);
  let params: RunParams;
  let userChoseFresh = false;

  if (savedState) {
    console.log();
    console.log(formatStateSummary(savedState));
    console.log();

    const choice = await select({
      message: "Resume or start fresh?",
      choices: [
        { name: "Resume", value: "resume" as const },
        { name: "Start fresh", value: "fresh" as const },
      ],
    });

    if (choice === "resume") {
      const issue = getIssue(owner, repo, issueNumber);
      params = {
        agentAConfig: { model: savedState.agentA.model },
        agentBConfig: { model: savedState.agentB.model },
        executionMode: savedState.executionMode,
        claudePermissionMode: savedState.claudePermissionMode,
        pipelineSettings: target.config.pipelineSettings,
        issueTitle: issue.title,
        issueBody: issue.body,
        startFromStage: savedState.currentStage,
        resuming: true,
        startFresh: false,
      };
    } else {
      // Start fresh: warn about uncommitted changes.
      const wtPath = worktreePath(owner, repo, issueNumber);
      if (hasUncommittedChanges(wtPath)) {
        const ok = await confirm({
          message:
            "The existing worktree has uncommitted changes. " +
            "Starting fresh will discard them. Continue?",
          default: false,
        });
        if (!ok) {
          throw new Error(
            "Aborted: user declined to discard uncommitted changes.",
          );
        }
      }
      deleteRunState(owner, repo, issueNumber);
      userChoseFresh = true;
    }
  }

  // When not resuming (either no saved state or user chose fresh), run
  // full startup to collect remaining options.
  params ??= await (async () => {
    const result = await runStartup(target);
    return {
      agentAConfig: result.agentA,
      agentBConfig: result.agentB,
      executionMode: result.executionMode,
      claudePermissionMode: result.claudePermissionMode,
      pipelineSettings: result.pipelineSettings,
      issueTitle: result.issue.title,
      issueBody: result.issue.body,
      startFromStage: undefined,
      resuming: false,
      startFresh: userChoseFresh,
    };
  })();

  const {
    agentAConfig,
    agentBConfig,
    executionMode,
    claudePermissionMode,
    pipelineSettings,
    issueTitle,
    issueBody,
    startFromStage: rawStartFromStage,
    resuming,
    startFresh,
  } = params;

  // Bootstrap the repository and create a worktree.
  console.log();
  console.log("Bootstrapping repository...");
  bootstrapRepo(owner, repo);

  const defaultBranch = detectDefaultBranch(owner, repo);
  const wt = createWorktree({
    owner,
    repo,
    issueNumber,
    baseBranch: defaultBranch,
    conflictChoice: startFresh ? "clean" : "reuse",
  });
  console.log(`Worktree ready at ${wt.path} (branch: ${wt.branch})`);

  if (wt.hadUncommittedChanges) {
    console.warn(
      "⚠ The existing worktree had uncommitted changes that were preserved.",
    );
  }

  // Skip stage 4 (PR creation) on resume when the PR already exists.
  // This avoids replaying the side-effectful `gh pr create` if the
  // process was interrupted after the PR was created but before the
  // completion check finished.
  let startFromStage = rawStartFromStage;
  if (startFromStage === 4 && findPrNumber(owner, repo, wt.branch)) {
    console.log("  PR already exists — skipping to stage 5 (CI check).");
    startFromStage = 5;
  }

  console.log();
  console.log(
    `Starting pipeline for ${owner}/${repo}#${issueNumber}${resuming ? " (resuming)" : ""}`,
  );
  console.log(`  Agent A: ${agentAConfig.model}`);
  console.log(`  Agent B: ${agentBConfig.model}`);
  console.log(`  Mode: ${executionMode}`);
  console.log(`  Permission: ${claudePermissionMode}`);
  if (startFromStage !== undefined) {
    console.log(`  Resuming from stage: ${startFromStage}`);
  }

  // Create agent adapters.
  const agentA = createAdapter(agentAConfig, claudePermissionMode);
  const agentB = createAdapter(agentBConfig, claudePermissionMode);

  const issueCtx = { issueTitle, issueBody };

  const implementStage = createImplementStageHandler({
    agent: agentA,
    ...issueCtx,
  });

  const selfCheckStage = {
    ...createSelfCheckStageHandler({
      agent: agentA,
      ...issueCtx,
    }),
    autoBudget: pipelineSettings.selfCheckAutoIterations,
  };

  const createPrStage = createCreatePrStageHandler({
    agent: agentA,
    ...issueCtx,
  });

  const ciCheckStage = createCiCheckStageHandler({
    agent: agentA,
    ...issueCtx,
  });

  const testPlanStage = {
    ...createTestPlanStageHandler({
      agent: agentA,
      ...issueCtx,
    }),
    restartFromStage: 5,
  };

  const squashStage = createSquashStageHandler({
    agent: agentA,
    ...issueCtx,
  });

  const reviewStage = {
    ...createReviewStageHandler({
      agentA,
      agentB,
      ...issueCtx,
    }),
    autoBudget: pipelineSettings.reviewAutoRounds,
  };

  // Mutable run state for persistence.
  const runState: RunState = savedState ?? {
    owner,
    repo,
    issueNumber,
    branch: wt.branch,
    worktreePath: wt.path,
    prNumber: undefined,
    currentStage: 2,
    stageLoopCount: 0,
    reviewRound: 0,
    executionMode,
    claudePermissionMode,
    agentA: {
      cli: cliForModel(agentAConfig.model),
      model: agentAConfig.model,
      sessionId: undefined,
    },
    agentB: {
      cli: cliForModel(agentBConfig.model),
      model: agentBConfig.model,
      sessionId: undefined,
    },
  };

  // Save initial state.
  saveRunState(runState);

  const doneStage = createDoneStageHandler({
    reportCompletion: async (msg) => console.log(msg),
    confirmMerge: async () => true, // placeholder until real prompts
    cleanup: () => removeWorktree(owner, repo, issueNumber, wt.branch),
  });

  const pipelineOpts: PipelineOptions = {
    mode: executionMode,
    stages: [
      implementStage,
      selfCheckStage,
      createPrStage,
      ciCheckStage,
      testPlanStage,
      squashStage,
      reviewStage,
      doneStage,
    ],
    prompt: {
      confirmContinueLoop: async (_stage, _iter, _msg) => false,
      confirmNextStage: async () => true,
      handleBlocked: async () => ({ action: "halt" }),
      handleError: async () => ({ action: "abort" }),
      handleAmbiguous: async () => ({ action: "halt" }),
      confirmMerge: async () => true,
      reportCompletion: async () => {},
    },
    context: {
      owner,
      repo,
      issueNumber,
      branch: wt.branch,
      worktreePath: wt.path,
    },
    startFromStage,
    startFromStageLoopCount: savedState?.stageLoopCount,
    savedAgentASessionId: savedState?.agentA.sessionId,
    savedAgentBSessionId: savedState?.agentB.sessionId,
    onSessionId: (agent, sessionId) => {
      if (agent === "a") {
        runState.agentA.sessionId = sessionId;
      } else {
        runState.agentB.sessionId = sessionId;
      }
      saveRunState(runState);
    },
    onStageTransition: (stageNumber, stageLoopCount) => {
      runState.currentStage = stageNumber;
      runState.stageLoopCount = stageLoopCount;
      // Update PR number when entering stage 5+ (PR should exist by then).
      if (stageNumber >= 5 && runState.prNumber === undefined) {
        runState.prNumber = findPrNumber(owner, repo, wt.branch);
      }
      // Track review round.
      if (stageNumber === 8) {
        runState.reviewRound = stageLoopCount + 1;
      }
      saveRunState(runState);
    },
  };
  const pipelineResult = await runPipeline(pipelineOpts);
  console.log();
  console.log(pipelineResult.message);

  if (pipelineResult.success) {
    deleteRunState(owner, repo, issueNumber);
  }
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
