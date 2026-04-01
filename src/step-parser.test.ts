import { describe, expect, test } from "vitest";
import { buildClarificationPrompt, parseStepStatus } from "./step-parser.js";

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
