#!/usr/bin/env node

import { confirm, select } from "@inquirer/prompts";

import type { AgentAdapter, AgentStream } from "./agent.js";
import { pollCiAndFix } from "./ci-poll.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import {
  closePr,
  deleteRemoteBranch,
  hasDockerComposeRunning,
  remoteBranchExists,
  stopDockerCompose,
} from "./cleanup.js";
import { createCodexAdapter } from "./codex-adapter.js";
import type { PipelineSettings } from "./config.js";
import { loadConfig } from "./config.js";
import { getGitHubUsername, getIssue } from "./github.js";
import { initI18n, t } from "./i18n/index.js";
import {
  formatIssueSyncSummary,
  type IssueChange,
  type IssueSyncStatus,
} from "./issue-sync.js";
import type {
  PipelineOptions,
  PipelineResult,
  UserPrompt,
} from "./pipeline.js";
import { createDoneStageHandler } from "./pipeline.js";
import { PipelineEventEmitter } from "./pipeline-events.js";
import { checkMergeable, findPrNumber } from "./pr.js";
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
import { drainToSink } from "./stage-util.js";
import type { AgentConfig } from "./startup.js";
import { modelDisplayName, runStartup, selectTarget } from "./startup.js";
import { parseStepStatus } from "./step-parser.js";
import { renderApp } from "./ui/render-app.js";
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
  inactivityTimeoutMs?: number,
): AgentAdapter {
  if (agentConfig.cli === "claude") {
    return createClaudeAdapter({
      model: agentConfig.model,
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

/**
 * Wrap an `AgentAdapter` to track running agent streams.  When a stream
 * starts, it is added to the set; when it finishes, it is removed.
 * This enables the SIGINT handler to kill all running agents.
 *
 * Streams are tracked (rather than individual `ChildProcess` objects)
 * so that the `child` property can be read at kill-time.  This is
 * important for fallback streams (e.g. `withXhighFallback`) where the
 * active child may change after the stream is created.
 */
function trackProcesses(
  adapter: AgentAdapter,
  tracker: Set<AgentStream>,
): AgentAdapter {
  function track(stream: AgentStream) {
    tracker.add(stream);
    stream.result.finally(() => tracker.delete(stream));
    return stream;
  }

  return {
    invoke(prompt, options) {
      return track(adapter.invoke(prompt, options));
    },
    resume(sessionId, prompt, options) {
      return track(adapter.resume(sessionId, prompt, options));
    },
  };
}

/** What cleanup actions were performed during cancellation. */
interface CleanupResult {
  deletedWorktree: boolean;
  deletedRemoteBranch: boolean;
  closedPr: boolean;
}

/**
 * Run post-pipeline cancellation cleanup using interactive prompts.
 */
async function runCancellationCleanup(opts: {
  owner: string;
  repo: string;
  issueNumber: number;
  branch: string;
  worktreePath: string;
  prNumber: number | undefined;
}): Promise<CleanupResult> {
  const m = t();
  const result: CleanupResult = {
    deletedWorktree: false,
    deletedRemoteBranch: false,
    closedPr: false,
  };
  console.log();
  console.log(m["cleanup.header"]);

  // Stop docker compose services.
  if (hasDockerComposeRunning(opts.worktreePath)) {
    const stop = await confirm({
      message: m["cleanup.stopDockerCompose"],
      default: true,
    });
    if (stop) {
      console.log(m["cleanup.stoppingServices"]);
      stopDockerCompose(opts.worktreePath);
    }
  }

  // Delete local worktree and branch.
  const deleteWt = await confirm({
    message: m["cleanup.deleteWorktree"],
    default: false,
  });
  if (deleteWt) {
    console.log(m["cleanup.deletingWorktree"]);
    removeWorktree(opts.owner, opts.repo, opts.issueNumber, opts.branch);
    result.deletedWorktree = true;
  }

  // Delete remote branch (only if one was pushed).
  if (remoteBranchExists(opts.owner, opts.repo, opts.branch)) {
    const delRemote = await confirm({
      message: m["cleanup.deleteRemoteBranch"](opts.branch),
      default: false,
    });
    if (delRemote) {
      console.log(m["cleanup.deletingRemoteBranch"]);
      try {
        deleteRemoteBranch(opts.owner, opts.repo, opts.branch);
        result.deletedRemoteBranch = true;
      } catch {
        // Ignore — branch may already be deleted.
      }
    }
  }

  // Close PR (only if one exists).
  if (opts.prNumber !== undefined) {
    const close = await confirm({
      message: m["cleanup.closePr"](opts.prNumber),
      default: false,
    });
    if (close) {
      console.log(m["cleanup.closingPr"]);
      try {
        closePr(opts.owner, opts.repo, opts.prNumber);
        result.closedPr = true;
      } catch {
        // Ignore — PR may already be closed or merged.
      }
    }
  }

  console.log(m["cleanup.done"]);
  return result;
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
  let savedState = loadRunState(owner, repo, issueNumber);
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
      // Clear the in-memory reference so downstream code does not
      // hydrate stale issue-sync state (or any other fields) from a
      // previous run into the fresh pipeline.
      savedState = undefined;
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
  if (startFromStage !== undefined) {
    console.log(m["boot.resumingFromStage"](startFromStage));
  }

  // Create agent adapters with process tracking for Ctrl+C cleanup.
  const activeStreams = new Set<AgentStream>();
  const inactivityTimeoutMs =
    pipelineSettings.inactivityTimeoutMinutes * 60_000;
  const agentA = trackProcesses(
    createAdapter(agentAConfig, inactivityTimeoutMs),
    activeStreams,
  );
  const agentB = trackProcesses(
    createAdapter(agentBConfig, inactivityTimeoutMs),
    activeStreams,
  );

  const issueCtx = { issueTitle, issueBody };
  const issueChanges: IssueChange[] = [...(savedState?.issueChanges ?? [])];
  let issueSyncStatus: IssueSyncStatus =
    savedState?.issueSyncStatus ?? "skipped";

  const implementStage = createImplementStageHandler({
    agent: agentA,
    ...issueCtx,
  });

  const selfCheckStage = {
    ...createSelfCheckStageHandler({
      agent: agentA,
      ...issueCtx,
      onIssueChange: (change) => {
        issueChanges.push(change);
        runState.issueChanges = [...issueChanges];
        saveRunState(runState);
      },
      onIssueSyncStatus: (status) => {
        issueSyncStatus = status;
        runState.issueSyncStatus = status;
        saveRunState(runState);
      },
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
    baseSha: wt.baseSha,
    prNumber: undefined,
    currentStage: 2,
    stageLoopCount: 0,
    reviewRound: 0,
    executionMode,
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
    issueSyncStatus: "skipped",
    issueChanges: [],
  };

  // Save initial state.
  saveRunState(runState);

  // The TUI prompt is created inside <App> at mount time.  Done stage
  // callbacks delegate to it via a late-binding ref so stage 9 shows
  // a real user confirmation instead of auto-approving.
  let tuiPrompt:
    | {
        confirmMerge: UserPrompt["confirmMerge"];
        handleConflict: UserPrompt["handleConflict"];
        handleUnknownMergeable: UserPrompt["handleUnknownMergeable"];
        waitForManualResolve: UserPrompt["waitForManualResolve"];
        confirmCleanup: UserPrompt["confirmCleanup"];
      }
    | undefined;

  const doneStage = createDoneStageHandler({
    checkMergeable: async () => checkMergeable(owner, repo, wt.branch),
    prompt: {
      confirmMerge: async (msg) => {
        if (tuiPrompt) return tuiPrompt.confirmMerge(msg);
        return "merged";
      },
      handleConflict: async (msg) => {
        if (tuiPrompt) return tuiPrompt.handleConflict(msg);
        return "manual";
      },
      handleUnknownMergeable: async (msg) => {
        if (tuiPrompt) return tuiPrompt.handleUnknownMergeable(msg);
        return "exit";
      },
      waitForManualResolve: async (msg) => {
        if (tuiPrompt) return tuiPrompt.waitForManualResolve(msg);
      },
    },
    rebaseOntoMain: async (ctx) => {
      const rebasePrompt = [
        `You are rebasing a feature branch onto the latest main.`,
        ``,
        `## Repository`,
        `- Owner: ${ctx.owner}`,
        `- Repo: ${ctx.repo}`,
        `- Branch: ${ctx.branch}`,
        `- Worktree: ${ctx.worktreePath}`,
        ``,
        `## Instructions`,
        ``,
        `1. Run \`git fetch origin ${defaultBranch}\` to get the latest main.`,
        `2. Run \`git rebase origin/${defaultBranch}\` to rebase onto main.`,
        `3. Resolve any merge conflicts that arise.`,
        `4. After resolving conflicts, verify the result locally:`,
        `   - Build the project to ensure it compiles.`,
        `   - Run the full test suite to ensure nothing is broken.`,
        `5. Only if the build and all tests pass, force-push the branch:`,
        `   \`git push --force-with-lease\``,
        `6. After a successful force-push, post a brief PR comment noting`,
        `   which main commit the branch was rebased onto and a short`,
        `   summary of resolved conflicts. Use:`,
        `   \`gh pr comment --body "<your summary>"\``,
        `   If no PR exists or the comment fails, continue without failing.`,
        ``,
        `IMPORTANT: If you cannot resolve conflicts cleanly or if the`,
        `build/tests fail after resolution, do NOT push. Instead, abort`,
        `the rebase (\`git rebase --abort\`) and report failure.`,
        ``,
        `When you are done, end your response with exactly one of:`,
        `- COMPLETED — if the rebase succeeded and was force-pushed.`,
        `- BLOCKED — if you could not resolve conflicts or tests failed.`,
      ].join("\n");

      ctx.promptSinks?.a?.(rebasePrompt);
      const stream = agentA.invoke(rebasePrompt, {
        cwd: ctx.worktreePath,
        onUsage: ctx.usageSinks?.a,
      });
      if (ctx.streamSinks?.a) {
        drainToSink(stream, ctx.streamSinks.a);
      }
      const result = await stream.result;

      if (result.sessionId) {
        ctx.onSessionId?.("a", result.sessionId);
      }

      if (result.status === "error") {
        return { success: false, message: result.responseText };
      }

      const parsed = parseStepStatus(result.responseText);
      const success =
        parsed.status === "completed" || parsed.status === "fixed";
      return { success, message: result.responseText };
    },
    pollCiAndFix: async (ctx) => {
      return pollCiAndFix({
        ctx,
        agent: agentA,
        issueTitle,
        issueBody,
      });
    },
    cleanup: () => removeWorktree(owner, repo, issueNumber, wt.branch),
    stopServices: () => {
      if (hasDockerComposeRunning(wt.path)) {
        stopDockerCompose(wt.path);
      }
    },
    hasRunningServices: () => hasDockerComposeRunning(wt.path),
    onNotMerged: async (signal) => {
      if (!tuiPrompt) return;
      const m = t();

      // Stop docker compose services.
      if (hasDockerComposeRunning(wt.path)) {
        const stop = await tuiPrompt.confirmCleanup(
          m["cleanup.stopDockerCompose"],
        );
        if (signal?.aborted) return;
        if (stop) stopDockerCompose(wt.path);
      }

      // Delete local worktree and branch.
      const deleteWt = await tuiPrompt.confirmCleanup(
        m["cleanup.deleteWorktree"],
      );
      if (signal?.aborted) return;
      if (deleteWt) {
        removeWorktree(owner, repo, issueNumber, wt.branch);
      }

      // Delete remote branch (only if pushed).
      if (remoteBranchExists(owner, repo, wt.branch)) {
        const delRemote = await tuiPrompt.confirmCleanup(
          m["cleanup.deleteRemoteBranch"](wt.branch),
        );
        if (signal?.aborted) return;
        if (delRemote) {
          try {
            deleteRemoteBranch(owner, repo, wt.branch);
          } catch {
            // Ignore — branch may already be deleted.
          }
        }
      }

      // Close PR (only if one exists).
      // Refresh PR number in case it was detected during the pipeline.
      const prNum = runState.prNumber ?? findPrNumber(owner, repo, wt.branch);
      if (prNum !== undefined) {
        const close = await tuiPrompt.confirmCleanup(
          m["cleanup.closePr"](prNum),
        );
        if (signal?.aborted) return;
        if (close) {
          try {
            closePr(owner, repo, prNum);
          } catch {
            // Ignore — PR may already be closed or merged.
          }
        }
      }
    },
  });

  // The `prompt` field is intentionally omitted here — it will be
  // supplied by the ink <App> component via TuiUserPrompt.
  const pipelineOpts: Omit<PipelineOptions, "prompt" | "events" | "signal"> = {
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
      baseSha: savedState?.baseSha ?? wt.baseSha,
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
  // @inquirer/prompts leaves stdin paused/unref'd after its prompts resolve.
  // Ink's useInput hooks expect stdin to be readable, so restore it here.
  if (process.stdin.isPaused()) {
    process.stdin.resume();
  }
  process.stdin.ref();

  // Suppress the default SIGINT handler so Ctrl+C does not kill the
  // process before Ink can handle it.  The TUI component catches the
  // Ctrl+C keypress and performs graceful cancellation instead.
  const sigintHandler = () => {
    // Handled by Ink useInput — do nothing at process level.
  };
  process.on("SIGINT", sigintHandler);

  const emitter = new PipelineEventEmitter();

  const pipelineResult = await new Promise<PipelineResult>((resolve) => {
    const { unmount } = renderApp({
      emitter,
      pipelineOptions: pipelineOpts,
      onExit: (result: PipelineResult) => {
        unmount();
        resolve(result);
      },
      onPromptReady: (prompt) => {
        tuiPrompt = prompt;
      },
      onCancel: () => {
        // Kill all tracked agent child processes so the pipeline
        // can unwind quickly.  We read `.child` at kill-time so
        // that fallback streams (withXhighFallback) target the
        // currently active child, not the original one.
        for (const stream of activeStreams) {
          stream.child.kill();
        }
      },
      modelNameA: modelDisplayName(agentAConfig),
      modelNameB: modelDisplayName(agentBConfig),
      cliTypeA: agentAConfig.cli,
      cliTypeB: agentBConfig.cli,
    });
  });

  // Remove the SIGINT suppressor so the default handler takes over
  // (allows Ctrl+C to kill during cleanup prompts).
  process.off("SIGINT", sigintHandler);

  console.log();
  console.log(pipelineResult.message);

  // Handle graceful cancellation (Ctrl+C during pipeline).
  if (pipelineResult.cancelled) {
    const m = t();
    console.log(m["pipeline.cancelledSaved"]);

    // Restore stdin for @inquirer/prompts cleanup flow.
    if (process.stdin.isPaused()) {
      process.stdin.resume();
    }
    process.stdin.ref();

    try {
      const cleanup = await runCancellationCleanup({
        owner,
        repo,
        issueNumber,
        branch: wt.branch,
        worktreePath: wt.path,
        prNumber: runState.prNumber ?? findPrNumber(owner, repo, wt.branch),
      });

      // If the user destroyed resume prerequisites (worktree, remote
      // branch, or PR), the saved state would point at artifacts that
      // no longer exist.  Delete it so the next run starts fresh
      // instead of resuming into an inconsistent stage.
      if (
        cleanup.deletedWorktree ||
        cleanup.deletedRemoteBranch ||
        cleanup.closedPr
      ) {
        deleteRunState(owner, repo, issueNumber);
      }
    } catch {
      // If cleanup prompts fail (e.g. second Ctrl+C), just exit.
    }
  } else {
    console.log();
    for (const line of formatIssueSyncSummary(
      issueNumber,
      issueChanges,
      issueSyncStatus,
    )) {
      console.log(line);
    }

    if (pipelineResult.success) {
      deleteRunState(owner, repo, issueNumber);
    }
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
