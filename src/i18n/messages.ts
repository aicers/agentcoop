/**
 * Message catalog type for i18n support.
 *
 * Every user-facing string in the application is defined here.
 * Template parameters use functions; plain strings are literals.
 */
export interface Messages {
  // ---- quick-start (startup.ts) -------------------------------------------

  "quickStart.header": string;
  "quickStart.agentA": (model: string) => string;
  "quickStart.agentB": (model: string) => string;
  "quickStart.mode": (exec: string) => string;
  "quickStart.language": (lang: string) => string;
  "quickStart.pipelineSettings": string;
  "quickStart.notifications": string;
  "quickStart.usePrevious": string;

  // ---- startup / config (startup.ts) -------------------------------------

  "startup.enterOwner": string;
  "startup.ownerEmpty": string;
  "startup.selectOrg": string;
  "startup.selectRepo": string;
  "startup.noRepos": (owner: string) => string;
  "startup.issueNumber": string;
  "startup.invalidIssueNumber": string;
  "startup.agentCli": (label: string) => string;
  "startup.agentModel": (label: string) => string;
  "startup.agentContext": (label: string) => string;
  "startup.agentEffort": (label: string) => string;
  "startup.executionMode": string;
  "startup.language": string;
  "startup.languageEnglish": string;
  "startup.languageKorean": string;
  "startup.pipelineSettingsHeader": string;
  "startup.settingSelfCheck": string;
  "startup.settingReviewRounds": string;
  "startup.settingInactivityTimeout": string;
  "startup.settingCiCheckIterations": string;
  "startup.settingCiCheckTimeout": string;
  "startup.settingAutoResume": string;
  "startup.settingSuffixMin": string;
  "startup.adjustSettings": string;
  "startup.positiveInteger": string;
  "startup.notificationBell": string;
  "startup.notificationDesktop": string;
  "startup.notificationSettings": string;
  "startup.saveChanges": string;
  "startup.issueState": (state: string) => string;
  "startup.issueLabels": (labels: string) => string;
  "startup.proceedWithIssue": string;
  "startup.issueNotConfirmed": string;

  // ---- custom model entry (startup.ts) -------------------------------------

  "startup.customModelOption": string;
  "startup.customModelValue": string;
  "startup.customModelName": string;
  "startup.customModelInvalidClaude": string;
  "startup.customModelInvalidCodex": string;
  "startup.customModelDuplicate": (existingName: string) => string;

  // ---- custom model management (startup.ts) ----------------------------------

  "startup.manageCustomModelsOption": string;
  "startup.manageCustomModelsList": string;
  "startup.manageCustomModelsAction": (name: string) => string;
  "startup.manageCustomModelsEdit": string;
  "startup.manageCustomModelsRemove": string;
  "startup.manageCustomModelsBack": string;
  "startup.manageCustomModelsConfirmRemove": (name: string) => string;

  // ---- model registry (models.ts / index.ts) --------------------------------

  "models.loadFailed": (detail: string) => string;

  // ---- resume / run state (index.ts) -------------------------------------

  "resume.savedStateFound": string;
  "resume.stage": (stage: number, name: string) => string;
  "resume.loopCount": (count: number) => string;
  "resume.branch": (branch: string) => string;
  "resume.pr": (prNumber: number) => string;
  "resume.reviewRound": (round: number) => string;
  "resume.mode": (mode: string) => string;
  "resume.agentA": (model: string) => string;
  "resume.agentB": (model: string) => string;
  "resume.resumeOrFresh": string;
  "resume.resume": string;
  "resume.startFresh": string;
  "resume.uncommittedWarning": string;
  "resume.abortedUncommitted": string;

  // ---- bootstrap / pipeline start (index.ts) -----------------------------

  "boot.requiresTTY": string;
  "boot.bootstrapping": string;
  "boot.worktreeReady": (path: string, branch: string) => string;
  "boot.uncommittedPreserved": string;
  "boot.prExistsSkip": string;
  "boot.startingPipeline": (
    owner: string,
    repo: string,
    issue: number,
    resuming: boolean,
  ) => string;
  "boot.agentA": (model: string) => string;
  "boot.agentB": (model: string) => string;
  "boot.mode": (mode: string) => string;
  "boot.resumingFromStage": (stage: number) => string;

  // ---- stage names -------------------------------------------------------

  "stage.bootstrap": string;
  "stage.implement": string;
  "stage.selfCheck": string;
  "stage.createPr": string;
  "stage.ciCheck": string;
  "stage.testPlan": string;
  "stage.squash": string;
  "stage.rebase": string;
  "stage.review": string;
  "stage.done": string;

  // ---- pipeline engine (pipeline.ts) -------------------------------------

  "pipeline.userSkipped": (stage: number, name: string) => string;
  "pipeline.userDeclinedLoop": (iteration: number) => string;
  "pipeline.userDeclinedRestartLoop": (iteration: number) => string;
  "pipeline.invalidRestartTarget": (stage: number) => string;
  "pipeline.completed": string;
  "pipeline.userHaltedBlocked": string;
  "pipeline.userHaltedAmbiguous": string;
  "pipeline.pipelineCompleted": (
    owner: string,
    repo: string,
    issue: number,
  ) => string;
  "pipeline.mergeConfirm": string;
  "pipeline.mergeConfirmSquashTip": string;
  "pipeline.suggestedSquashTitle": string;
  "pipeline.suggestedSquashBody": string;
  "pipeline.prUrl": (url: string) => string;
  "pipeline.worktreeCleanedUp": string;
  "pipeline.worktreePreserved": string;
  "pipeline.conflictsDetected": string;
  "pipeline.unknownMergeable": string;
  "pipeline.noConflicts": string;
  "pipeline.rebaseFailed": string;
  "pipeline.rebaseAlreadyAttempted": string;
  "pipeline.prAlreadyMerged": string;

