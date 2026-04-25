import type { Messages } from "./messages.js";

export const ko: Messages = {
  // ---- quick-start -------------------------------------------------------

  "quickStart.header": "저장된 설정 발견:",
  "quickStart.agentA": (model) => `  에이전트 A (작성자): ${model}`,
  "quickStart.agentB": (model) => `  에이전트 B (리뷰어): ${model}`,
  "quickStart.mode": (exec) => `  모드: ${exec}`,
  "quickStart.language": (lang) => `  언어: ${lang}`,
  "quickStart.pipelineSettings": "  파이프라인 설정:",
  "quickStart.notifications": "  \uC54C\uB9BC:",
  "quickStart.usePrevious":
    "\uC774\uC804 \uC124\uC815\uC744 \uC0AC\uC6A9\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?",

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
  "startup.settingCiCheckIterations":
    "CI \uAC80\uC0AC \uC790\uB3D9 \uBC18\uBCF5 \uD69F\uC218",
  "startup.settingCiCheckTimeout": "CI \uAC80\uC0AC \uC2DC\uAC04 \uCD08\uACFC",
  "startup.settingAutoResume":
    "\uC790\uB3D9 \uC7AC\uAC1C \uC2DC\uB3C4 \uD69F\uC218",
  "startup.settingSuffixMin": "\uBD84",
  "startup.adjustSettings":
    "\uC124\uC815\uC744 \uC870\uC815\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?",
  "startup.positiveInteger":
    "\uC591\uC758 \uC815\uC218\uB97C \uC785\uB825\uD558\uC138\uC694",
  "startup.notificationBell": "\uD130\uBBF8\uB110 \uBCA8",
  "startup.notificationDesktop": "\uB370\uC2A4\uD06C\uD1B1 \uC54C\uB9BC",
  "startup.notificationSettings": "\uC54C\uB9BC \uC124\uC815:",
  "startup.saveChanges":
    "\uBCC0\uACBD \uC0AC\uD56D\uC744 \uC800\uC7A5\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?",
  "startup.issueState": (state) => `  \uC0C1\uD0DC: ${state}`,
  "startup.issueLabels": (labels) => `  \uB77C\uBCA8: ${labels}`,
  "startup.proceedWithIssue":
    "\uC774 \uC774\uC288\uB85C \uC9C4\uD589\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?",
  "startup.issueNotConfirmed":
    "\uC774\uC288\uAC00 \uD655\uC778\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uC911\uB2E8\uD569\uB2C8\uB2E4.",
  "startup.squashApplyPolicyPrompt":
    "단일 커밋 스쿼시가 제안될 때, 에이전트가 자동으로 적용할까요? " +
    "(아니오 = 매번 묻기)",

  // ---- custom model entry --------------------------------------------------

  "startup.customModelOption":
    "\uC0AC\uC6A9\uC790 \uC815\uC758 \uBAA8\uB378 \uC785\uB825...",
  "startup.customModelValue":
    "\uBAA8\uB378 \uC2DD\uBCC4\uC790 (--model\uC5D0 \uC804\uB2EC\uB428):",
  "startup.customModelName":
    "\uD45C\uC2DC \uC774\uB984 (\uBE44\uC6CC\uB450\uBA74 \uC2DD\uBCC4\uC790 \uC0AC\uC6A9):",
  "startup.customModelInvalidClaude":
    "\uD615\uC2DD: opus, sonnet, haiku \uB610\uB294 claude-<\uC774\uB984> (\uC18C\uBB38\uC790 \uC601\uC22B\uC790 \uBC0F \uD558\uC774\uD508)",
  "startup.customModelInvalidCodex":
    "\uD615\uC2DD: gpt-<\uC774\uB984> \uB610\uB294 o<\uC22B\uC790>[-<\uC774\uB984>] (\uC18C\uBB38\uC790 \uC601\uC22B\uC790, \uD558\uC774\uD508, \uC810)",
  "startup.customModelDuplicate": (name) =>
    `\uC774\uBBF8 "${name}"(\uC73C)\uB85C \uC874\uC7AC\uD569\uB2C8\uB2E4`,

  // ---- custom model management -----------------------------------------------

  "startup.manageCustomModelsOption":
    "\uC0AC\uC6A9\uC790 \uC815\uC758 \uBAA8\uB378 \uAD00\uB9AC...",
  "startup.manageCustomModelsList":
    "\uC0AC\uC6A9\uC790 \uC815\uC758 \uBAA8\uB378:",
  "startup.manageCustomModelsAction": (name) => `${name}:`,
  "startup.manageCustomModelsEdit": "\uD3B8\uC9D1",
  "startup.manageCustomModelsRemove": "\uC0AD\uC81C",
  "startup.manageCustomModelsBack": "\uB4A4\uB85C",
  "startup.manageCustomModelsConfirmRemove": (name) =>
    `"${name}"\uC744(\uB97C) \uC0AD\uC81C\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?`,

  // ---- model registry ------------------------------------------------------

  "models.loadFailed": (detail) =>
    `\uBAA8\uB378 \uC815\uC758 \uB85C\uB4DC \uC2E4\uD328: ${detail}`,

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
  "resume.agentA": (model) =>
    `    \uC5D0\uC774\uC804\uD2B8 A (\uC791\uC131\uC790): ${model}`,
  "resume.agentB": (model) =>
    `    \uC5D0\uC774\uC804\uD2B8 B (\uB9AC\uBDF0\uC5B4): ${model}`,
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
  "boot.agentA": (model) =>
    `  \uC5D0\uC774\uC804\uD2B8 A (\uC791\uC131\uC790): ${model}`,
  "boot.agentB": (model) =>
    `  \uC5D0\uC774\uC804\uD2B8 B (\uB9AC\uBDF0\uC5B4): ${model}`,
  "boot.mode": (mode) => `  \uBAA8\uB4DC: ${mode}`,
  "boot.resumingFromStage": (stage) =>
    `  ${stage}\uB2E8\uACC4\uBD80\uD130 \uC7AC\uAC1C`,

  // ---- stage names -------------------------------------------------------

  "stage.bootstrap": "\uBD80\uD2B8\uC2A4\uD2B8\uB7A9",
  "stage.implement": "\uAD6C\uD604",
  "stage.selfCheck": "\uC140\uD504 \uCCB4\uD06C",
  "stage.createPr": "PR \uC0DD\uC131",
  "stage.ciCheck": "CI \uAC80\uC0AC",
  "stage.testPlan": "\uD14C\uC2A4\uD2B8 \uACC4\uD68D \uAC80\uC99D",
  "stage.squash": "\uCEE4\uBC0B \uC2A4\uCFFC\uC2DC",
  "stage.rebase": "\uB9AC\uBCA0\uC774\uC2A4",
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
    "PR이 병합되었습니까? 확인하면 워크트리를 정리합니다.",
  "pipeline.mergeConfirmSquashTip":
    "이 저장소가 'Squash and merge'를 허용한다면, 제안된 커밋 메시지가 PR 코멘트에 있습니다.",
  "pipeline.suggestedSquashTitle": "제안 제목:",
  "pipeline.suggestedSquashBody": "제안 본문:",
  "pipeline.suggestedSquashBodyLines": (lines) => `${lines}줄`,
  "pipeline.suggestedSquashBodyCopyHint":
    "단축키로 복사하거나 PR 코멘트에서 확인",
  "pipeline.suggestedSquashBodyViewInPr": "PR 코멘트에서 확인",
  "pipeline.prUrl": (url) => `PR: ${url}`,
  "pipeline.worktreeCleanedUp": "워크트리가 정리되었습니다.",
  "pipeline.worktreePreserved": "워크트리가 보존되었습니다 (병합 미확인).",
  "pipeline.conflictsDetected":
    "파이프라인이 완료되었지만 main과 병합 충돌이 감지되었습니다.",
  "pipeline.unknownMergeable": "재시도 후에도 병합 상태를 확인할 수 없습니다.",
  "pipeline.noConflicts": "충돌이 없습니다 — main과 이미 최신 상태입니다.",
  "pipeline.rebaseFailed":
    "에이전트가 충돌을 해결하지 못했습니다. 수동으로 해결해 주세요.",
  "pipeline.rebaseAgentError": (detail) =>
    `리베이스 에이전트 오류: ${detail}\n` +
    "수동으로 충돌을 해결하거나 리베이스를 다시 시도해 주세요.",
  "pipeline.rebaseBlocked": (detail) =>
    `에이전트가 리베이스를 차단된 상태로 보고했습니다:\n${detail}\n` +
    "수동으로 충돌을 해결해 주세요.",
  "pipeline.rebaseAlreadyAttempted":
    "에이전트 리베이스가 이미 시도되었습니다. 수동으로 충돌을 해결해 주세요.",
  "pipeline.prAlreadyMerged":
    "PR이 이미 병합되었습니다. 워크트리를 정리합니다.",

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
  "prompt.yesMerged": "예, 병합됨",
  "prompt.checkConflictsRebase": "아니오, 충돌 확인 및 리베이스",
  "prompt.noExit": "아니오, 종료",
  "prompt.agentRebase": "에이전트 리베이스",
  "prompt.manualResolve": "수동 해결",
  "prompt.recheck": "재확인",
  "prompt.exit": "종료",
  "prompt.pressAnyKeyWhenDone": "완료되면 Enter를 누르세요.",

  // ---- status bar --------------------------------------------------------

  "statusBar.initialising": "\uCD08\uAE30\uD654 \uC911...",
  "statusBar.stage": (number, name) => `${number}\uB2E8\uACC4: ${name}`,
  "statusBar.stageRound": (number, name, round) =>
    `${number}\uB2E8\uACC4: ${name} (\uB77C\uC6B4\uB4DC ${round})`,
  "statusBar.bootstrapTransition": (fromNum, fromName, toNum, toName) =>
    `${fromNum}\uB2E8\uACC4: ${fromName} \u2192 ${toNum}\uB2E8\uACC4: ${toName}`,
  "statusBar.last": (outcome) => `\uC774\uC804: ${outcome}`,
  "statusBar.base": (sha) => `\uAE30\uC900: ${sha}`,
  "statusBar.pr": (prNumber) => `PR: #${prNumber}`,
  "statusBar.completed": (selfCheckCount, reviewCount) =>
    `\uC644\uB8CC: \uC140\uD504 \uCCB4\uD06C \u00d7${selfCheckCount}, \uB9AC\uBDF0 \u00d7${reviewCount}`,
  "statusBar.layout": (mode) => `\uB808\uC774\uC544\uC6C3: ${mode}`,
  "statusBar.layoutHorizontal": "\uC218\uD3C9",
  "statusBar.layoutVertical": "\uC218\uC9C1",

  "statusBar.keyHints":
    "\u25CF:\uD65C\uC131  [*]:\uD3EC\uCEE4\uC2A4  Tab:\uD328\uB110 \uC804\uD658  \u2191\u2193:\uC2A4\uD06C\uB864  PgUp/Dn:\uD398\uC774\uC9C0 \uC2A4\uD06C\uB864  Ctrl+L:\uB808\uC774\uC544\uC6C3  Ctrl+C:\uC885\uB8CC",
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
  "tokenBar.agentUsageCached": (
    label,
    inputTokens,
    cachedTokens,
    outputTokens,
  ) =>
    `${label}: ${inputTokens} \uC785\uB825 (${cachedTokens} \uCE90\uC2DC) / ${outputTokens} \uCD9C\uB825`,
  "tokenBar.noUsage": "\uD1A0\uD070 \uB370\uC774\uD130 \uC5C6\uC74C",

  // ---- input area --------------------------------------------------------

  "input.pipelineRunning":
    "\uD30C\uC774\uD504\uB77C\uC778 \uC2E4\uD589 \uC911...",
  "input.copy": "복사",
  "input.copied": "복사됨",
  "input.copyFailed": "복사 실패",
  "input.truncated": "…(잘림)",

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
  "agent.labelShortA": "A",
  "agent.labelShortB": "B",
  "agent.labelARole": "에이전트 A (작성자)",
  "agent.labelBRole": "에이전트 B (리뷰어)",

  // ---- CI / stage result messages -----------------------------------------

  "ci.pendingTimeout": (seconds) =>
    `CI 검사가 ${seconds}초 후에도 보류 중입니다. ` +
    `CI가 완료될 때까지 파이프라인을 진행할 수 없습니다.`,
  "ci.passed": "CI 검사를 통과했습니다.",
  "ci.passedWithFindings":
    "CI 검사를 통과했습니다. 에이전트가 발견 사항을 검토했습니다.",
  "ci.stillFailing": (attempts) =>
    `${attempts}회 수정 시도 후에도 CI가 여전히 실패합니다.`,
  "ci.retryPrompt": (attempts) =>
    `${attempts}회 수정 시도 후에도 CI가 여전히 실패합니다. 계속 시도할까요?`,
  "ci.agentError": (detail) => `CI 수정 중 에이전트 오류: ${detail}`,
  "squash.completed": "커밋이 스쿼시되고 CI를 통과했습니다.",
  "squash.singleCommitSkip": "커밋이 하나뿐이므로 스쿼시를 건너뜁니다.",
  "squash.messageAppended":
    "제안된 스쿼시 커밋 메시지가 PR 코멘트로 게시되었습니다. " +
    "병합 시 GitHub의 'Squash and merge'로 적용하세요.",
  "squash.singleChoicePrompt":
    "단일 스쿼시 커밋이 적합해 보입니다. 제안 메시지를 어떻게 적용할까요?",
  "squash.singleChoiceAgent": "에이전트가 지금 스쿼시 (강제 푸시, CI 재실행)",
  "squash.singleChoiceGithub":
    "병합 시 GitHub 'Squash and merge'로 적용 (CI 재실행 없음)",
  "squash.agentChoiceMissingSession":
    "스쿼시를 수행할 수 없습니다: 대화를 이어갈 에이전트 세션이 유실되었습니다. " +
    "스테이지 8을 다시 실행하거나, 병합 시 GitHub의 'Squash and merge'로 " +
    "제안을 적용하세요.",
  "squash.alreadyMerged": "PR이 이미 병합되었습니다. 스쿼시를 건너뜁니다.",
  "review.approved": (round) => `${round}라운드에서 리뷰가 승인되었습니다.`,
  "review.unresolvedItems": (base, summary) =>
    `${base}\n\n미해결 항목:\n${summary}`,
  "review.fixesApplied": (round) =>
    `${round}라운드 수정 적용 완료, CI 통과. 다음 리뷰 라운드로 진행합니다.`,
  "review.finalizationUnverified": (issueNumber) =>
    `PR 마무리 판정이 모호하고 PR 본문에 이슈 #${issueNumber} 참조가 없습니다. 수동 확인이 필요합니다.`,
  "review.missingAuthorComment": (round) =>
    `PR에서 [Author Round ${round}] 코멘트를 찾을 수 없습니다. 리뷰를 진행할 수 없습니다.`,
  "review.missingReviewerComment": (round) =>
    `PR에서 [Reviewer Round ${round}] 코멘트를 찾을 수 없습니다. 작성자 수정을 진행할 수 없습니다.`,

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

  // ---- cancellation / cleanup --------------------------------------------

  "pipeline.cancelled":
    "\uD30C\uC774\uD504\uB77C\uC778\uC774 \uCDE8\uC18C\uB418\uC5C8\uC2B5\uB2C8\uB2E4.",
  "pipeline.cancelledSaved":
    "\uC2E4\uD589 \uC0C1\uD0DC\uAC00 \uC800\uC7A5\uB418\uC5C8\uC2B5\uB2C8\uB2E4 \u2014 \uB098\uC911\uC5D0 \uC7AC\uAC1C\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.",
  "cleanup.header": "\uC815\uB9AC \uC635\uC158:",
  "cleanup.stopDockerCompose":
    "Docker Compose \uC11C\uBE44\uC2A4\uAC00 \uC2E4\uD589 \uC911\uC785\uB2C8\uB2E4. \uC911\uC9C0\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?",
  "cleanup.deleteWorktree":
    "\uB85C\uCEEC \uC6CC\uD06C\uD2B8\uB9AC\uC640 \uBE0C\uB79C\uCE58\uB97C \uC0AD\uC81C\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?",
  "cleanup.deleteRemoteBranch": (branch) =>
    `\uC6D0\uACA9 \uBE0C\uB79C\uCE58 "${branch}"\uB97C \uC0AD\uC81C\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?`,
  "cleanup.closePr": (prNumber) =>
    `PR #${prNumber}\uC744(\uB97C) \uB2EB\uC73C\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?`,
  "cleanup.stoppingServices":
    "  Docker Compose \uC11C\uBE44\uC2A4 \uC911\uC9C0 \uC911...",
  "cleanup.deletingWorktree":
    "  \uB85C\uCEEC \uC6CC\uD06C\uD2B8\uB9AC \uBC0F \uBE0C\uB79C\uCE58 \uC0AD\uC81C \uC911...",
  "cleanup.deletingRemoteBranch":
    "  \uC6D0\uACA9 \uBE0C\uB79C\uCE58 \uC0AD\uC81C \uC911...",
  "cleanup.closingPr": "  PR \uB2EB\uB294 \uC911...",
  "cleanup.done": "정리 완료.",
  "cleanup.forceQuitWarning":
    "정리가 진행 중입니다. 강제 종료하려면 Ctrl+C를 다시 누르세요.",
  "prompt.yesCleanup": "\uC608",
  "prompt.noSkipCleanup": "\uC544\uB2C8\uC624",

  // ---- worktree errors ---------------------------------------------------

  // ---- notifications -------------------------------------------------------

  "notification.title": "agentcoop",

  // ---- version check -----------------------------------------------------

  "versionCheck.checking": "CLI 버전 확인 중...",
  "versionCheck.inconclusive": (cli, reason) =>
    `  ${cli}: 업데이트 검사 건너뜀 (${reason})`,
  "versionCheck.fetchFailed": (cli, reason) =>
    `  ${cli}: 최신 버전을 가져올 수 없습니다 (${reason})`,
  "versionCheck.upToDate": (cli, version) =>
    `  ${cli} v${version} 최신 버전입니다.`,
  "versionCheck.updatePrompt": (cli, from, to) =>
    `${cli}의 새 버전이 있습니다 (v${from} → v${to}). 지금 업데이트하시겠습니까?`,
  "versionCheck.updateWaiting": (cli) =>
    `${cli}를 업데이트한 후 Enter 키를 눌러 계속 진행하세요.`,
  "versionCheck.versionUnchanged": (version) =>
    `버전이 여전히 v${version}입니다.`,
  "versionCheck.retrySkipAbortPrompt": "어떻게 진행하시겠습니까?",
  "versionCheck.proceedingWith": (cli, version) =>
    `  ${cli}가 v${version}로 업데이트되었습니다. 계속 진행합니다.`,
  "versionCheck.abortedByUser": "사용자에 의해 업데이트 검사가 중단되었습니다.",
  "versionCheck.versionUnknown": (cli) =>
    `  ${cli} 버전을 확인할 수 없어 업데이트 검사를 건너뜁니다.`,
  "versionCheck.retry": "재시도",
  "versionCheck.skip": "건너뛰기 (현재 버전 사용)",
  "versionCheck.abort": "중단",

  // ---- worktree errors ---------------------------------------------------

  "worktree.alreadyExists": (path) =>
    `${path}\uC5D0 \uC6CC\uD06C\uD2B8\uB9AC\uAC00 \uC774\uBBF8 \uC874\uC7AC\uD569\uB2C8\uB2E4. ` +
    "conflictChoice\uB97C \uC81C\uACF5\uD558\uC138\uC694 (reuse | clean | halt).",
  "worktree.haltConflict":
    "\uC0AC\uC6A9\uC790\uAC00 \uC911\uB2E8\uC744 \uC120\uD0DD\uD588\uC2B5\uB2C8\uB2E4 \u2014 \uC6CC\uD06C\uD2B8\uB9AC \uCDA9\uB3CC \uBBF8\uD574\uACB0.",
};
