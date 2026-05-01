#!/usr/bin/env node

import { confirm, input, select } from "@inquirer/prompts";

import type { AgentAdapter, AgentStream } from "./agent.js";
import { type BootstrapLog, createBootstrapLog } from "./bootstrap-log.js";
import { pollCiAndFix } from "./ci-poll.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import {
  closePr,
  deleteRemoteBranch,
  hasDockerComposeRunning,
  remoteBranchExists,
  stopDockerCompose,
} from "./cleanup.js";
import {
  type CleanupInterruptState,
  resilientConfirm,
} from "./cleanup-confirm.js";
import { createCodexAdapter } from "./codex-adapter.js";
import type { NotificationSettings, PipelineSettings } from "./config.js";
import {
  assembleCiCheckStage,
  assembleReviewStage,
  assembleSquashStage,
  loadConfig,
  patchVersionCheckState,
} from "./config.js";
import {
  buildDoneConfirmRetryPrompt,
  createDonePromptOptions,
} from "./done-prompt-options.js";
import { getGitHubUsername, getIssue } from "./github.js";
import { initI18n, t } from "./i18n/index.js";
import {
  formatIssueSyncSummary,
  type IssueChange,
  type IssueSyncStatus,
} from "./issue-sync.js";
import { initModels, ModelsLoadError, setCustomModels } from "./models.js";
import type {
  PipelineOptions,
  PipelineResult,
  UserPrompt,
} from "./pipeline.js";
import { createDoneStageHandler } from "./pipeline.js";
import { PipelineEventEmitter } from "./pipeline-events.js";
import { checkMergeable, findPrNumber, queryPrState } from "./pr.js";
import {
  fetchPrComments,
  findLatestCommentWithMarker,
  type PrComment,
  parsePrReviewState,
  reconcileWithPr,
} from "./pr-comments.js";
import { createRebaseHandler } from "./rebase.js";
import { createRunLog, type RunLogWriter } from "./run-log.js";
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
import {
  createSquashStageHandler,
  parseSquashSuggestionBlock,
  SQUASH_SUGGESTION_START_MARKER,
} from "./stage-squash.js";
import { createTestPlanStageHandler } from "./stage-testplan.js";
import type { AgentConfig } from "./startup.js";
import {
  modelDisplayName,
  promptSquashApplyPolicy,
  runStartup,
  selectTarget,
} from "./startup.js";
import { renderApp } from "./ui/render-app.js";
import {
  type CliName,
  refreshAgentCliVersion,
  runStartupVersionCheck,
  VersionCheckAbortError,
} from "./version-check.js";
import {
  bootstrapRepo,
  cleanReviewerWorktreeChanges,
  createWorktree,
  detectDefaultBranch,
  hasUncommittedChanges,
  prepareReviewerWorktree,
  removeReviewerWorktree,
  removeWorktree,
  reviewerWorktreePath,
  worktreePath,
} from "./worktree.js";

// ---- types ---------------------------------------------------------------

