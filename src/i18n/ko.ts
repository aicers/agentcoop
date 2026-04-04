import type { Messages } from "./messages.js";

export const ko: Messages = {
  // ---- quick-start -------------------------------------------------------

  "quickStart.header": "저장된 설정 발견:",
  "quickStart.agentA": (model) => `  에이전트 A: ${model}`,
  "quickStart.agentB": (model) => `  에이전트 B: ${model}`,
  "quickStart.mode": (exec, perm) => `  모드: ${exec} / ${perm}`,
  "quickStart.language": (lang) => `  언어: ${lang}`,
  "quickStart.usePrevious": "이전 설정을 사용하시겠습니까?",

  // ---- startup / config --------------------------------------------------

  "startup.enterOwner": "GitHub \uC18C\uC720\uC790 \uC785\uB825:",
  "startup.ownerEmpty":
    "\uC18C\uC720\uC790\uB294 \uBE44\uC6CC\uB458 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4",
  "startup.selectOrg": "\uC870\uC9C1 \uC120\uD0DD:",
  "startup.selectRepo":
    "\uC800\uC7A5\uC18C \uC120\uD0DD: (\uD544\uD130\uB97C \uC785\uB825\uD558\uC138\uC694)",
  "startup.noRepos": (owner) =>
    `${owner}\uC5D0 \uB300\uD55C \uC800\uC7A5\uC18C\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4`,
  "startup.issueNumber": "\uC774\uC288 \uBC88\uD638:",
  "startup.invalidIssueNumber":
    "\uC720\uD6A8\uD55C \uC774\uC288 \uBC88\uD638\uB97C \uC785\uB825\uD558\uC138\uC694",
  "startup.agentCli": (label) => `${label} CLI:`,
  "startup.agentModel": (label) => `${label} \uBAA8\uB378:`,
  "startup.agentContext": (label) =>
    `${label} \uCEE8\uD14D\uC2A4\uD2B8 \uC708\uB3C4\uC6B0:`,
  "startup.agentEffort": (label) => `${label} \uB178\uB825 \uC218\uC900:`,
  "startup.executionMode": "\uC2E4\uD589 \uBAA8\uB4DC:",
  "startup.claudePermission": "Claude \uAD8C\uD55C \uBAA8\uB4DC:",
  "startup.language": "\uC5B8\uC5B4:",
  "startup.languageEnglish": "English",
  "startup.languageKorean": "\uD55C\uAD6D\uC5B4",
  "startup.pipelineSettingsHeader":
    "  \uD30C\uC774\uD504\uB77C\uC778 \uC124\uC815 (Enter\uB97C \uB204\uB974\uBA74 \uAE30\uBCF8\uAC12 \uC720\uC9C0):",
  "startup.settingSelfCheck":
    "\uC140\uD504 \uCCB4\uD06C \uC790\uB3D9 \uBC18\uBCF5 \uD69F\uC218",
  "startup.settingReviewRounds":
    "\uB9AC\uBDF0 \uC790\uB3D9 \uBC18\uBCF5 \uD69F\uC218",
  "startup.settingInactivityTimeout":
    "\uBE44\uD65C\uC131 \uC2DC\uAC04 \uCD08\uACFC",
  "startup.settingAutoResume":
    "\uC790\uB3D9 \uC7AC\uAC1C \uC2DC\uB3C4 \uD69F\uC218",
  "startup.settingSuffixMin": "\uBD84",
  "startup.adjustSettings":
    "\uC124\uC815\uC744 \uC870\uC815\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?",
  "startup.positiveInteger":
    "\uC591\uC758 \uC815\uC218\uB97C \uC785\uB825\uD558\uC138\uC694",
  "startup.saveChanges":
    "\uBCC0\uACBD \uC0AC\uD56D\uC744 \uC800\uC7A5\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?",
  "startup.issueState": (state) => `  \uC0C1\uD0DC: ${state}`,
  "startup.issueLabels": (labels) => `  \uB77C\uBCA8: ${labels}`,
  "startup.proceedWithIssue":
    "\uC774 \uC774\uC288\uB85C \uC9C4\uD589\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?",
  "startup.issueNotConfirmed":
    "\uC774\uC288\uAC00 \uD655\uC778\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC911\uB2E8\uD569\uB2C8\uB2E4.",

  // ---- resume / run state ------------------------------------------------

  "resume.savedStateFound":
    "  \uC800\uC7A5\uB41C \uC2E4\uD589 \uC0C1\uD0DC \uBC1C\uACCC:",
  "resume.stage": (stage, name) => `    \uB2E8\uACC4: ${stage} (${name})`,
  "resume.loopCount": (count) => `    \uBC18\uBCF5 \uD69F\uC218: ${count}`,
  "resume.branch": (branch) => `    \uBE0C\uB79C\uCE58: ${branch}`,
  "resume.pr": (prNumber) => `    PR: #${prNumber}`,
  "resume.reviewRound": (round) =>
    `    \uB9AC\uBDF0 \uB77C\uC6B4\uB4DC: ${round}`,
  "resume.mode": (mode) => `    \uBAA8\uB4DC: ${mode}`,
  "resume.agentA": (model) => `    \uC5D0\uC774\uC804\uD2B8 A: ${model}`,
  "resume.agentB": (model) => `    \uC5D0\uC774\uC804\uD2B8 B: ${model}`,
  "resume.resumeOrFresh":
    "\uC7AC\uAC1C \uB610\uB294 \uC0C8\uB85C \uC2DC\uC791?",
  "resume.resume": "\uC7AC\uAC1C",
  "resume.startFresh": "\uC0C8\uB85C \uC2DC\uC791",
  "resume.uncommittedWarning":
    "\uAE30\uC874 \uC6CC\uD06C\uD2B8\uB9AC\uC5D0 \uCEE4\uBC0B\uB418\uC9C0 \uC54A\uC740 \uBCC0\uACBD \uC0AC\uD56D\uC774 \uC788\uC2B5\uB2C8\uB2E4. " +
    "\uC0C8\uB85C \uC2DC\uC791\uD558\uBA74 \uBCC0\uACBD \uC0AC\uD56D\uC774 \uC0AD\uC81C\uB429\uB2C8\uB2E4. \uACC4\uC18D\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?",
  "resume.abortedUncommitted":
    "\uC911\uB2E8: \uCEE4\uBC0B\uB418\uC9C0 \uC54A\uC740 \uBCC0\uACBD \uC0AC\uD56D \uC0AD\uC81C\uB97C \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4.",

  // ---- bootstrap / pipeline start ----------------------------------------

  "boot.requiresTTY":
    "agentcoop\uC740 \uB300\uD654\uD615 \uD130\uBBF8\uB110\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.",
  "boot.bootstrapping": "\uC800\uC7A5\uC18C \uCD08\uAE30\uD654 \uC911...",
  "boot.worktreeReady": (path, branch) =>
    `\uC6CC\uD06C\uD2B8\uB9AC \uC900\uBE44 \uC644\uB8CC: ${path} (\uBE0C\uB79C\uCE58: ${branch})`,
  "boot.uncommittedPreserved":
    "\u26A0 \uAE30\uC874 \uC6CC\uD06C\uD2B8\uB9AC\uC758 \uCEE4\uBC0B\uB418\uC9C0 \uC54A\uC740 \uBCC0\uACBD \uC0AC\uD56D\uC774 \uBCF4\uC874\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
  "boot.prExistsSkip":
    "  PR\uC774 \uC774\uBBF8 \uC874\uC7AC\uD569\uB2C8\uB2E4 \u2014 5\uB2E8\uACC4(CI \uAC80\uC0AC)\uB85C \uAC74\uB108\uB701\uB2C8\uB2E4.",
  "boot.startingPipeline": (owner, repo, issue, resuming) =>
    `${owner}/${repo}#${issue} \uD30C\uC774\uD504\uB77C\uC778 \uC2DC\uC791${resuming ? " (\uC7AC\uAC1C)" : ""}`,
  "boot.agentA": (model) => `  \uC5D0\uC774\uC804\uD2B8 A: ${model}`,
  "boot.agentB": (model) => `  \uC5D0\uC774\uC804\uD2B8 B: ${model}`,
  "boot.mode": (mode) => `  \uBAA8\uB4DC: ${mode}`,
  "boot.permission": (mode) => `  \uAD8C\uD55C: ${mode}`,
  "boot.resumingFromStage": (stage) =>
    `  ${stage}\uB2E8\uACC4\uBD80\uD130 \uC7AC\uAC1C`,

  // ---- stage names -------------------------------------------------------

  "stage.implement": "\uAD6C\uD604",
  "stage.selfCheck": "\uC140\uD504 \uCCB4\uD06C",
  "stage.createPr": "PR \uC0DD\uC131",
  "stage.ciCheck": "CI \uAC80\uC0AC",
  "stage.testPlan": "\uD14C\uC2A4\uD2B8 \uACC4\uD68D \uAC80\uC99D",
  "stage.squash": "\uCEE4\uBC0B \uC2A4\uCFFC\uC2DC",
  "stage.review": "\uB9AC\uBDF0",
  "stage.done": "\uC644\uB8CC",

  // ---- pipeline engine ---------------------------------------------------

  "pipeline.userSkipped": (stage, name) =>
    `\uC0AC\uC6A9\uC790\uAC00 ${stage}\uB2E8\uACC4(${name})\uB97C \uAC74\uB108\uB6F0\uC5C8\uC2B5\uB2C8\uB2E4.`,
  "pipeline.userDeclinedLoop": (iteration) =>
    `\uC0AC\uC6A9\uC790\uAC00 ${iteration}\uBC88\uC9F8 \uBC18\uBCF5\uC5D0\uC11C \uACC4\uC18D\uC744 \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4.`,
  "pipeline.userDeclinedRestartLoop": (iteration) =>
    `\uC0AC\uC6A9\uC790\uAC00 ${iteration}\uBC88\uC9F8 \uC7AC\uC2DC\uC791 \uBC18\uBCF5\uC5D0\uC11C \uACC4\uC18D\uC744 \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4.`,
  "pipeline.invalidRestartTarget": (stage) =>
    `\uC798\uBABB\uB41C \uC7AC\uC2DC\uC791 \uB300\uC0C1: ${stage}\uB2E8\uACC4.`,
  "pipeline.completed":
    "\uD30C\uC774\uD504\uB77C\uC778\uC774 \uC131\uACF5\uC801\uC73C\uB85C \uC644\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
  "pipeline.userHaltedBlocked":
    "\uC0AC\uC6A9\uC790\uAC00 \uCC28\uB2E8\uB41C \uC5D0\uC774\uC804\uD2B8\uC5D0\uC11C \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.",
  "pipeline.userHaltedAmbiguous":
    "\uC0AC\uC6A9\uC790\uAC00 \uBAA8\uD638\uD55C \uC751\uB2F5\uC5D0\uC11C \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.",
  "pipeline.pipelineCompleted": (owner, repo, issue) =>
    `${owner}/${repo}#${issue} \uD30C\uC774\uD504\uB77C\uC778\uC774 \uC644\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`,
  "pipeline.mergeConfirm":
    "PR\uC774 \uBCD1\uD569\uB418\uC5C8\uC2B5\uB2C8\uAE4C? \uD655\uC778\uD558\uBA74 \uC6CC\uD06C\uD2B8\uB9AC\uB97C \uC815\uB9AC\uD569\uB2C8\uB2E4.",
  "pipeline.worktreeCleanedUp":
    "\uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uC815\uB9AC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
  "pipeline.worktreePreserved":
    "\uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uBCF4\uC874\uB418\uC5C8\uC2B5\uB2C8\uB2E4 (\uBCD1\uD569 \uBBF8\uD655\uC778).",

  // ---- TUI user prompts --------------------------------------------------

  "prompt.continueLoop": (stageName, iteration) =>
    `"${stageName}" \uB2E8\uACC4\uAC00 ${iteration}\uD68C \uBC18\uBCF5\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uACC4\uC18D\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?`,
  "prompt.yesContinue": "\uC608, \uACC4\uC18D",
  "prompt.noStop": "\uC544\uB2C8\uC624, \uC911\uB2E8",
  "prompt.nextStage": (stageName) =>
    `"${stageName}" \uB2E8\uACC4\uB85C \uC9C4\uD589\uD560 \uC900\uBE44\uAC00 \uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC9C4\uD589\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?`,
  "prompt.yes": "\uC608",
  "prompt.skip": "\uAC74\uB108\uB6F0\uAE30",
  "prompt.blocked": (message) => `\uCC28\uB2E8\uB428: ${message}`,
  "prompt.proceedAnyway": "\uADF8\uB798\uB3C4 \uC9C4\uD589",
  "prompt.giveInstruction": "\uC9C0\uC2DC \uC785\uB825",
  "prompt.halt": "\uC911\uB2E8",
  "prompt.enterInstruction":
    "\uC9C0\uC2DC\uB97C \uC785\uB825\uD558\uC138\uC694:",
  "prompt.error": (message) => `\uC624\uB958: ${message}`,
  "prompt.retry": "\uC7AC\uC2DC\uB3C4",
  "prompt.abort": "\uC911\uB2E8",
  "prompt.ambiguous": (message) =>
    `\uBAA8\uD638\uD55C \uC5D0\uC774\uC804\uD2B8 \uC751\uB2F5:\n${message}`,
  "prompt.proceed": "\uC9C4\uD589",
  "prompt.yesMerged": "\uC608, \uBCD1\uD569\uB428",
  "prompt.noKeepWorktree":
    "\uC544\uB2C8\uC624, \uC6CC\uD06C\uD2B8\uB9AC \uC720\uC9C0",
  "prompt.ok": "\uD655\uC778",

  // ---- status bar --------------------------------------------------------

  "statusBar.initialising": "\uCD08\uAE30\uD654 \uC911...",
  "statusBar.stage": (number, name) => `${number}\uB2E8\uACC4: ${name}`,
  "statusBar.stageRoundInProgress": (number, name, round) =>
    `${number}\uB2E8\uACC4: ${name} (\uB77C\uC6B4\uB4DC ${round}, \uC9C4\uD589 \uC911)`,
  "statusBar.stageRoundDone": (number, name, round) =>
    `${number}\uB2E8\uACC4: ${name} (\uB77C\uC6B4\uB4DC ${round}, \uC644\uB8CC)`,
  "statusBar.last": (outcome) => `\uC774\uC804: ${outcome}`,
  "statusBar.base": (sha) => `\uAE30\uC900: ${sha}`,
  "statusBar.completed": (selfCheckCount, reviewCount) =>
    `\uC644\uB8CC: \uC140\uD504 \uCCB4\uD06C \u00d7${selfCheckCount}, \uB9AC\uBDF0 \u00d7${reviewCount}`,
  "statusBar.layout": (mode) => `\uB808\uC774\uC544\uC6C3: ${mode}`,
  "statusBar.layoutHorizontal": "\uC218\uD3C9",
  "statusBar.layoutVertical": "\uC218\uC9C1",

  "statusBar.keyHints":
    "Tab:\uD328\uB110 \uC804\uD658  \u2191\u2193:\uC2A4\uD06C\uB864  PgUp/Dn:\uD398\uC774\uC9C0 \uC2A4\uD06C\uB864  Ctrl+C:\uC885\uB8CC",
  "outcome.completed": "완료",
  "outcome.fixed": "수정됨",
  "outcome.approved": "승인됨",
  "outcome.not_approved": "미승인",
  "outcome.blocked": "차단됨",
  "outcome.needs_clarification": "명확화 필요",
  "outcome.error": "오류",

  // ---- token bar ----------------------------------------------------------

  "tokenBar.agentUsage": (label, inputTokens, outputTokens) =>
    `${label}: ${inputTokens} \uC785\uB825 / ${outputTokens} \uCD9C\uB825`,
  "tokenBar.noUsage": "\uD1A0\uD070 \uB370\uC774\uD130 \uC5C6\uC74C",

  // ---- input area --------------------------------------------------------

  "input.pipelineRunning":
    "\uD30C\uC774\uD504\uB77C\uC778 \uC2E4\uD589 \uC911...",

  // ---- agent pane / labels ------------------------------------------------

  "agentPane.tooSmall":
    "(\uD328\uB110\uC774 \uB108\uBB34 \uC791\uC2B5\uB2C8\uB2E4)",
  "agentPane.waiting": "(\uCD9C\uB825 \uB300\uAE30 \uC911)",
  "agentPane.idle":
    "(\uB300\uAE30 \uC911 \u2014 \uB9AC\uBDF0 \uB2E8\uACC4\uC5D0\uC11C \uD65C\uC131\uD654)",
  "agentPane.linesAbove": (count) =>
    `\u2191 ${count}\uC904 \uB354 \uC788\uC74C`,
  "agentPane.linesBelow": (count) =>
    `\u2193 ${count}\uC904 \uB354 \uC788\uC74C`,
  "agent.labelA": "에이전트 A",
  "agent.labelB": "에이전트 B",
  "agent.labelARole": "에이전트 A (작성자)",
  "agent.labelBRole": "에이전트 B (리뷰어)",

  // ---- CI / stage result messages -----------------------------------------

  "ci.pendingTimeout": (seconds) =>
    `CI 검사가 ${seconds}초 후에도 보류 중입니다. ` +
    `CI가 완료될 때까지 파이프라인을 진행할 수 없습니다.`,
  "ci.passed": "CI 검사를 통과했습니다.",
  "ci.stillFailing": (attempts) =>
    `${attempts}회 수정 시도 후에도 CI가 여전히 실패합니다.`,
  "ci.fixLoopExhausted": "CI 수정 반복이 소진되었습니다.",
  "ci.agentError": (detail) => `CI 수정 중 에이전트 오류: ${detail}`,
  "squash.completed": "커밋이 스쿼시되고 CI를 통과했습니다.",
  "squash.singleCommitSkip": "커밋이 하나뿐이므로 스쿼시를 건너뜁니다.",
  "review.approved": (round) => `${round}라운드에서 리뷰가 승인되었습니다.`,
  "review.unresolvedItems": (base, summary) =>
    `${base}\n\n미해결 항목:\n${summary}`,
  "review.fixesApplied": (round) =>
    `${round}라운드 수정 적용 완료, CI 통과. 다음 리뷰 라운드로 진행합니다.`,

  // ---- stage-util errors -------------------------------------------------

  "stageError.maxTurns": (context) =>
    `\uC5D0\uC774\uC804\uD2B8\uAC00 \uCD5C\uB300 \uD134 \uC218\uC5D0 \uB3C4\uB2EC\uD588\uC2B5\uB2C8\uB2E4${context}.`,
  "stageError.inactivityTimeout": (context) =>
    `\uBE44\uD65C\uC131\uC73C\uB85C \uC778\uD574 \uC5D0\uC774\uC804\uD2B8 \uD504\uB85C\uC138\uC2A4\uAC00 \uC2DC\uAC04 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4${context}.`,
  "stageError.configParsing": (context, detail) =>
    `\uC5D0\uC774\uC804\uD2B8 CLI\uAC00 \uC124\uC815\uC744 \uAC70\uBD80\uD588\uC2B5\uB2C8\uB2E4${context}. ` +
    `~/.codex/config.toml\uC5D0\uC11C \uC9C0\uC6D0\uB418\uC9C0 \uC54A\uB294 \uAC12\uC744 \uD655\uC778\uD558\uC138\uC694: ${detail}`,
  "stageError.agentError": (context, detail) =>
    `\uC5D0\uC774\uC804\uD2B8 \uC624\uB958${context}: ${detail}`,

  // ---- issue sync ---------------------------------------------------------

  "issueSync.summaryHeader": (issueNumber) => `\uC774\uC288 #${issueNumber}:`,
  "issueSync.summaryMinor": (description) =>
    `  - \uC5C5\uB370\uC774\uD2B8 (\uC18C\uADDC\uBAA8): ${description}`,
  "issueSync.summaryMajor": (description) =>
    `  - \uCF54\uBA58\uD2B8 \uCD94\uAC00 (\uB300\uADDC\uBAA8): ${description}`,
  "issueSync.summaryNoChanges": "  - \uBCC0\uACBD \uC5C6\uC74C",
  "issueSync.summarySkipped": "  - \uB3D9\uAE30\uD654 \uAC74\uB108\uB6F0",
  "issueSync.summaryFailed": "  - \uB3D9\uAE30\uD654 \uC2E4\uD328",

  // ---- worktree errors ---------------------------------------------------

  "worktree.alreadyExists": (path) =>
    `${path}\uC5D0 \uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uC774\uBBF8 \uC874\uC7AC\uD569\uB2C8\uB2E4. ` +
    "conflictChoice\uB97C \uC81C\uACF5\uD558\uC138\uC694 (reuse | clean | halt).",
  "worktree.haltConflict":
    "\uC0AC\uC6A9\uC790\uAC00 \uC911\uB2E8\uC744 \uC120\uD0DD\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uC6CC\uD06C\uD2B8\uB9AC \uCDA9\uB3CC \uBBF8\uD574\uACB0.",
};
