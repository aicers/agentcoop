import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  type CleanupInterruptState,
  resilientConfirm,
} from "./cleanup-confirm.js";

// Mock @inquirer/prompts so we can control what confirm() does.
vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
}));

// Dynamically import so the mock is in place.
const { confirm } = await import("@inquirer/prompts");
const mockConfirm = vi.mocked(confirm);

/** Build an error that looks like @inquirer/core ExitPromptError. */
function exitPromptError(): Error {
  const err = new Error("User force closed the prompt with SIGINT");
  err.name = "ExitPromptError";
  return err;
}

describe("resilientConfirm", () => {
  const opts = { message: "Delete?" };
  const warning = "Cleanup in progress. Press Ctrl+C again to force quit.";

  beforeEach(() => {
    mockConfirm.mockReset();
  });

  test("returns the value from confirm() on success", async () => {
    mockConfirm.mockResolvedValueOnce(true);
    const state: CleanupInterruptState = { count: 0 };
    const result = await resilientConfirm(opts, state, warning);
    expect(result).toBe(true);
    expect(state.count).toBe(0);
  });

  test("first ExitPromptError warns and re-asks the prompt", async () => {
    mockConfirm
      .mockRejectedValueOnce(exitPromptError())
      .mockResolvedValueOnce(true);
    const state: CleanupInterruptState = { count: 0 };
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await resilientConfirm(opts, state, warning);
    expect(result).toBe(true);
    expect(state.count).toBe(1);
    expect(spy).toHaveBeenCalledWith(`\n${warning}`);
    expect(mockConfirm).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test("second ExitPromptError force-exits the process", async () => {
    mockConfirm.mockRejectedValueOnce(exitPromptError());
    const state: CleanupInterruptState = { count: 1 };
    const spy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    await resilientConfirm(opts, state, warning);
    expect(spy).toHaveBeenCalledWith(1);
    spy.mockRestore();
  });

  test("re-throws non-ExitPromptError errors", async () => {
    const otherError = new Error("something else");
    mockConfirm.mockRejectedValueOnce(otherError);
    const state: CleanupInterruptState = { count: 0 };
    await expect(resilientConfirm(opts, state, warning)).rejects.toThrow(
      "something else",
    );
    expect(state.count).toBe(0);
  });

  test("first interrupt re-prompts, second force-exits", async () => {
    mockConfirm
      .mockRejectedValueOnce(exitPromptError())
      .mockRejectedValueOnce(exitPromptError());
    const state: CleanupInterruptState = { count: 0 };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await resilientConfirm(opts, state, warning);

    expect(logSpy).toHaveBeenCalledWith(`\n${warning}`);
    expect(state.count).toBe(2);
    expect(exitSpy).toHaveBeenCalledWith(1);
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test("shared state accumulates across multiple prompts", async () => {
    mockConfirm
      .mockRejectedValueOnce(exitPromptError())
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const state: CleanupInterruptState = { count: 0 };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    // First prompt: interrupted → warns, re-asks, user answers false
    const r1 = await resilientConfirm(opts, state, warning);
    expect(r1).toBe(false);
    expect(state.count).toBe(1);

    // Second prompt: answered normally → count unchanged
    const r2 = await resilientConfirm(opts, state, warning);
    expect(r2).toBe(true);
    expect(state.count).toBe(1);

    expect(exitSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
