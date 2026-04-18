import type { Messages } from "./messages.js";

export const en: Messages = {
  // ---- quick-start -------------------------------------------------------

  "quickStart.header": "Found saved configuration:",
  "quickStart.agentA": (model) => `  Agent A (author): ${model}`,
  "quickStart.agentB": (model) => `  Agent B (reviewer): ${model}`,
  "quickStart.mode": (exec) => `  Mode: ${exec}`,
  "quickStart.language": (lang) => `  Language: ${lang}`,
  "quickStart.pipelineSettings": "  Pipeline settings:",
  "quickStart.notifications": "  Notifications:",
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
  "startup.settingCiCheckIterations": "CI check auto iterations",
  "startup.settingCiCheckTimeout": "CI check timeout",
  "startup.settingAutoResume": "Auto-resume attempts",
  "startup.settingSuffixMin": "min",
  "startup.adjustSettings": "Adjust any settings?",
  "startup.positiveInteger": "Enter a positive integer",
  "startup.notificationBell": "Terminal bell",
  "startup.notificationDesktop": "Desktop notification",
  "startup.notificationSettings": "Notification settings:",
  "startup.saveChanges": "Save changes to config?",
  "startup.issueState": (state) => `  State: ${state}`,
  "startup.issueLabels": (labels) => `  Labels: ${labels}`,
  "startup.proceedWithIssue": "Proceed with this issue?",
  "startup.issueNotConfirmed": "Issue not confirmed. Aborting.",

  // ---- custom model entry --------------------------------------------------

  "startup.customModelOption": "Enter custom model...",
  "startup.customModelValue": "Model identifier (passed to --model):",
  "startup.customModelName": "Display name (leave blank to use identifier):",
  "startup.customModelInvalidClaude":
    "Must match: opus, sonnet, haiku, or claude-<name> (lowercase alphanumeric and hyphens)",
  "startup.customModelInvalidCodex":
    "Must match: gpt-<name> or o<number>[-<name>] (lowercase alphanumeric, hyphens, dots)",
  "startup.customModelDuplicate": (name) => `Already exists as "${name}"`,

  // ---- custom model management -----------------------------------------------

  "startup.manageCustomModelsOption": "Manage custom models...",
  "startup.manageCustomModelsList": "Custom models:",
  "startup.manageCustomModelsAction": (name) => `${name}:`,
  "startup.manageCustomModelsEdit": "Edit",
  "startup.manageCustomModelsRemove": "Remove",
  "startup.manageCustomModelsBack": "Back",
  "startup.manageCustomModelsConfirmRemove": (name) => `Remove "${name}"?`,

  // ---- model registry ------------------------------------------------------

  "models.loadFailed": (detail) =>
    `Failed to load model definitions: ${detail}`,

  // ---- resume / run state ------------------------------------------------

  "resume.savedStateFound": "  Saved run state found:",
  "resume.stage": (stage, name) => `    Stage: ${stage} (${name})`,
  "resume.loopCount": (count) => `    Loop count: ${count}`,
  "resume.branch": (branch) => `    Branch: ${branch}`,
  "resume.pr": (prNumber) => `    PR: #${prNumber}`,
  "resume.reviewRound": (round) => `    Review round: ${round}`,
  "resume.mode": (mode) => `    Mode: ${mode}`,
  "resume.agentA": (model) => `    Agent A (author): ${model}`,
  "resume.agentB": (model) => `    Agent B (reviewer): ${model}`,
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
  "boot.agentA": (model) => `  Agent A (author): ${model}`,
  "boot.agentB": (model) => `  Agent B (reviewer): ${model}`,
  "boot.mode": (mode) => `  Mode: ${mode}`,
  "boot.resumingFromStage": (stage) => `  Resuming from stage: ${stage}`,

  // ---- stage names -------------------------------------------------------

  "stage.bootstrap": "Bootstrap",
  "stage.implement": "Implement",
  "stage.selfCheck": "Self-check",
  "stage.createPr": "Create PR",
  "stage.ciCheck": "CI check",
  "stage.testPlan": "Test plan verification",
  "stage.squash": "Squash commits",
  "stage.rebase": "Rebase",
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
  "pipeline.mergeConfirmSquashTip":
    "If this repo allows 'Squash and merge', the suggested commit " +
    "message is in the PR body.",
  "pipeline.suggestedSquashTitle": (title) => `Suggested title: ${title}`,
  "pipeline.suggestedSquashBody": "Suggested body:",
  "pipeline.prUrl": (url) => `PR: ${url}`,
  "pipeline.worktreeCleanedUp": "Worktree cleaned up.",
  "pipeline.worktreePreserved": "Worktree preserved (merge not confirmed).",
  "pipeline.conflictsDetected":
    "Pipeline completed, but merge conflicts with main detected.",
  "pipeline.unknownMergeable":
    "Could not determine merge status after retries.",
  "pipeline.noConflicts": "No conflicts found — already up to date with main.",
  "pipeline.rebaseFailed":
    "Agent could not resolve conflicts. Please resolve manually.",
  "pipeline.rebaseAlreadyAttempted":
    "Agent rebase was already attempted. Please resolve conflicts manually.",

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
  "prompt.checkConflictsRebase": "No, check conflicts and rebase",
  "prompt.noExit": "No, exit",
  "prompt.agentRebase": "Let agent rebase",
  "prompt.manualResolve": "Resolve manually",
  "prompt.recheck": "Re-check",
  "prompt.exit": "Exit",
  "prompt.pressAnyKeyWhenDone": "Press Enter when done.",

  // ---- status bar --------------------------------------------------------

  "statusBar.initialising": "Initialising...",
  "statusBar.stage": (number, name) => `Stage ${number}: ${name}`,
  "statusBar.stageRound": (number, name, round) =>
    `Stage ${number}: ${name} (round ${round})`,
  "statusBar.bootstrapTransition": (fromNum, fromName, toNum, toName) =>
    `Stage ${fromNum}: ${fromName} \u2192 Stage ${toNum}: ${toName}`,
  "statusBar.last": (outcome) => `Last: ${outcome}`,
  "statusBar.base": (sha) => `Base: ${sha}`,
  "statusBar.pr": (prNumber) => `PR: #${prNumber}`,
  "statusBar.completed": (selfCheckCount, reviewCount) =>
    `Completed: self-check \u00d7${selfCheckCount}, review \u00d7${reviewCount}`,
  "statusBar.layout": (mode) => `Layout: ${mode}`,
  "statusBar.layoutHorizontal": "horizontal",
  "statusBar.layoutVertical": "vertical",
  "statusBar.keyHints":
    "\u25CF:Active  [*]:Focused  Tab:Switch pane  \u2191\u2193:Scroll  PgUp/Dn:Page scroll  Ctrl+L:Layout  Ctrl+C:Quit",
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
  "tokenBar.agentUsageCached": (
    label,
    inputTokens,
    cachedTokens,
    outputTokens,
  ) =>
    `${label}: ${inputTokens} in (${cachedTokens} cached) / ${outputTokens} out`,
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
  "agent.labelShortA": "A",
  "agent.labelShortB": "B",
  "agent.labelARole": "Agent A (author)",
  "agent.labelBRole": "Agent B (reviewer)",

  // ---- CI / stage result messages -----------------------------------------

  "ci.pendingTimeout": (seconds) =>
    `CI checks still pending after ${seconds}s. ` +
    `The pipeline cannot proceed until CI completes.`,
  "ci.passed": "CI checks passed.",
  "ci.passedWithFindings":
    "CI checks passed. Findings were reviewed by the agent.",
  "ci.stillFailing": (attempts) =>
    `CI still failing after ${attempts} fix attempt(s).`,
  "ci.agentError": (detail) => `Agent error during CI fix: ${detail}`,
  "squash.completed": "Commits squashed and CI passed.",
  "squash.singleCommitSkip": "Single commit — skipping squash.",
  "squash.messageAppended":
    "Suggested squash commit message written to PR body. " +
    "Apply it via GitHub's 'Squash and merge' at merge time.",
  "squash.singleChoicePrompt":
    "A single squash commit looks appropriate. " +
    "How should the suggested message be applied?",
  "squash.singleChoiceAgent":
    "Let agent squash now (force-push, runs CI again)",
  "squash.singleChoiceGithub":
    "Apply via GitHub 'Squash and merge' at merge time (no CI rerun)",
  "squash.agentChoiceMissingSession":
    "Cannot perform the squash: the agent session required to continue " +
    "the conversation was lost. Re-run stage 8 or apply the suggestion " +
    "via GitHub's 'Squash and merge' at merge time.",
  "review.approved": (round) => `Review approved at round ${round}.`,
  "review.unresolvedItems": (base, summary) =>
    `${base}\n\nUnresolved items:\n${summary}`,
  "review.fixesApplied": (round) =>
    `Round ${round} fixes applied, CI passed. Proceeding to next review round.`,
  "review.finalizationUnverified": (issueNumber) =>
    `PR finalization verdict was ambiguous and the PR body does not reference issue #${issueNumber}. Manual verification required.`,
  "review.missingAuthorComment": (round) =>
    `Expected [Author Round ${round}] comment not found on PR. Cannot proceed with review.`,
  "review.missingReviewerComment": (round) =>
    `Expected [Reviewer Round ${round}] comment not found on PR. Cannot proceed with author fix.`,

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
  "cleanup.forceQuitWarning":
    "Cleanup in progress. Press Ctrl+C again to force quit.",
  "prompt.yesCleanup": "Yes",
  "prompt.noSkipCleanup": "No",

  // ---- worktree errors ---------------------------------------------------

  // ---- notifications -------------------------------------------------------

  "notification.title": "agentcoop",

  // ---- worktree errors ---------------------------------------------------

  "worktree.alreadyExists": (path) =>
    `Worktree already exists at ${path}. ` +
    "Provide a conflictChoice (reuse | clean | halt).",
  "worktree.haltConflict":
    "User chose to halt \u2014 worktree conflict unresolved.",
};