interface RunParams {
  agentAConfig: AgentConfig;
  agentBConfig: AgentConfig;
  executionMode: "auto" | "step";
  pipelineSettings: PipelineSettings;
  notifications: NotificationSettings;
  issueTitle: string;
  issueBody: string;
  startFromStage: number | undefined;
  resuming: boolean;
  /** True when user chose "Start fresh" — worktree should be cleaned. */
  startFresh: boolean;
  /**
   * Per-run policy controlling how a SUGGESTED_SINGLE squash verdict
   * is applied.  `"auto"` proceeds silently with the agent path;
   * `"ask"` presents the mid-pipeline chooser.  Collected fresh on
   * every run (fresh startup AND resume) so the right default can
   * change from run to run.
   */
  squashApplyPolicy: "auto" | "ask";
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
        | "xhigh"
        | "max"
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
 *
 * Each `confirm()` call is wrapped with {@link resilientConfirm} so that
 * Ctrl+C during a prompt increments the shared interrupt counter instead
 * of silently aborting the whole cleanup flow.
 */
async function runCancellationCleanup(opts: {
  owner: string;
  repo: string;
  issueNumber: number;
  branch: string;
  worktreePath: string;
  prNumber: number | undefined;
  interruptState: CleanupInterruptState;
}): Promise<CleanupResult> {
  const m = t();
  const warn = m["cleanup.forceQuitWarning"];
  const result: CleanupResult = {
    deletedWorktree: false,
    deletedRemoteBranch: false,
    closedPr: false,
  };
  console.log();
  console.log(m["cleanup.header"]);

  // Stop docker compose services.
  if (hasDockerComposeRunning(opts.worktreePath)) {
    const stop = await resilientConfirm(
      { message: m["cleanup.stopDockerCompose"], default: true },
      opts.interruptState,
      warn,
    );
    if (stop) {
      console.log(m["cleanup.stoppingServices"]);
      stopDockerCompose(opts.worktreePath);
    }
  }

  // Delete local worktree and branch.
  const deleteWt = await resilientConfirm(
    { message: m["cleanup.deleteWorktree"], default: false },
    opts.interruptState,
    warn,
  );
  if (deleteWt) {
    console.log(m["cleanup.deletingWorktree"]);
    removeWorktree(opts.owner, opts.repo, opts.issueNumber, opts.branch);
    removeReviewerWorktree(opts.owner, opts.repo, opts.issueNumber);
    result.deletedWorktree = true;
  }

  // Delete remote branch (only if one was pushed).
  if (remoteBranchExists(opts.owner, opts.repo, opts.branch)) {
    const delRemote = await resilientConfirm(
      { message: m["cleanup.deleteRemoteBranch"](opts.branch), default: false },
      opts.interruptState,
      warn,
    );
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
    const close = await resilientConfirm(
      { message: m["cleanup.closePr"](opts.prNumber), default: false },
      opts.interruptState,
      warn,
    );
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
    1: m["stage.bootstrap"],
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
  initModels();
  setCustomModels(bootConfig.customModels);

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
        notifications: target.config.notifications,
        issueTitle: issue.title,
        issueBody: issue.body,
        startFromStage: savedState.currentStage,
        resuming: true,
        startFresh: false,
        // Provisional — overwritten below at the shared join point.
        squashApplyPolicy: "auto",
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
    // Reload config to pick up any notification or custom-model changes
    // made during startup.
    const freshConfig = loadConfig();
    setCustomModels(freshConfig.customModels);
    return {
      agentAConfig: result.agentA,
      agentBConfig: result.agentB,
      executionMode: result.executionMode,
      pipelineSettings: result.pipelineSettings,
      notifications: freshConfig.notifications,
      issueTitle: result.issue.title,
      issueBody: result.issue.body,
      startFromStage: undefined,
      resuming: false,
      startFresh: userChoseFresh,
      // Provisional — overwritten below at the shared join point.
      squashApplyPolicy: "auto",
    };
  })();

  // Ask the squash-apply policy once per run, at the shared join
  // point so both the fresh-start and resume branches go through
  // the same prompt.  Routed through `promptSquashApplyPolicy` so
  // the call site is a single named target — see the helper for the
  // semantics of "not persisted" and the default-true rationale.
  params.squashApplyPolicy = await promptSquashApplyPolicy();

