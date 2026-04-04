import type { Messages } from "./messages.js";

export const en: Messages = {
  // ---- quick-start -------------------------------------------------------

  "quickStart.header": "Found saved configuration:",
  "quickStart.agentA": (model) => `  Agent A: ${model}`,
  "quickStart.agentB": (model) => `  Agent B: ${model}`,
  "quickStart.mode": (exec) => `  Mode: ${exec}`,
  "quickStart.language": (lang) => `  Language: ${lang}`,
  "quickStart.usePrevious": "Use previous settings?",

  // ---- startup / config --------------------------------------------------

  "startup.enterOwner": "Enter GitHub owner:",
  "startup.ownerEmpty": "Owner cannot be empty",
  "startup.selectOrg": "Select organization:",
  "startup.selectRepo": "Select repository: (type to filter)",
  "startup.noRepos": (owner) => `No repositories found for ${owner}`,
  "startup.issueNumber": "Issue number:",
  "startup.invalidIssueNumber": "Enter a valid issue number",
  "startup.agentCli": (label) => `${label} CLI:`,
  "startup.agentModel": (label) => `${label} model:`,
  "startup.agentContext": (label) => `${label} context window:`,
  "startup.agentEffort": (label) => `${label} effort level:`,
  "startup.executionMode": "Execution mode:",
  "startup.language": "Language:",
  "startup.languageEnglish": "English",
  "startup.languageKorean": "Korean",
  "startup.pipelineSettingsHeader":
    "  Pipeline settings (press Enter to keep defaults):",
  "startup.settingSelfCheck": "Self-check auto iterations",
  "startup.settingReviewRounds": "Review auto rounds",
  "startup.settingInactivityTimeout": "Inactivity timeout",
  "startup.settingAutoResume": "Auto-resume attempts",
  "startup.settingSuffixMin": "min",
  "startup.adjustSettings": "Adjust any settings?",
  "startup.positiveInteger": "Enter a positive integer",
  "startup.saveChanges": "Save changes to config?",
  "startup.issueState": (state) => `  State: ${state}`,
  "startup.issueLabels": (labels) => `  Labels: ${labels}`,
  "startup.proceedWithIssue": "Proceed with this issue?",
  "startup.issueNotConfirmed": "Issue not confirmed. Aborting.",

  // ---- resume / run state ------------------------------------------------

  "resume.savedStateFound": "  Saved run state found:",
  "resume.stage": (stage, name) => `    Stage: ${stage} (${name})`,
  "resume.loopCount": (count) => `    Loop count: ${count}`,
  "resume.branch": (branch) => `    Branch: ${branch}`,
  "resume.pr": (prNumber) => `    PR: #${prNumber}`,
  "resume.reviewRound": (round) => `    Review round: ${round}`,
  "resume.mode": (mode) => `    Mode: ${mode}`,
  "resume.agentA": (model) => `    Agent A: ${model}`,
  "resume.agentB": (model) => `    Agent B: ${model}`,
  "resume.resumeOrFresh": "Resume or start fresh?",
  "resume.resume": "Resume",
  "resume.startFresh": "Start fresh",
  "resume.uncommittedWarning":
    "The existing worktree has uncommitted changes. " +
    "Starting fresh will discard them. Continue?",
  "resume.abortedUncommitted":
    "Aborted: user declined to discard uncommitted changes.",

  // ---- bootstrap / pipeline start ----------------------------------------

  "boot.requiresTTY": "agentcoop requires an interactive terminal.",
  "boot.bootstrapping": "Bootstrapping repository...",
  "boot.worktreeReady": (path, branch) =>
    `Worktree ready at ${path} (branch: ${branch})`,
  "boot.uncommittedPreserved":
    "\u26A0 The existing worktree had uncommitted changes that were preserved.",
  "boot.prExistsSkip":
    "  PR already exists \u2014 skipping to stage 5 (CI check).",
  "boot.startingPipeline": (owner, repo, issue, resuming) =>
    `Starting pipeline for ${owner}/${repo}#${issue}${resuming ? " (resuming)" : ""}`,
  "boot.agentA": (model) => `  Agent A: ${model}`,
  "boot.agentB": (model) => `  Agent B: ${model}`,
  "boot.mode": (mode) => `  Mode: ${mode}`,
  "boot.resumingFromStage": (stage) => `  Resuming from stage: ${stage}`,

  // ---- stage names -------------------------------------------------------

  "stage.implement": "Implement",
  "stage.selfCheck": "Self-check",
  "stage.createPr": "Create PR",
  "stage.ciCheck": "CI check",
  "stage.testPlan": "Test plan verification",
  "stage.squash": "Squash commits",
  "stage.review": "Review",
  "stage.done": "Done",

  // ---- pipeline engine ---------------------------------------------------

  "pipeline.userSkipped": (stage, name) =>
    `User skipped stage ${stage} (${name}).`,
  "pipeline.userDeclinedLoop": (iteration) =>
    `User declined to continue loop at iteration ${iteration}.`,
  "pipeline.userDeclinedRestartLoop": (iteration) =>
    `User declined to continue restart loop at iteration ${iteration}.`,
  "pipeline.invalidRestartTarget": (stage) =>
    `Invalid restart target: stage ${stage}.`,
  "pipeline.completed": "Pipeline completed successfully.",
  "pipeline.userHaltedBlocked": "User halted on blocked agent.",
  "pipeline.userHaltedAmbiguous": "User halted on ambiguous response.",
  "pipeline.pipelineCompleted": (owner, repo, issue) =>
    `Pipeline for ${owner}/${repo}#${issue} completed.`,
  "pipeline.mergeConfirm":
    "Has the PR been merged? Confirm to clean up the worktree.",
  "pipeline.worktreeCleanedUp": "Worktree cleaned up.",
  "pipeline.worktreePreserved": "Worktree preserved (merge not confirmed).",

  // ---- TUI user prompts --------------------------------------------------

  "prompt.continueLoop": (stageName, iteration) =>
    `Stage "${stageName}" has run ${iteration} iteration(s). Continue?`,
  "prompt.yesContinue": "Yes, continue",
  "prompt.noStop": "No, stop",
  "prompt.nextStage": (stageName) =>
    `Ready to enter stage "${stageName}". Proceed?`,
  "prompt.yes": "Yes",
  "prompt.skip": "Skip",
  "prompt.blocked": (message) => `BLOCKED: ${message}`,
  "prompt.proceedAnyway": "Proceed anyway",
  "prompt.giveInstruction": "Give instruction",
  "prompt.halt": "Halt",
  "prompt.enterInstruction": "Enter your instruction:",
  "prompt.error": (message) => `ERROR: ${message}`,
  "prompt.retry": "Retry",
  "prompt.abort": "Abort",
  "prompt.ambiguous": (message) => `Ambiguous agent response:\n${message}`,
  "prompt.proceed": "Proceed",
  "prompt.yesMerged": "Yes, merged",
  "prompt.noKeepWorktree": "No, keep worktree",
  "prompt.ok": "OK",

  // ---- status bar --------------------------------------------------------

  "statusBar.initialising": "Initialising...",
  "statusBar.stage": (number, name) => `Stage ${number}: ${name}`,
  "statusBar.stageRoundInProgress": (number, name, round) =>
    `Stage ${number}: ${name} (round ${round}, in progress)`,
  "statusBar.stageRoundDone": (number, name, round) =>
    `Stage ${number}: ${name} (round ${round}, done)`,
  "statusBar.last": (outcome) => `Last: ${outcome}`,
  "statusBar.base": (sha) => `Base: ${sha}`,
  "statusBar.completed": (selfCheckCount, reviewCount) =>
    `Completed: self-check \u00d7${selfCheckCount}, review \u00d7${reviewCount}`,
  "statusBar.layout": (mode) => `Layout: ${mode}`,
  "statusBar.layoutHorizontal": "horizontal",
  "statusBar.layoutVertical": "vertical",
  "statusBar.keyHints":
    "Tab:Switch pane  \u2191\u2193:Scroll  PgUp/Dn:Page scroll  Ctrl+C:Quit",
  "outcome.completed": "completed",
  "outcome.fixed": "fixed",
  "outcome.approved": "approved",
  "outcome.not_approved": "not approved",
  "outcome.blocked": "blocked",
  "outcome.needs_clarification": "needs clarification",
  "outcome.error": "error",

  // ---- token bar ----------------------------------------------------------

  "tokenBar.agentUsage": (label, inputTokens, outputTokens) =>
    `${label}: ${inputTokens} in / ${outputTokens} out`,
  "tokenBar.noUsage": "No token data yet",

  // ---- input area --------------------------------------------------------

  "input.pipelineRunning": "Pipeline running...",

  // ---- agent pane / labels ------------------------------------------------

  "agentPane.tooSmall": "(pane too small)",
  "agentPane.waiting": "(waiting for output)",
  "agentPane.idle": "(idle — active in review stage)",
  "agentPane.linesAbove": (count) => `\u2191 ${count} more lines`,
  "agentPane.linesBelow": (count) => `\u2193 ${count} more lines`,
  "agent.labelA": "Agent A",
  "agent.labelB": "Agent B",
  "agent.labelARole": "Agent A (author)",
  "agent.labelBRole": "Agent B (reviewer)",

  // ---- CI / stage result messages -----------------------------------------

  "ci.pendingTimeout": (seconds) =>
    `CI checks still pending after ${seconds}s. ` +
    `The pipeline cannot proceed until CI completes.`,
  "ci.passed": "CI checks passed.",
  "ci.stillFailing": (attempts) =>
    `CI still failing after ${attempts} fix attempt(s).`,
  "ci.fixLoopExhausted": "CI fix loop exhausted.",
  "ci.agentError": (detail) => `Agent error during CI fix: ${detail}`,
  "squash.completed": "Commits squashed and CI passed.",
  "squash.singleCommitSkip": "Single commit — skipping squash.",
  "review.approved": (round) => `Review approved at round ${round}.`,
  "review.unresolvedItems": (base, summary) =>
    `${base}\n\nUnresolved items:\n${summary}`,
  "review.fixesApplied": (round) =>
    `Round ${round} fixes applied, CI passed. Proceeding to next review round.`,

  // ---- stage-util errors -------------------------------------------------

  "stageError.maxTurns": (context) =>
    `Agent hit the maximum turn limit${context}.`,
  "stageError.inactivityTimeout": (context) =>
    `Agent process timed out due to inactivity${context}.`,
  "stageError.configParsing": (context, detail) =>
    `Agent CLI rejected its configuration${context}. ` +
    `Check ~/.codex/config.toml for unsupported values: ${detail}`,
  "stageError.agentError": (context, detail) =>
    `Agent error${context}: ${detail}`,

  // ---- issue sync ---------------------------------------------------------

  "issueSync.summaryHeader": (issueNumber) => `Issue #${issueNumber}:`,
  "issueSync.summaryMinor": (description) =>
    `  - Updated (minor): ${description}`,
  "issueSync.summaryMajor": (description) =>
    `  - Comment added (major): ${description}`,
  "issueSync.summaryNoChanges": "  - No changes",
  "issueSync.summarySkipped": "  - Sync skipped",
  "issueSync.summaryFailed": "  - Sync failed",

  // ---- cancellation / cleanup --------------------------------------------

  "pipeline.cancelled": "Pipeline cancelled.",
  "pipeline.cancelledSaved":
    "Run state saved — you can resume this pipeline later.",
  "cleanup.header": "Cleanup options:",
  "cleanup.stopDockerCompose":
    "Docker Compose services are running. Stop them?",
  "cleanup.deleteWorktree": "Delete local worktree and branch?",
  "cleanup.deleteRemoteBranch": (branch) => `Delete remote branch "${branch}"?`,
  "cleanup.closePr": (prNumber) => `Close PR #${prNumber}?`,
  "cleanup.stoppingServices": "  Stopping Docker Compose services...",
  "cleanup.deletingWorktree": "  Deleting local worktree and branch...",
  "cleanup.deletingRemoteBranch": "  Deleting remote branch...",
  "cleanup.closingPr": "  Closing PR...",
  "cleanup.done": "Cleanup complete.",
  "prompt.yesCleanup": "Yes",
  "prompt.noSkipCleanup": "No",

  // ---- worktree errors ---------------------------------------------------

  "worktree.alreadyExists": (path) =>
    `Worktree already exists at ${path}. ` +
    "Provide a conflictChoice (reuse | clean | halt).",
  "worktree.haltConflict":
    "User chose to halt \u2014 worktree conflict unresolved.",
};
