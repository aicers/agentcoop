#!/usr/bin/env node

import { confirm, select } from "@inquirer/prompts";
import { render } from "ink";
import React from "react";

import type { AgentAdapter } from "./agent.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import { createCodexAdapter } from "./codex-adapter.js";
import type { PipelineSettings } from "./config.js";
import { loadConfig } from "./config.js";
import { getGitHubUsername, getIssue } from "./github.js";
import { initI18n, t } from "./i18n/index.js";
import type {
  PipelineOptions,
  PipelineResult,
  UserPrompt,
} from "./pipeline.js";
import { createDoneStageHandler } from "./pipeline.js";
import { PipelineEventEmitter } from "./pipeline-events.js";
import { findPrNumber } from "./pr.js";
import {
  deleteRunState,
  loadRunState,
  RUN_STATE_VERSION,
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
import { modelDisplayName, runStartup, selectTarget } from "./startup.js";
import { App } from "./ui/App.js";
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

function createAdapter(
  agentConfig: AgentConfig,
  permissionMode: "auto" | "bypass",
  inactivityTimeoutMs?: number,
): AgentAdapter {
  if (agentConfig.cli === "claude") {
    return createClaudeAdapter({
      model: agentConfig.model,
      permissionMode,
      effortLevel: agentConfig.effortLevel as
        | "low"
        | "medium"
        | "high"
        | undefined,
      contextWindow: agentConfig.contextWindow,
      inactivityTimeoutMs,
    });
  }
  return createCodexAdapter({
    model: agentConfig.model,
    reasoningEffort: agentConfig.effortLevel as
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | undefined,
    inactivityTimeoutMs,
  });
}

// ---- stage name lookup (for display) -------------------------------------

function stageNames(): Record<number, string> {
  const m = t();
  return {
    2: m["stage.implement"],
    3: m["stage.selfCheck"],
    4: m["stage.createPr"],
    5: m["stage.ciCheck"],
    6: m["stage.testPlan"],
    7: m["stage.review"],
    8: m["stage.squash"],
    9: m["stage.done"],
  };
}

function formatStateSummary(state: RunState): string {
  const m = t();
  const names = stageNames();
  const stageName = names[state.currentStage] ?? `Stage ${state.currentStage}`;
  const lines = [
    m["resume.savedStateFound"],
    m["resume.stage"](state.currentStage, stageName),
    m["resume.loopCount"](state.stageLoopCount),
    m["resume.branch"](state.branch),
  ];
  if (state.prNumber !== undefined) {
    lines.push(m["resume.pr"](state.prNumber));
  }
  if (state.reviewRound > 0) {
    lines.push(m["resume.reviewRound"](state.reviewRound));
  }
  lines.push(
    m["resume.mode"](state.executionMode),
    m["resume.agentA"](
      modelDisplayName({
        cli: state.agentA.cli as "claude" | "codex",
        model: state.agentA.model,
        contextWindow: state.agentA.contextWindow,
        effortLevel: state.agentA.effortLevel,
      }),
    ),
    m["resume.agentB"](
      modelDisplayName({
        cli: state.agentB.cli as "claude" | "codex",
        model: state.agentB.model,
        contextWindow: state.agentB.contextWindow,
        effortLevel: state.agentB.effortLevel,
      }),
    ),
  );
  return lines.join("\n");
}

if (!process.stdin.isTTY) {
  // i18n may not be initialised yet — use English directly for this
  // pre-startup guard.
  console.error("agentcoop requires an interactive terminal.");
  process.exit(1);
}

// Initialise i18n from the persisted config before any user-facing output.
const bootConfig = loadConfig();
await initI18n(bootConfig.language);

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

    const m = t();
    const choice = await select({
      message: m["resume.resumeOrFresh"],
      choices: [
        { name: m["resume.resume"], value: "resume" as const },
        { name: m["resume.startFresh"], value: "fresh" as const },
      ],
    });

    if (choice === "resume") {
      const issue = getIssue(owner, repo, issueNumber);
      params = {
        agentAConfig: {
          cli: savedState.agentA.cli as "claude" | "codex",
          model: savedState.agentA.model,
          contextWindow: savedState.agentA.contextWindow,
          effortLevel: savedState.agentA.effortLevel,
        },
        agentBConfig: {
          cli: savedState.agentB.cli as "claude" | "codex",
          model: savedState.agentB.model,
          contextWindow: savedState.agentB.contextWindow,
          effortLevel: savedState.agentB.effortLevel,
        },
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
          message: m["resume.uncommittedWarning"],
          default: false,
        });
        if (!ok) {
          throw new Error(m["resume.abortedUncommitted"]);
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
    // Re-initialise i18n if the user changed language during startup.
    await initI18n(result.language);
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

  const m = t();

  // Bootstrap the repository and create a worktree.
  console.log();
  console.log(m["boot.bootstrapping"]);
  bootstrapRepo(owner, repo);

  const defaultBranch = detectDefaultBranch(owner, repo);
  const username = getGitHubUsername();
  const wt = createWorktree({
    owner,
    repo,
    issueNumber,
    baseBranch: defaultBranch,
    branch: `${username}/issue-${issueNumber}`,
    conflictChoice: startFresh ? "clean" : "reuse",
  });
  console.log(m["boot.worktreeReady"](wt.path, wt.branch));

  if (wt.hadUncommittedChanges) {
    console.warn(m["boot.uncommittedPreserved"]);
  }

  // Skip stage 4 (PR creation) on resume when the PR already exists.
  // This avoids replaying the side-effectful `gh pr create` if the
  // process was interrupted after the PR was created but before the
  // completion check finished.
  let startFromStage = rawStartFromStage;
  if (startFromStage === 4 && findPrNumber(owner, repo, wt.branch)) {
    console.log(m["boot.prExistsSkip"]);
    startFromStage = 5;
  }

  console.log();
  console.log(m["boot.startingPipeline"](owner, repo, issueNumber, resuming));
  console.log(m["boot.agentA"](modelDisplayName(agentAConfig)));
  console.log(m["boot.agentB"](modelDisplayName(agentBConfig)));
  console.log(m["boot.mode"](executionMode));
  console.log(m["boot.permission"](claudePermissionMode));
  if (startFromStage !== undefined) {
    console.log(m["boot.resumingFromStage"](startFromStage));
  }

  // Create agent adapters.
  const inactivityTimeoutMs =
    pipelineSettings.inactivityTimeoutMinutes * 60_000;
  const agentA = createAdapter(
    agentAConfig,
    claudePermissionMode,
    inactivityTimeoutMs,
  );
  const agentB = createAdapter(
    agentBConfig,
    claudePermissionMode,
    inactivityTimeoutMs,
  );

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
    defaultBranch,
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
    version: RUN_STATE_VERSION,
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
      cli: agentAConfig.cli,
      model: agentAConfig.model,
      contextWindow: agentAConfig.contextWindow,
      effortLevel: agentAConfig.effortLevel,
      sessionId: undefined,
    },
    agentB: {
      cli: agentBConfig.cli,
      model: agentBConfig.model,
      contextWindow: agentBConfig.contextWindow,
      effortLevel: agentBConfig.effortLevel,
      sessionId: undefined,
    },
  };

  // Save initial state.
  saveRunState(runState);

  // The TUI prompt is created inside <App> at mount time.  Done stage
  // callbacks delegate to it via a late-binding ref so stage 9 shows
  // a real user confirmation instead of auto-approving.
  let tuiPrompt:
    | {
        confirmMerge: UserPrompt["confirmMerge"];
        reportCompletion: UserPrompt["reportCompletion"];
      }
    | undefined;

  const doneStage = createDoneStageHandler({
    reportCompletion: async (msg) => {
      if (tuiPrompt) return tuiPrompt.reportCompletion(msg);
      console.log(msg);
    },
    confirmMerge: async (msg) => {
      if (tuiPrompt) return tuiPrompt.confirmMerge(msg);
      return true;
    },
    cleanup: () => removeWorktree(owner, repo, issueNumber, wt.branch),
  });

  // The `prompt` field is intentionally omitted here — it will be
  // supplied by the ink <App> component via TuiUserPrompt.
  const pipelineOpts: Omit<PipelineOptions, "prompt" | "events"> = {
    mode: executionMode,
    stages: [
      implementStage,
      selfCheckStage,
      createPrStage,
      ciCheckStage,
      testPlanStage,
      reviewStage,
      squashStage,
      doneStage,
    ],
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
      if (stageNumber === 7) {
        runState.reviewRound = stageLoopCount + 1;
      }
      saveRunState(runState);
    },
  };

  // Launch the ink TUI.
  const emitter = new PipelineEventEmitter();

  const pipelineResult = await new Promise<PipelineResult>((resolve) => {
    const { unmount } = render(
      React.createElement(App, {
        emitter,
        pipelineOptions: pipelineOpts,
        onExit: (result: PipelineResult) => {
          unmount();
          resolve(result);
        },
        onPromptReady: (prompt) => {
          tuiPrompt = prompt;
        },
      }),
    );
  });

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
