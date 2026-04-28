import { describe, expect, test } from "vitest";
import type { ConfirmRetryInfo } from "./ci-poll.js";
import { buildDoneConfirmRetryPrompt } from "./done-prompt-options.js";

// Verifies the wiring used by `src/index.ts` to translate a
// ConfirmRetryInfo into the localized prompt shown to the user via
// `tuiPrompt.confirmCleanup`.  Without this guard, a missing `reason`
// branch in the helper would silently fall through and not surface in
// either ci-poll or pipeline tests.
describe("buildDoneConfirmRetryPrompt", () => {
  test("exhausted reason renders the still-failing message", () => {
    const info: ConfirmRetryInfo = {
      reason: "exhausted",
      attempts: 3,
      message: "irrelevant",
    };
    const prompt = buildDoneConfirmRetryPrompt(info);
    expect(prompt).toContain("3");
    expect(prompt).toContain("Keep trying");
  });

  test("timeout reason renders the still-pending message with seconds", () => {
    const info: ConfirmRetryInfo = {
      reason: "timeout",
      seconds: 600,
      message: "irrelevant",
    };
    const prompt = buildDoneConfirmRetryPrompt(info);
    expect(prompt).toContain("600");
    expect(prompt).toContain("pending");
    expect(prompt).toContain("Keep waiting");
  });

  test("agent_error reason renders the agent-error message with detail", () => {
    const info: ConfirmRetryInfo = {
      reason: "agent_error",
      detail: "exit code 1: segfault",
      message: "irrelevant",
    };
    const prompt = buildDoneConfirmRetryPrompt(info);
    expect(prompt).toContain("Agent error");
    expect(prompt).toContain("exit code 1: segfault");
    expect(prompt).toContain("Retry");
  });
});
