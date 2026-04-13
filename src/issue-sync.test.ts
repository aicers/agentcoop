import { beforeAll, describe, expect, test } from "vitest";
import { initI18n } from "./i18n/index.js";
import {
  buildIssueSyncClarificationPrompt,
  buildIssueSyncPrompt,
  buildIssueSyncVerdictPrompt,
  buildPrSyncInstructions,
  formatIssueSyncSummary,
  parseIssueSyncResponse,
} from "./issue-sync.js";
import type { StageContext } from "./pipeline.js";

beforeAll(async () => {
  await initI18n("en");
});

const BASE_CTX: StageContext = {
  owner: "org",
  repo: "repo",
  issueNumber: 42,
  branch: "issue-42",
  worktreePath: "/tmp/wt",
  iteration: 0,
  lastAutoIteration: false,
  userInstruction: undefined,
};

// ---- buildIssueSyncPrompt ------------------------------------------------

describe("buildIssueSyncPrompt", () => {
  const opts = {
    issueTitle: "Fix the widget",
    issueBody: "The widget is broken.",
  };

  test("includes issue context", () => {
    const prompt = buildIssueSyncPrompt(BASE_CTX, opts);
    expect(prompt).toContain("Issue #42: Fix the widget");
    expect(prompt).toContain("The widget is broken.");
  });

  test("includes gh issue edit command with correct repo", () => {
    const prompt = buildIssueSyncPrompt(BASE_CTX, opts);
    expect(prompt).toContain("gh issue edit 42 --repo org/repo");
  });

  test("includes gh issue comment command with correct repo", () => {
    const prompt = buildIssueSyncPrompt(BASE_CTX, opts);
    expect(prompt).toContain("gh issue comment 42 --repo org/repo");
  });

  test("does not include response-format keywords (moved to verdict prompt)", () => {
    const prompt = buildIssueSyncPrompt(BASE_CTX, opts);
    expect(prompt).not.toContain("ISSUE_NO_CHANGES");
    expect(prompt).not.toContain("ISSUE_UPDATED");
    expect(prompt).not.toContain("ISSUE_COMMENTED");
  });

  test("distinguishes minor and major discrepancies", () => {
    const prompt = buildIssueSyncPrompt(BASE_CTX, opts);
    expect(prompt).toContain("minor discrepancies");
    expect(prompt).toContain("major discrepancies");
  });
});

// ---- buildIssueSyncVerdictPrompt -----------------------------------------

describe("buildIssueSyncVerdictPrompt", () => {
  test("mentions ISSUE_NO_CHANGES keyword", () => {
    const prompt = buildIssueSyncVerdictPrompt();
    expect(prompt).toContain("ISSUE_NO_CHANGES");
  });

  test("mentions ISSUE_UPDATED and ISSUE_COMMENTED keywords", () => {
    const prompt = buildIssueSyncVerdictPrompt();
    expect(prompt).toContain("ISSUE_UPDATED");
    expect(prompt).toContain("ISSUE_COMMENTED");
  });

  test("asks for no other commentary", () => {
    const prompt = buildIssueSyncVerdictPrompt();
    expect(prompt).toContain("Do not include any other commentary");
  });
});

// ---- parseIssueSyncResponse ----------------------------------------------

describe("parseIssueSyncResponse", () => {
  test("returns valid with no changes for ISSUE_NO_CHANGES", () => {
    const result = parseIssueSyncResponse("ISSUE_NO_CHANGES");
    expect(result).toEqual({ changes: [], valid: true });
  });

  test("parses a single ISSUE_UPDATED line", () => {
    const result = parseIssueSyncResponse("ISSUE_UPDATED: corrected file path");
    expect(result).toEqual({
      changes: [{ type: "minor", description: "corrected file path" }],
      valid: true,
    });
  });

  test("parses a single ISSUE_COMMENTED line", () => {
    const result = parseIssueSyncResponse(
      "ISSUE_COMMENTED: uses WebSocket instead of polling",
    );
    expect(result).toEqual({
      changes: [
        { type: "major", description: "uses WebSocket instead of polling" },
      ],
      valid: true,
    });
  });

  test("parses both ISSUE_UPDATED and ISSUE_COMMENTED", () => {
    const text = [
      "ISSUE_UPDATED: fixed typo in description",
      "ISSUE_COMMENTED: scope expanded to include API changes",
    ].join("\n");
    const result = parseIssueSyncResponse(text);
    expect(result).toEqual({
      changes: [
        { type: "minor", description: "fixed typo in description" },
        { type: "major", description: "scope expanded to include API changes" },
      ],
      valid: true,
    });
  });

  test("rejects unrecognised response as invalid", () => {
    const result = parseIssueSyncResponse(
      "I looked at the issue and it seems fine.",
    );
    expect(result).toEqual({ changes: [], valid: false });
  });

  test("rejects response with extra commentary before keywords", () => {
    const result = parseIssueSyncResponse(
      "Everything matches.\n\nISSUE_NO_CHANGES",
    );
    expect(result).toEqual({ changes: [], valid: false });
  });

  test("rejects ISSUE_UPDATED without colon as invalid", () => {
    const result = parseIssueSyncResponse("ISSUE_UPDATED fixed title");
    expect(result).toEqual({ changes: [], valid: false });
  });

  test("rejects mixed commentary and keywords", () => {
    const text = [
      "Made some changes.",
      "ISSUE_UPDATED: fixed typo in description",
    ].join("\n");
    const result = parseIssueSyncResponse(text);
    expect(result).toEqual({ changes: [], valid: false });
  });

  test("is case-insensitive", () => {
    const result = parseIssueSyncResponse("issue_updated: fixed path");
    expect(result).toEqual({
      changes: [{ type: "minor", description: "fixed path" }],
      valid: true,
    });
  });

  test("trims description whitespace", () => {
    const result = parseIssueSyncResponse("ISSUE_UPDATED:   extra spaces  ");
    expect(result).toEqual({
      changes: [{ type: "minor", description: "extra spaces" }],
      valid: true,
    });
  });

  test("handles multiple ISSUE_UPDATED lines", () => {
    const text = [
      "ISSUE_UPDATED: fixed path in step 1",
      "ISSUE_UPDATED: clarified wording in step 3",
    ].join("\n");
    const result = parseIssueSyncResponse(text);
    expect(result.valid).toBe(true);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0].type).toBe("minor");
    expect(result.changes[1].type).toBe("minor");
  });

  test("allows blank lines between keywords", () => {
    const text = "ISSUE_UPDATED: fixed path\n\nISSUE_COMMENTED: scope changed";
    const result = parseIssueSyncResponse(text);
    expect(result.valid).toBe(true);
    expect(result.changes).toHaveLength(2);
  });

  test("strips optional leading bullet markers", () => {
    const text = "- ISSUE_UPDATED: fixed path";
    const result = parseIssueSyncResponse(text);
    expect(result).toEqual({
      changes: [{ type: "minor", description: "fixed path" }],
      valid: true,
    });
  });

  test("returns invalid for empty response", () => {
    const result = parseIssueSyncResponse("");
    expect(result).toEqual({ changes: [], valid: false });
  });

  test("rejects ISSUE_NO_CHANGES mixed with ISSUE_UPDATED", () => {
    const text = "ISSUE_NO_CHANGES\nISSUE_UPDATED: fixed typo";
    const result = parseIssueSyncResponse(text);
    expect(result).toEqual({ changes: [], valid: false });
  });

  test("rejects ISSUE_NO_CHANGES mixed with ISSUE_COMMENTED", () => {
    const text = "ISSUE_COMMENTED: scope changed\nISSUE_NO_CHANGES";
    const result = parseIssueSyncResponse(text);
    expect(result).toEqual({ changes: [], valid: false });
  });
});

