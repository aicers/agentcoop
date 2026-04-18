import { describe, expect, test } from "vitest";
import {
  buildClarificationPrompt,
  parseStepStatus,
  parseVerdictKeyword,
} from "./step-parser.js";

// ---------------------------------------------------------------------------
// parseStepStatus
// ---------------------------------------------------------------------------
describe("parseStepStatus", () => {
  // -- recognised keywords --------------------------------------------------
  test("detects COMPLETED", () => {
    const r = parseStepStatus("All tasks are done. COMPLETED");
    expect(r).toEqual({ status: "completed", keyword: "COMPLETED" });
  });

  test("detects BLOCKED", () => {
    const r = parseStepStatus("Cannot proceed — BLOCKED");
    expect(r).toEqual({ status: "blocked", keyword: "BLOCKED" });
  });

  test("detects FIXED", () => {
    const r = parseStepStatus("The issue has been FIXED");
    expect(r).toEqual({ status: "fixed", keyword: "FIXED" });
  });

  test("detects DONE", () => {
    const r = parseStepStatus("Everything is DONE");
    expect(r).toEqual({ status: "fixed", keyword: "DONE" });
  });

  test("detects APPROVED", () => {
    const r = parseStepStatus("Review passed. APPROVED");
    expect(r).toEqual({ status: "approved", keyword: "APPROVED" });
  });

  test("detects NOT_APPROVED", () => {
    const r = parseStepStatus("Changes required. NOT_APPROVED");
    expect(r).toEqual({ status: "not_approved", keyword: "NOT_APPROVED" });
  });

  // -- case insensitivity ---------------------------------------------------
  test("matches keywords case-insensitively", () => {
    const r = parseStepStatus("completed");
    expect(r.status).toBe("completed");
  });

  test("matches mixed case", () => {
    const r = parseStepStatus("Completed");
    expect(r.status).toBe("completed");
  });

  // -- last occurrence wins -------------------------------------------------
  test("returns the last keyword when multiple are present", () => {
    const r = parseStepStatus("BLOCKED at first, but then COMPLETED");
    expect(r).toEqual({ status: "completed", keyword: "COMPLETED" });
  });

  test("BLOCKED after COMPLETED returns blocked", () => {
    const r = parseStepStatus("COMPLETED initially, but now BLOCKED");
    expect(r).toEqual({ status: "blocked", keyword: "BLOCKED" });
  });

  // -- word boundary --------------------------------------------------------
  test("does not match keyword embedded in another word", () => {
    const r = parseStepStatus("I am done with the uncompleted tasks");
    // "DONE" should match as a word, but "COMPLETED" inside "uncompleted" should not.
    expect(r.status).toBe("fixed");
    expect(r.keyword).toBe("DONE");
  });

  test("does not match BLOCKED inside UNBLOCKED", () => {
    const r = parseStepStatus("The issue is now UNBLOCKED");
    expect(r.status).toBe("ambiguous");
  });

  // -- ambiguous (no keyword) -----------------------------------------------
  test("returns ambiguous when no keyword is found", () => {
    const r = parseStepStatus("I made some progress on the issue.");
    expect(r).toEqual({ status: "ambiguous", keyword: undefined });
  });

  test("returns ambiguous for empty string", () => {
    const r = parseStepStatus("");
    expect(r).toEqual({ status: "ambiguous", keyword: undefined });
  });

  // -- NOT_APPROVED vs APPROVED precedence by position ----------------------
  test("NOT_APPROVED takes precedence when it appears last", () => {
    const r = parseStepStatus("APPROVED earlier, but NOT_APPROVED now");
    expect(r.status).toBe("not_approved");
  });

  test("APPROVED wins when it appears after NOT_APPROVED", () => {
    const r = parseStepStatus("NOT_APPROVED before, but APPROVED now");
    expect(r.status).toBe("approved");
  });

  // -- keyword surrounded by various delimiters -----------------------------
  test("matches keyword at start of string", () => {
    const r = parseStepStatus("COMPLETED. All good.");
    expect(r.status).toBe("completed");
  });

  test("matches keyword at end of string", () => {
    const r = parseStepStatus("Result: BLOCKED");
    expect(r.status).toBe("blocked");
  });

  test("matches keyword on its own line", () => {
    const r = parseStepStatus("Some explanation.\nCOMPLETED\n");
    expect(r.status).toBe("completed");
  });

  test("matches keyword after punctuation", () => {
    const r = parseStepStatus("Done! FIXED.");
    expect(r.status).toBe("fixed");
  });

  // -- multiline with multiple keywords -------------------------------------
  test("handles multiline responses with last keyword winning", () => {
    const text = [
      "I tried to fix the issue.",
      "Status: BLOCKED",
      "After further investigation:",
      "The tests pass now. FIXED",
    ].join("\n");
    expect(parseStepStatus(text).status).toBe("fixed");
  });
});

