import { describe, expect, test } from "vitest";
import { en } from "./en.js";
import { initI18n, t } from "./index.js";
import { ko } from "./ko.js";
import type { Messages } from "./messages.js";

describe("t() before initI18n", () => {
  test("returns English by default", () => {
    expect(t()["stage.done"]).toBe("Done");
  });
});

describe("initI18n", () => {
  test("switches to Korean catalog", async () => {
    await initI18n("ko");
    expect(t()["stage.done"]).toBe("완료");
  });

  test("switches back to English", async () => {
    await initI18n("en");
    expect(t()["stage.done"]).toBe("Done");
  });
});

describe("catalogs are complete", () => {
  const enKeys = Object.keys(en).sort();
  const koKeys = Object.keys(ko).sort();

  test("en and ko have the same keys", () => {
    expect(enKeys).toEqual(koKeys);
  });

  test("all string values are non-empty", () => {
    for (const key of enKeys) {
      const v = en[key as keyof Messages];
      if (typeof v === "string") {
        expect(v, `en["${key}"]`).not.toBe("");
      }
    }
    for (const key of koKeys) {
      const v = ko[key as keyof Messages];
      if (typeof v === "string") {
        expect(v, `ko["${key}"]`).not.toBe("");
      }
    }
  });

  test("all function values return non-empty strings", () => {
    const args: Record<string, unknown[]> = {
      "startup.noRepos": ["owner"],
      "startup.agentModel": ["label"],
      "startup.issueState": ["open"],
      "startup.issueLabels": ["bug"],
      "resume.stage": [1, "Implement"],
      "resume.loopCount": [3],
      "resume.branch": ["main"],
      "resume.pr": [42],
      "resume.reviewRound": [2],
      "resume.mode": ["auto"],
      "resume.agentA": ["sonnet"],
      "resume.agentB": ["sonnet"],
      "boot.worktreeReady": ["/tmp", "branch"],
      "boot.startingPipeline": ["owner", "repo", 1, false],
      "boot.agentA": ["sonnet"],
      "boot.agentB": ["sonnet"],
      "boot.mode": ["auto"],
      "boot.permission": ["auto"],
      "boot.resumingFromStage": [3],
      "pipeline.userSkipped": [1, "Implement"],
      "pipeline.userDeclinedLoop": [2],
      "pipeline.userDeclinedRestartLoop": [2],
      "pipeline.invalidRestartTarget": [9],
      "pipeline.pipelineCompleted": ["owner", "repo", 1],
      "prompt.continueLoop": ["Review", 3],
      "prompt.nextStage": ["Review"],
      "prompt.blocked": ["reason"],
      "prompt.error": ["detail"],
      "prompt.ambiguous": ["response"],
      "statusBar.stage": [1, "Implement"],
      "statusBar.loop": [2],
      "statusBar.last": ["ok"],
      "stageError.maxTurns": [" (stage 1)"],
      "stageError.inactivityTimeout": [" (stage 2)"],
      "stageError.agentError": [" (stage 3)", "timeout"],
      "worktree.alreadyExists": ["/tmp/wt"],
    };

    for (const [key, params] of Object.entries(args)) {
      const enFn = en[key as keyof Messages] as (...a: unknown[]) => string;
      const koFn = ko[key as keyof Messages] as (...a: unknown[]) => string;
      expect(enFn(...params), `en["${key}"]`).not.toBe("");
      expect(koFn(...params), `ko["${key}"]`).not.toBe("");
    }
  });
});