// ---- buildIssueSyncClarificationPrompt ------------------------------------

describe("buildIssueSyncClarificationPrompt", () => {
  test("mentions all three keyword patterns", () => {
    const prompt = buildIssueSyncClarificationPrompt();
    expect(prompt).toContain("ISSUE_NO_CHANGES");
    expect(prompt).toContain("ISSUE_UPDATED");
    expect(prompt).toContain("ISSUE_COMMENTED");
  });

  test("asks for no other commentary", () => {
    const prompt = buildIssueSyncClarificationPrompt();
    expect(prompt).toContain("Do not include any other commentary");
  });

  test("mentions the previous response was malformed", () => {
    const prompt = buildIssueSyncClarificationPrompt();
    expect(prompt).toContain("did not follow the expected format");
  });
});

// ---- buildPrSyncInstructions ---------------------------------------------

describe("buildPrSyncInstructions", () => {
  test("mentions gh pr view", () => {
    const text = buildPrSyncInstructions(42);
    expect(text).toContain("gh pr view");
  });

  test("mentions gh pr edit", () => {
    const text = buildPrSyncInstructions(42);
    expect(text).toContain("gh pr edit");
  });

  test("includes issue number in references", () => {
    const text = buildPrSyncInstructions(99);
    expect(text).toContain("Closes #99");
    expect(text).toContain("Part of #99");
  });
});

// ---- formatIssueSyncSummary ----------------------------------------------

describe("formatIssueSyncSummary", () => {
  test("prints no-change line when there are no changes", () => {
    const lines = formatIssueSyncSummary(42, []);
    expect(lines).toEqual(["Issue #42:", "  - No changes"]);
  });

  test("prints minor change", () => {
    const lines = formatIssueSyncSummary(42, [
      { type: "minor", description: "corrected file path" },
    ]);
    expect(lines).toEqual([
      "Issue #42:",
      "  - Updated (minor): corrected file path",
    ]);
  });

  test("prints major change", () => {
    const lines = formatIssueSyncSummary(42, [
      { type: "major", description: "uses WebSocket instead of polling" },
    ]);
    expect(lines).toEqual([
      "Issue #42:",
      "  - Comment added (major): uses WebSocket instead of polling",
    ]);
  });

  test("prints mixed minor and major changes", () => {
    const lines = formatIssueSyncSummary(7, [
      { type: "minor", description: "fixed typo" },
      { type: "major", description: "scope expanded" },
    ]);
    expect(lines).toEqual([
      "Issue #7:",
      "  - Updated (minor): fixed typo",
      "  - Comment added (major): scope expanded",
    ]);
  });

  test("prints sync skipped when status is skipped", () => {
    const lines = formatIssueSyncSummary(42, [], "skipped");
    expect(lines).toEqual(["Issue #42:", "  - Sync skipped"]);
  });

  test("prints sync failed when status is failed", () => {
    const lines = formatIssueSyncSummary(42, [], "failed");
    expect(lines).toEqual(["Issue #42:", "  - Sync failed"]);
  });

  test("ignores changes array when status is skipped", () => {
    const lines = formatIssueSyncSummary(
      42,
      [{ type: "minor", description: "should be ignored" }],
      "skipped",
    );
    expect(lines).toEqual(["Issue #42:", "  - Sync skipped"]);
  });
});
