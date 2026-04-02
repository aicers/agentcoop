/**
 * Message catalog type for i18n support.
 *
 * Every user-facing string in the application is defined here.
 * Template parameters use functions; plain strings are literals.
 */
export interface Messages {
  // ---- startup / config (startup.ts) -------------------------------------

  "startup.enterOwner": string;
  "startup.ownerEmpty": string;
  "startup.selectOrg": string;
  "startup.selectRepo": string;
  "startup.noRepos": (owner: string) => string;
  "startup.issueNumber": string;
  "startup.invalidIssueNumber": string;
  "startup.agentModel": (label: string) => string;
  "startup.executionMode": string;
  "startup.claudePermission": string;
  "startup.language": string;
  "startup.languageEnglish": string;
  "startup.languageKorean": string;
  "startup.pipelineSettingsHeader": string;
  "startup.settingSelfCheck": string;
  "startup.settingReviewRounds": string;
  "startup.settingInactivityTimeout": string;
  "startup.settingAutoResume": string;
  "startup.settingSuffixMin": string;
  "startup.adjustSettings": string;
  "startup.positiveInteger": string;
  "startup.saveChanges": string;
  "startup.issueState": (state: string) => string;
  "startup.issueLabels": (labels: string) => string;
  "startup.proceedWithIssue": string;
  "startup.issueNotConfirmed": string;

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
  "boot.permission": (mode: string) => string;
  "boot.resumingFromStage": (stage: number) => string;

  // ---- stage names -------------------------------------------------------

  "stage.implement": string;
  "stage.selfCheck": string;
  "stage.createPr": string;
  "stage.ciCheck": string;
  "stage.testPlan": string;
  "stage.squash": string;
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
  "pipeline.worktreeCleanedUp": string;
  "pipeline.worktreePreserved": string;

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
  "prompt.noKeepWorktree": string;
  "prompt.ok": string;

  // ---- status bar (StatusBar.tsx) ----------------------------------------

  "statusBar.initialising": string;
  "statusBar.stage": (number: number, name: string) => string;
  "statusBar.loop": (iteration: number) => string;
  "statusBar.last": (outcome: string) => string;

  // ---- input area (InputArea.tsx) ----------------------------------------

  "input.pipelineRunning": string;

  // ---- agent pane (AgentPane.tsx) ----------------------------------------

  "agentPane.tooSmall": string;
  "agentPane.waiting": string;

  // ---- stage-util errors -------------------------------------------------

  "stageError.maxTurns": (context: string) => string;
  "stageError.inactivityTimeout": (context: string) => string;
  "stageError.agentError": (context: string, detail: string) => string;

  // ---- worktree errors ---------------------------------------------------

  "worktree.alreadyExists": (path: string) => string;
  "worktree.haltConflict": string;
}