// ---------------------------------------------------------------------------
// buildClarificationPrompt
// ---------------------------------------------------------------------------
describe("buildClarificationPrompt", () => {
  test("returns a non-empty string", () => {
    const prompt = buildClarificationPrompt("Some ambiguous response");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("mentions all recognised keywords", () => {
    const prompt = buildClarificationPrompt("");
    expect(prompt).toContain("COMPLETED");
    expect(prompt).toContain("FIXED");
    expect(prompt).toContain("DONE");
    expect(prompt).toContain("APPROVED");
    expect(prompt).toContain("NOT_APPROVED");
    expect(prompt).toContain("BLOCKED");
  });

  test("lists only the specified keywords when validKeywords is provided", () => {
    const prompt = buildClarificationPrompt("ambiguous", ["FIXED", "DONE"]);
    expect(prompt).toContain("FIXED");
    expect(prompt).toContain("DONE");
    // Should NOT contain keywords outside the valid set.
    expect(prompt).not.toContain("COMPLETED");
    expect(prompt).not.toContain("APPROVED");
    expect(prompt).not.toContain("NOT_APPROVED");
    expect(prompt).not.toContain("BLOCKED");
  });

  test("falls back to all keywords when validKeywords is undefined", () => {
    const prompt = buildClarificationPrompt("ambiguous", undefined);
    expect(prompt).toContain("COMPLETED");
    expect(prompt).toContain("FIXED");
    expect(prompt).toContain("DONE");
    expect(prompt).toContain("APPROVED");
    expect(prompt).toContain("NOT_APPROVED");
    expect(prompt).toContain("BLOCKED");
  });

  test("falls back to all keywords when validKeywords is empty", () => {
    const prompt = buildClarificationPrompt("ambiguous", []);
    expect(prompt).toContain("COMPLETED");
    expect(prompt).toContain("BLOCKED");
  });

  test("scoped prompt uses 'verdict keyword' phrasing", () => {
    const prompt = buildClarificationPrompt("ambiguous", ["APPROVED"]);
    expect(prompt).toContain("verdict keyword");
  });
});

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------
describe("parseStepStatus — edge cases", () => {
  test("keyword surrounded by tabs and newlines", () => {
    const r = parseStepStatus("\t\nCOMPLETED\t\n");
    expect(r.status).toBe("completed");
  });

  test("keyword preceded by unicode characters", () => {
    // Non-ASCII before keyword — \W matches non-word chars including unicode.
    const r = parseStepStatus("결과: COMPLETED");
    expect(r.status).toBe("completed");
  });

  test("very long text with keyword at the end", () => {
    const filler = "a".repeat(10000);
    const r = parseStepStatus(`${filler} DONE`);
    expect(r.status).toBe("fixed");
    expect(r.keyword).toBe("DONE");
  });

  test("multiple different keywords returns last by position", () => {
    const r = parseStepStatus("BLOCKED then FIXED then APPROVED");
    expect(r.status).toBe("approved");
  });

  test("keyword in all caps inside a sentence", () => {
    const r = parseStepStatus("The task is now DONE and ready.");
    expect(r.status).toBe("fixed");
  });

  test("only whitespace input returns ambiguous", () => {
    const r = parseStepStatus("   \n\t  ");
    expect(r).toEqual({ status: "ambiguous", keyword: undefined });
  });

  test("APPROVED inside NOT_APPROVED does not match separately", () => {
    // "NOT_APPROVED" contains "APPROVED" as substring, but word boundary
    // should prevent standalone APPROVED match.
    const r = parseStepStatus("Status: NOT_APPROVED");
    expect(r.status).toBe("not_approved");
    expect(r.keyword).toBe("NOT_APPROVED");
  });
});

// ---------------------------------------------------------------------------
// parseVerdictKeyword — strict verdict parser
// ---------------------------------------------------------------------------
describe("parseVerdictKeyword", () => {
  const reviewKw = ["APPROVED", "NOT_APPROVED"] as const;
  const checkKw = ["COMPLETED", "BLOCKED"] as const;
  const fixKw = ["FIXED", "DONE"] as const;

  // -- exact match ----------------------------------------------------------
  test("returns keyword on exact match", () => {
    expect(parseVerdictKeyword("APPROVED", reviewKw)).toEqual({
      keyword: "APPROVED",
    });
  });

  test("exact match is case-insensitive", () => {
    expect(parseVerdictKeyword("completed", checkKw)).toEqual({
      keyword: "COMPLETED",
    });
  });

  test("trims whitespace around keyword", () => {
    expect(parseVerdictKeyword("  BLOCKED\n", checkKw)).toEqual({
      keyword: "BLOCKED",
    });
  });

  // -- rejection of extra commentary ----------------------------------------
  test("rejects keyword with extra commentary before", () => {
    expect(
      parseVerdictKeyword("I think it worked. COMPLETED", checkKw),
    ).toEqual({ keyword: undefined });
  });

  test("rejects keyword with extra commentary after", () => {
    expect(
      parseVerdictKeyword("APPROVED — earlier items are now fixed", reviewKw),
    ).toEqual({ keyword: undefined });
  });

  test("rejects keyword ending in valid keyword with extra text", () => {
    // Regression: response ends with valid keyword but has commentary.
    expect(
      parseVerdictKeyword("Round 1 items are now APPROVED", reviewKw),
    ).toEqual({ keyword: undefined });
  });

  // -- rejection of multiple valid keywords ---------------------------------
  test("rejects when two in-scope keywords appear", () => {
    // Regression: "NOT_APPROVED — earlier items are now APPROVED"
    expect(
      parseVerdictKeyword(
        "NOT_APPROVED — earlier items are now APPROVED",
        reviewKw,
      ),
    ).toEqual({ keyword: undefined });
  });

  test("rejects FIXED and DONE in the same response", () => {
    expect(parseVerdictKeyword("FIXED and DONE", fixKw)).toEqual({
      keyword: undefined,
    });
  });

  test("rejects COMPLETED and BLOCKED in the same response", () => {
    expect(
      parseVerdictKeyword("COMPLETED at first but then BLOCKED", checkKw),
    ).toEqual({ keyword: undefined });
  });

  // -- no keyword -----------------------------------------------------------
  test("returns undefined for text with no valid keyword", () => {
    expect(parseVerdictKeyword("I looked at things.", checkKw)).toEqual({
      keyword: undefined,
    });
  });

  test("returns undefined for empty string", () => {
    expect(parseVerdictKeyword("", checkKw)).toEqual({
      keyword: undefined,
    });
  });

  test("returns undefined for whitespace only", () => {
    expect(parseVerdictKeyword("  \n\t  ", checkKw)).toEqual({
      keyword: undefined,
    });
  });

  // -- keyword not in valid set ---------------------------------------------
  test("ignores out-of-scope keyword", () => {
    // DONE is valid in fixKw but not in checkKw.
    expect(parseVerdictKeyword("DONE", checkKw)).toEqual({
      keyword: undefined,
    });
  });

  // -- keyword with minor punctuation ---------------------------------------
  test("accepts keyword with trailing period", () => {
    expect(parseVerdictKeyword("COMPLETED.", checkKw)).toEqual({
      keyword: "COMPLETED",
    });
  });

  test("accepts keyword with trailing exclamation", () => {
    expect(parseVerdictKeyword("BLOCKED!", checkKw)).toEqual({
      keyword: "BLOCKED",
    });
  });

  // -- NOT_APPROVED substring handling --------------------------------------
  test("does not match APPROVED inside NOT_APPROVED", () => {
    expect(parseVerdictKeyword("NOT_APPROVED", reviewKw)).toEqual({
      keyword: "NOT_APPROVED",
    });
  });

  // -- squash three-way verdict ---------------------------------------------
  describe("squash three-way verdict", () => {
    const squashKw = ["SQUASHED_MULTI", "SUGGESTED_SINGLE", "BLOCKED"] as const;

    test("returns SQUASHED_MULTI on exact match", () => {
      expect(parseVerdictKeyword("SQUASHED_MULTI", squashKw)).toEqual({
        keyword: "SQUASHED_MULTI",
      });
    });

    test("returns SUGGESTED_SINGLE on exact match", () => {
      expect(parseVerdictKeyword("SUGGESTED_SINGLE", squashKw)).toEqual({
        keyword: "SUGGESTED_SINGLE",
      });
    });

    test("rejects when both SQUASHED_MULTI and SUGGESTED_SINGLE appear", () => {
      expect(
        parseVerdictKeyword(
          "I started with SQUASHED_MULTI but then chose SUGGESTED_SINGLE",
          squashKw,
        ),
      ).toEqual({ keyword: undefined });
    });

    test("rejects when SUGGESTED_SINGLE appears with extra commentary", () => {
      expect(
        parseVerdictKeyword(
          "SUGGESTED_SINGLE — wrote the marker block",
          squashKw,
        ),
      ).toEqual({ keyword: undefined });
    });

    test("ignores out-of-scope COMPLETED for squash keywords", () => {
      expect(parseVerdictKeyword("COMPLETED", squashKw)).toEqual({
        keyword: undefined,
      });
    });
  });
});
