import { describe, expect, test, vi } from "vitest";
import { createTuiUserPrompt, type PromptDispatch } from "./TuiUserPrompt.js";

// ---- helpers -----------------------------------------------------------------

function makeDispatch(...responses: string[]): PromptDispatch {
  let call = 0;
  return vi.fn().mockImplementation(async () => {
    const value = responses[call];
    call++;
    return value;
  });
}

// ---- tests -------------------------------------------------------------------

describe("TuiUserPrompt", () => {
  describe("confirmContinueLoop", () => {
    test("returns true when user selects yes", async () => {
      const dispatch = makeDispatch("yes");
      const prompt = createTuiUserPrompt(dispatch);
      const result = await prompt.confirmContinueLoop("Self-check", 3, "msg");
      expect(result).toBe(true);
    });

    test("returns false when user selects no", async () => {
      const dispatch = makeDispatch("no");
      const prompt = createTuiUserPrompt(dispatch);
      const result = await prompt.confirmContinueLoop("Self-check", 3, "msg");
      expect(result).toBe(false);
    });

    test("passes stage name and iteration in message", async () => {
      const dispatch = makeDispatch("yes");
      const prompt = createTuiUserPrompt(dispatch);
      await prompt.confirmContinueLoop("Review", 5, "unresolved items");
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Review"),
          choices: expect.arrayContaining([
            expect.objectContaining({ value: "yes" }),
            expect.objectContaining({ value: "no" }),
          ]),
        }),
      );
    });

    test("includes the stage message in the prompt", async () => {
      const dispatch = makeDispatch("yes");
      const prompt = createTuiUserPrompt(dispatch);
      await prompt.confirmContinueLoop("Stage", 1, "3 items remain");
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("3 items remain"),
        }),
      );
    });
  });

  describe("confirmNextStage", () => {
    test("returns true for yes", async () => {
      const dispatch = makeDispatch("yes");
      const prompt = createTuiUserPrompt(dispatch);
      expect(await prompt.confirmNextStage("CI check")).toBe(true);
    });

    test("returns false for no", async () => {
      const dispatch = makeDispatch("no");
      const prompt = createTuiUserPrompt(dispatch);
      expect(await prompt.confirmNextStage("CI check")).toBe(false);
    });
  });

  describe("handleBlocked", () => {
    test("returns halt action", async () => {
      const dispatch = makeDispatch("halt");
      const prompt = createTuiUserPrompt(dispatch);
      const result = await prompt.handleBlocked("stuck", true);
      expect(result).toEqual({ action: "halt" });
    });

    test("returns proceed action", async () => {
      const dispatch = makeDispatch("proceed");
      const prompt = createTuiUserPrompt(dispatch);
      const result = await prompt.handleBlocked("stuck", true);
      expect(result).toEqual({ action: "proceed" });
    });

    test("returns instruct with follow-up instruction", async () => {
      const dispatch = makeDispatch("instruct", "try another approach");
      const prompt = createTuiUserPrompt(dispatch);
      const result = await prompt.handleBlocked("stuck", true);
      expect(result).toEqual({
        action: "instruct",
        instruction: "try another approach",
      });
      expect(dispatch).toHaveBeenCalledTimes(2);
    });

    test("omits proceed choice when allowProceed is false", async () => {
      const dispatch = makeDispatch("halt");
      const prompt = createTuiUserPrompt(dispatch);
      await prompt.handleBlocked("stuck", false);
      const call = vi.mocked(dispatch).mock.calls[0][0];
      const values = call.choices?.map((c) => c.value) ?? [];
      expect(values).not.toContain("proceed");
      expect(values).toContain("instruct");
      expect(values).toContain("halt");
    });

    test("includes proceed choice when allowProceed is true", async () => {
      const dispatch = makeDispatch("halt");
      const prompt = createTuiUserPrompt(dispatch);
      await prompt.handleBlocked("stuck", true);
      const call = vi.mocked(dispatch).mock.calls[0][0];
      const values = call.choices?.map((c) => c.value) ?? [];
      expect(values).toContain("proceed");
    });

    test("includes BLOCKED prefix in message", async () => {
      const dispatch = makeDispatch("halt");
      const prompt = createTuiUserPrompt(dispatch);
      await prompt.handleBlocked("cannot access repo", true);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("BLOCKED: cannot access repo"),
        }),
      );
    });
  });

  describe("handleError", () => {
    test("returns retry", async () => {
      const dispatch = makeDispatch("retry");
      const prompt = createTuiUserPrompt(dispatch);
      expect(await prompt.handleError("timeout")).toEqual({ action: "retry" });
    });

    test("returns skip", async () => {
      const dispatch = makeDispatch("skip");
      const prompt = createTuiUserPrompt(dispatch);
      expect(await prompt.handleError("timeout")).toEqual({ action: "skip" });
    });

    test("returns abort", async () => {
      const dispatch = makeDispatch("abort");
      const prompt = createTuiUserPrompt(dispatch);
      expect(await prompt.handleError("timeout")).toEqual({ action: "abort" });
    });

    test("includes ERROR prefix in message", async () => {
      const dispatch = makeDispatch("abort");
      const prompt = createTuiUserPrompt(dispatch);
      await prompt.handleError("process crashed");
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("ERROR: process crashed"),
        }),
      );
    });
  });

  describe("handleAmbiguous", () => {
    test("returns proceed", async () => {
      const dispatch = makeDispatch("proceed");
      const prompt = createTuiUserPrompt(dispatch);
      const result = await prompt.handleAmbiguous("unclear response");
      expect(result).toEqual({ action: "proceed" });
    });

    test("returns instruct with follow-up", async () => {
      const dispatch = makeDispatch("instruct", "clarify please");
      const prompt = createTuiUserPrompt(dispatch);
      const result = await prompt.handleAmbiguous("unclear");
      expect(result).toEqual({
        action: "instruct",
        instruction: "clarify please",
      });
      expect(dispatch).toHaveBeenCalledTimes(2);
    });

    test("returns halt", async () => {
      const dispatch = makeDispatch("halt");
      const prompt = createTuiUserPrompt(dispatch);
      const result = await prompt.handleAmbiguous("unclear");
      expect(result).toEqual({ action: "halt" });
    });
  });

  describe("confirmMerge", () => {
    test("returns true for yes", async () => {
      const dispatch = makeDispatch("yes");
      const prompt = createTuiUserPrompt(dispatch);
      expect(await prompt.confirmMerge("Has the PR been merged?")).toBe(true);
    });

    test("returns false for no", async () => {
      const dispatch = makeDispatch("no");
      const prompt = createTuiUserPrompt(dispatch);
      expect(await prompt.confirmMerge("Has the PR been merged?")).toBe(false);
    });
  });

  describe("reportCompletion", () => {
    test("dispatches message and waits for acknowledgement", async () => {
      const dispatch = makeDispatch("ok");
      const prompt = createTuiUserPrompt(dispatch);
      await prompt.reportCompletion("Pipeline done.");
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Pipeline done.",
          choices: expect.arrayContaining([
            expect.objectContaining({ value: "ok" }),
          ]),
        }),
      );
    });
  });
});