  // Check CLI versions against the appropriate distribution channel
  // and prompt the user to update when a newer version is available.
  // Runs after the CLIs actually used this run are known (fresh /
  // resume branches joined, `params` finalized) so we do not prompt
  // for a CLI that is not used this run.
  const versionCheckConfig = loadConfig();
  const uniqueClis: CliName[] = [];
  for (const c of [params.agentAConfig.cli, params.agentBConfig.cli]) {
    if (!uniqueClis.includes(c)) uniqueClis.push(c);
  }
  let cliVersionMap = new Map<CliName, string | undefined>();
  try {
    const versionMessages = t();
    cliVersionMap = await runStartupVersionCheck({
      clis: uniqueClis,
      config: versionCheckConfig,
      persistVersionCheckState: patchVersionCheckState,
      prompts: {
        confirmUpdate: async (message) => confirm({ message, default: true }),
        waitForEnter: async (message) => {
          await input({ message, default: "" });
        },
        chooseRetrySkipAbort: async (message) =>
          select({
            message,
            choices: [
              { name: versionMessages["versionCheck.retry"], value: "retry" },
              { name: versionMessages["versionCheck.skip"], value: "skip" },
              { name: versionMessages["versionCheck.abort"], value: "abort" },
            ],
          }),
        log: (msg) => console.log(msg),
        warn: (msg) => console.warn(msg),
      },
      translations: {
        checking: versionMessages["versionCheck.checking"],
        inconclusive: versionMessages["versionCheck.inconclusive"],
        fetchFailed: versionMessages["versionCheck.fetchFailed"],
        upToDate: versionMessages["versionCheck.upToDate"],
        updatePrompt: versionMessages["versionCheck.updatePrompt"],
        updateWaiting: versionMessages["versionCheck.updateWaiting"],
        versionUnchanged: versionMessages["versionCheck.versionUnchanged"],
        retrySkipAbortPrompt:
          versionMessages["versionCheck.retrySkipAbortPrompt"],
        proceedingWith: versionMessages["versionCheck.proceedingWith"],
        abortedByUser: versionMessages["versionCheck.abortedByUser"],
        versionUnknown: versionMessages["versionCheck.versionUnknown"],
      },
    });
  } catch (err) {
    if (err instanceof VersionCheckAbortError) {
      process.exit(1);
    }
    throw err;
  }
  const agentAVersion = cliVersionMap.get(params.agentAConfig.cli);
  const agentBVersion = cliVersionMap.get(params.agentBConfig.cli);

  const {
    agentAConfig,
    agentBConfig,
    executionMode,
    pipelineSettings,
    notifications,
    issueTitle,
    issueBody,
    startFromStage: rawStartFromStage,
    resuming,
    startFresh,
    squashApplyPolicy,
  } = params;

  const m = t();

  // Buffer bootstrap (Stage 1) log lines so they can be replayed into
  // the ink TUI panes once the TUI mounts.  The buffer also prints each
  // line to stdout/stderr live so terminal scrollback is unaffected.
  const bootstrapLog: BootstrapLog = createBootstrapLog();

  // Bootstrap the repository and create a worktree.
  console.log();
  bootstrapLog.log(m["boot.bootstrapping"]);
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
  bootstrapLog.log(m["boot.worktreeReady"](wt.path, wt.branch));
  const reviewerWtPath = reviewerWorktreePath(owner, repo, issueNumber);

  if (wt.hadUncommittedChanges) {
    bootstrapLog.warn(m["boot.uncommittedPreserved"]);
  }

  // Skip stage 4 (PR creation) on resume when the PR already exists.
  // This avoids replaying the side-effectful `gh pr create` if the
  // process was interrupted after the PR was created but before the
  // completion check finished.
  let startFromStage = rawStartFromStage;
  if (startFromStage === 4 && findPrNumber(owner, repo, wt.branch)) {
    bootstrapLog.log(m["boot.prExistsSkip"]);
    startFromStage = 5;
  }