  // ---- TUI user prompts (TuiUserPrompt.ts) -------------------------------

  "prompt.continueLoop": (stageName: string, iteration: number) => string;
  "prompt.yesContinue": string;
  "prompt.noStop": string;
  "prompt.nextStage": (stageName: string) => string;
  "prompt.yes": string;
  "prompt.skip": string;
  "prompt.blocked": (message: string) => string;
  "prompt.proceedAnyway": string;
  "prompt.giveInstruction": string;
  "prompt.halt": string;
  "prompt.enterInstruction": string;
  "prompt.error": (message: string) => string;
  "prompt.retry": string;
  "prompt.abort": string;
  "prompt.ambiguous": (message: string) => string;
  "prompt.proceed": string;
  "prompt.yesMerged": string;
  "prompt.checkConflictsRebase": string;
  "prompt.noExit": string;
  "prompt.agentRebase": string;
  "prompt.manualResolve": string;
  "prompt.recheck": string;
  "prompt.exit": string;
  "prompt.pressAnyKeyWhenDone": string;

  // ---- status bar (StatusBar.tsx) ----------------------------------------

  "statusBar.initialising": string;
  "statusBar.stage": (number: number, name: string) => string;
  "statusBar.stageRound": (
    number: number,
    name: string,
    round: number,
  ) => string;
  "statusBar.bootstrapTransition": (
    fromNum: number,
    fromName: string,
    toNum: number,
    toName: string,
  ) => string;
  "statusBar.last": (outcome: string) => string;
  "statusBar.base": (sha: string) => string;
  "statusBar.pr": (prNumber: number) => string;
  "statusBar.completed": (
    selfCheckCount: number,
    reviewCount: number,
  ) => string;
  "statusBar.layout": (mode: string) => string;
  "statusBar.layoutHorizontal": string;
  "statusBar.layoutVertical": string;
  "statusBar.keyHints": string;
  "outcome.completed": string;
  "outcome.fixed": string;
  "outcome.approved": string;
  "outcome.not_approved": string;
  "outcome.blocked": string;
  "outcome.needs_clarification": string;
  "outcome.error": string;

  // ---- token bar (TokenBar.tsx) ------------------------------------------

  "tokenBar.agentUsage": (
    label: string,
    inputTokens: string,
    outputTokens: string,
  ) => string;
  "tokenBar.agentUsageCached": (
    label: string,
    inputTokens: string,
    cachedTokens: string,
    outputTokens: string,
  ) => string;
  "tokenBar.noUsage": string;

  // ---- input area (InputArea.tsx) ----------------------------------------

  "input.pipelineRunning": string;

  // ---- agent pane / labels ------------------------------------------------

  "agentPane.tooSmall": string;
  "agentPane.waiting": string;
  "agentPane.idle": string;
  "agentPane.linesAbove": (count: number) => string;
  "agentPane.linesBelow": (count: number) => string;
  "agent.labelA": string;
  "agent.labelB": string;
  "agent.labelShortA": string;
  "agent.labelShortB": string;
  "agent.labelARole": string;
  "agent.labelBRole": string;

  // ---- CI / stage result messages -----------------------------------------

  "ci.pendingTimeout": (seconds: number) => string;
  "ci.passed": string;
  "ci.passedWithFindings": string;
  "ci.stillFailing": (attempts: number) => string;
  "ci.agentError": (detail: string) => string;
  "squash.completed": string;
  "squash.singleCommitSkip": string;
  "squash.messageAppended": string;
  "squash.singleChoicePrompt": string;
  "squash.singleChoiceAgent": string;
  "squash.singleChoiceGithub": string;
  "squash.agentChoiceMissingSession": string;
  "squash.alreadyMerged": string;
  "review.approved": (round: number) => string;
  "review.unresolvedItems": (base: string, summary: string) => string;
  "review.fixesApplied": (round: number) => string;
  "review.finalizationUnverified": (issueNumber: number) => string;
  "review.missingAuthorComment": (round: number) => string;
  "review.missingReviewerComment": (round: number) => string;

  // ---- stage-util errors -------------------------------------------------

  "stageError.maxTurns": (context: string) => string;
  "stageError.inactivityTimeout": (context: string) => string;
  "stageError.configParsing": (context: string, detail: string) => string;
  "stageError.agentError": (context: string, detail: string) => string;

  // ---- issue sync ---------------------------------------------------------

  "issueSync.summaryHeader": (issueNumber: number) => string;
  "issueSync.summaryMinor": (description: string) => string;
  "issueSync.summaryMajor": (description: string) => string;
  "issueSync.summaryNoChanges": string;
  "issueSync.summarySkipped": string;
  "issueSync.summaryFailed": string;

  // ---- cancellation / cleanup --------------------------------------------

  "pipeline.cancelled": string;
  "pipeline.cancelledSaved": string;
  "cleanup.header": string;
  "cleanup.stopDockerCompose": string;
  "cleanup.deleteWorktree": string;
  "cleanup.deleteRemoteBranch": (branch: string) => string;
  "cleanup.closePr": (prNumber: number) => string;
  "cleanup.stoppingServices": string;
  "cleanup.deletingWorktree": string;
  "cleanup.deletingRemoteBranch": string;
  "cleanup.closingPr": string;
  "cleanup.done": string;
  "cleanup.forceQuitWarning": string;
  "prompt.yesCleanup": string;
  "prompt.noSkipCleanup": string;

  // ---- worktree errors ---------------------------------------------------

  // ---- notifications -------------------------------------------------------

  "notification.title": string;

  // ---- worktree errors ---------------------------------------------------

  "worktree.alreadyExists": (path: string) => string;
  "worktree.haltConflict": string;
}