  // Reconcile local review-loop state with PR comments on resume.
  if (resuming && savedState) {
    // Ensure PR number is up to date.
    if (savedState.prNumber === undefined) {
      savedState.prNumber = findPrNumber(owner, repo, wt.branch);
    }
    if (savedState.prNumber !== undefined) {
      let prComments: PrComment[];
      try {
        prComments = fetchPrComments(owner, repo, savedState.prNumber);
      } catch (err) {
        console.error(
          `\n  PR comment fetch failed for PR #${savedState.prNumber}.`,
        );
        console.error(
          "  Cannot reconcile local state with PR — aborting resume.",
        );
        console.error(
          `  Cause: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
      const prState = parsePrReviewState(prComments);
      const { warnings } = reconcileWithPr(savedState, prState);
      for (const w of warnings) {
        console.warn(`  ${w}`);
      }
      // Update startFromStage if reconciliation demoted currentStage.
      if (startFromStage !== undefined) {
        startFromStage = savedState.currentStage;
      }
      saveRunState(savedState);
    }
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

  const ciCheckStage = assembleCiCheckStage(
    (opts) =>
      createCiCheckStageHandler({
        agent: agentA,
        ...issueCtx,
        ...opts,
      }),
    pipelineSettings,
  );

  const testPlanStage = {
    ...createTestPlanStageHandler({
      agent: agentA,
      ...issueCtx,
    }),
    restartFromStage: 5,
  };

  const squashStage = assembleSquashStage(
    (opts) =>
      createSquashStageHandler({
        agent: agentA,
        ...issueCtx,
        defaultBranch,
        squashApplyPolicy,
        chooseSquashApplyMode: async (msg) => {
          if (tuiPrompt) return tuiPrompt.chooseSquashApplyMode(msg);
          return "agent";
        },
        onSquashSubStep: (subStep) => {
          runState.squashSubStep = subStep;
          saveRunState(runState);
        },
        // Getter form — reads live persisted state on each handler
        // invocation so that an in-process retry (e.g. after a
        // ci_poll error) sees the sub-step the previous iteration
        // persisted, not the startup snapshot.  Without this, a
        // retry from ci_poll would see `undefined` and fall into the
        // single-commit skip path once the branch has collapsed.
        savedSquashSubStep: () => runState.squashSubStep,
        // Same live-read pattern for the agent-A session id so the
        // retry can re-use the conversation Stage 8 just persisted.
        // `ctx.savedAgentASessionId` is cleared after the first
        // iteration of the stage's inner loop and cannot be relied on
        // for retries by itself.
        getSavedAgentSessionId: () => runState.agentA.sessionId,
        ...opts,
      }),
    pipelineSettings,
  );

  const reviewStage = assembleReviewStage(
    (opts) =>
      createReviewStageHandler({
        agentA,
        agentB,
        ...issueCtx,
        ...opts,
        getPrNumber: () => runState.prNumber,
        onReviewProgress: (subStep, verdict) => {
          runState.reviewSubStep = subStep;
          if (verdict !== undefined) {
            runState.lastVerdict = verdict;
          } else if (subStep === "review" || subStep === "verdict") {
            // Entering a pre-verdict step for a (possibly new) round —
            // clear the stale verdict from the previous round so that
            // reconciliation does not falsely invalidate sessions.
            runState.lastVerdict = undefined;
          }
          saveRunState(runState);
        },
        onReviewPosted: (round) => {
          runState.reviewCount = round;
          saveRunState(runState);
          emitter.emit("review:posted", { round });
        },
        prepareReviewerWorktree: (ctx) => {
          const path = prepareReviewerWorktree({
            owner: ctx.owner,
            repo: ctx.repo,
            issueNumber: ctx.issueNumber,
            authorBranch: ctx.branch,
          });
          if (runState.reviewerWorktreePath !== path) {
            runState.reviewerWorktreePath = path;
            saveRunState(runState);
          }
        },
        cleanReviewerWorktreeChanges,
      }),
    pipelineSettings,
  );

  // Mutable run state for persistence.
  const runState: RunState = savedState ?? {
    version: RUN_STATE_VERSION,
    owner,
    repo,
    issueNumber,
    branch: wt.branch,
    worktreePath: wt.path,
    reviewerWorktreePath: reviewerWtPath,
    baseSha: wt.baseSha,
    prNumber: undefined,
    currentStage: 2,
    stageLoopCount: 0,
    reviewRound: 0,
    selfCheckCount: 0,
    reviewCount: 0,
    reviewSubStep: undefined,
    squashSubStep: undefined,
    lastVerdict: undefined,
    executionMode,
    agentA: {
      cli: agentAConfig.cli,
      model: agentAConfig.model,
      contextWindow: agentAConfig.contextWindow,
      effortLevel: agentAConfig.effortLevel,
      sessionId: undefined,
      cliVersion: agentAVersion,
    },
    agentB: {
      cli: agentBConfig.cli,
      model: agentBConfig.model,
      contextWindow: agentBConfig.contextWindow,
      effortLevel: agentBConfig.effortLevel,
      sessionId: undefined,
      cliVersion: agentBVersion,
    },
    issueSyncStatus: "skipped",
    issueChanges: [],
  };

  // Refresh the per-run CLI version on resume so the saved state
  // reflects the CLI build this run is actually driving (a CLI
  // upgrade between runs must not be silently discarded).  The helper
  // intentionally leaves the saved value alone when the probe
  // returned `undefined`, so a failed re-probe does not erase the
  // postmortem record from the previous successful run.
  refreshAgentCliVersion(runState.agentA, agentAVersion);
  refreshAgentCliVersion(runState.agentB, agentBVersion);

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
        chooseSquashApplyMode: UserPrompt["chooseSquashApplyMode"];
      }
    | undefined;

  const emitter = new PipelineEventEmitter();

  // Persist selfCheckCount on stage-3 exit.
  emitter.on("stage:exit", (ev) => {
    if (ev.stageNumber === 3) {
      runState.selfCheckCount += 1;
      saveRunState(runState);
    }
  });

  // Persistent run log for post-mortem debugging.
  const runLog: RunLogWriter = createRunLog(emitter, {
    owner,
    repo,
    issueNumber,
    worktreePath: wt.path,
    executionMode,
    agentA: {
      cli: agentAConfig.cli,
      model: agentAConfig.model,
      contextWindow: agentAConfig.contextWindow,
      effortLevel: agentAConfig.effortLevel,
      // Read through `runState` so a failed re-probe on resume keeps
      // the previously recorded version in the run-log header instead
      // of blanking it — preserving the postmortem record matches the
      // behavior already implemented for `RunState` via
      // `refreshAgentCliVersion`.
      cliVersion: runState.agentA.cliVersion,
    },
    agentB: {
      cli: agentBConfig.cli,
      model: agentBConfig.model,
      contextWindow: agentBConfig.contextWindow,
      effortLevel: agentBConfig.effortLevel,
      cliVersion: runState.agentB.cliVersion,
    },
    selfCheckAutoIterations: pipelineSettings.selfCheckAutoIterations,
    reviewAutoRounds: pipelineSettings.reviewAutoRounds,
    ciCheckAutoIterations: pipelineSettings.ciCheckAutoIterations,
    ciCheckTimeoutMinutes: pipelineSettings.ciCheckTimeoutMinutes,
    inactivityTimeoutMinutes: pipelineSettings.inactivityTimeoutMinutes,
    autoResumeAttempts: pipelineSettings.autoResumeAttempts,
  });

  const doneStage = createDoneStageHandler({
    events: emitter,
    checkMergeable: async () => checkMergeable(owner, repo, wt.branch),
    queryPrState: async () => queryPrState(owner, repo, wt.branch),
    prompt: createDonePromptOptions(() => tuiPrompt),
    rebaseOntoMain: createRebaseHandler(agentA, defaultBranch),
    pollCiAndFix: async (ctx) => {
      return pollCiAndFix({
        ctx,
        agent: agentA,
        issueTitle,
        issueBody,
        // Stage 9 bypasses the engine's dispatchError prompt (the
        // Done stage consumes pollCiAndFix inline), so without this
        // opt-in prompt the fix-exhausted, pending-timeout, and
        // agent-error branches would silently end the session.  Ask
        // the user whether to keep trying — `true` resumes per the
        // semantics in `ConfirmRetryInfo`; `false` lets cleanup run.
        confirmRetry: async (info) => {
          if (!tuiPrompt) return false;
          return tuiPrompt.confirmCleanup(buildDoneConfirmRetryPrompt(info));
        },
      });
    },
    cleanup: () => {
      removeWorktree(owner, repo, issueNumber, wt.branch);
      removeReviewerWorktree(owner, repo, issueNumber);
    },
    stopServices: () => {
      if (hasDockerComposeRunning(wt.path)) {
        stopDockerCompose(wt.path);
      }
    },
    hasRunningServices: () => hasDockerComposeRunning(wt.path),
    getSquashMergeHint: () => {
      if (runState.squashSubStep !== "applied_via_github") return undefined;
      const prNum = runState.prNumber ?? findPrNumber(owner, repo, wt.branch);
      // Read-side: silently degrade to "no comment" on transient
      // lookup failure; this hint is purely cosmetic and the write
      // side has its own error-propagating path.
      let commentBody: string | undefined;
      if (prNum !== undefined) {
        try {
          commentBody = findLatestCommentWithMarker(
            owner,
            repo,
            prNum,
            SQUASH_SUGGESTION_START_MARKER,
          )?.body;
        } catch {
          commentBody = undefined;
        }
      }
      const suggestion = parseSquashSuggestionBlock(commentBody);
      const prUrl =
        prNum !== undefined
          ? `https://github.com/${owner}/${repo}/pull/${prNum}`
          : undefined;
      return {
        title: suggestion?.title,
        body: suggestion?.body,
        prUrl,
      };
    },
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
        removeReviewerWorktree(owner, repo, issueNumber);
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
      issueTitle,
      branch: wt.branch,
      worktreePath: wt.path,
      reviewerWorktreePath: reviewerWtPath,
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
        if (runState.prNumber !== undefined) {
          emitter.emit("pr:resolved", { prNumber: runState.prNumber });
        }
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

  const startedAt = Date.now();
  const pipelineResult = await new Promise<PipelineResult>((resolve) => {
    const { unmount } = renderApp({
      emitter,
      pipelineOptions: pipelineOpts,
      onExit: async (result: PipelineResult) => {
        await runLog.close();
        unmount();
        resolve(result);
      },
      onPromptReady: (prompt) => {
        tuiPrompt = prompt;
      },
      startedAt,
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
      cliVersionA: agentAVersion,
      cliVersionB: agentBVersion,
      notifications,
      initialSelfCheckCount: runState.selfCheckCount,
      initialReviewCount: runState.reviewCount,
      initialPrNumber: runState.prNumber,
      bootstrapLog: [...bootstrapLog.entries],
      firstExecutingStage: startFromStage ?? 2,
    });
  });

  // Remove the SIGINT suppressor installed for the TUI phase.
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

    // Guard cleanup prompts against accidental Ctrl+C.  The first
    // Ctrl+C already cancelled the pipeline; during cleanup the user
    // gets one warning before a second Ctrl+C force-quits.
    //
    // The counter is shared between the process-level SIGINT handler
    // (for interrupts between prompts) and the prompt-level
    // ExitPromptError handler inside resilientConfirm (for interrupts
    // during a prompt, which @inquirer/core intercepts on its readline
    // interface before the process handler can fire).
    const interruptState: CleanupInterruptState = { count: 0 };
    const cleanupSigint = () => {
      interruptState.count++;
      if (interruptState.count >= 2) {
        process.exit(1);
      }
      console.log(`\n${m["cleanup.forceQuitWarning"]}`);
    };
    process.on("SIGINT", cleanupSigint);

    try {
      const cleanup = await runCancellationCleanup({
        owner,
        repo,
        issueNumber,
        branch: wt.branch,
        worktreePath: wt.path,
        prNumber: runState.prNumber ?? findPrNumber(owner, repo, wt.branch),
        interruptState,
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
    } finally {
      process.off("SIGINT", cleanupSigint);
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
  if (error instanceof ModelsLoadError) {
    console.error(t()["models.loadFailed"](error.message));
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
