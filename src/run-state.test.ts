import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const tmpHome = join(import.meta.dirname, "..", ".tmp-test-home-run-state");

vi.mock("node:os", () => ({
  homedir: () => tmpHome,
}));

const { deleteRunState, loadRunState, runStatePath, saveRunState } =
  await import("./run-state.js");

import type { RunState } from "./run-state.js";

// ---- helpers -------------------------------------------------------------

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    owner: "org",
    repo: "repo",
    issueNumber: 42,
    branch: "issue-42",
    worktreePath: "/tmp/wt/issue-42",
    prNumber: undefined,
    currentStage: 2,
    stageLoopCount: 0,
    reviewRound: 0,
    executionMode: "auto",
    claudePermissionMode: "auto",
    agentA: { cli: "claude", model: "opus", sessionId: "sess-a" },
    agentB: { cli: "claude", model: "sonnet", sessionId: undefined },
    ...overrides,
  };
}

// ---- setup / teardown ----------------------------------------------------

beforeEach(() => {
  mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ---- tests ---------------------------------------------------------------

describe("runStatePath", () => {
  test("returns expected path", () => {
    const p = runStatePath("acme", "widget", 7);
    expect(p).toBe(
      join(tmpHome, ".agentcoop", "runs", "acme", "widget", "7.json"),
    );
  });
});

describe("saveRunState / loadRunState round-trip", () => {
  test("round-trips a full state object", () => {
    const state = makeRunState({ prNumber: 99, stageLoopCount: 5 });
    saveRunState(state);
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded).toEqual(state);
  });

  test("preserves stageLoopCount across save/load", () => {
    const state = makeRunState({ stageLoopCount: 5 });
    saveRunState(state);
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.stageLoopCount).toBe(5);
  });

  test("preserves undefined prNumber", () => {
    const state = makeRunState({ prNumber: undefined });
    saveRunState(state);
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.prNumber).toBeUndefined();
  });

  test("preserves agent sessionIds", () => {
    const state = makeRunState({
      agentA: { cli: "claude", model: "opus", sessionId: "abc-123" },
      agentB: { cli: "codex", model: "gpt-5.4", sessionId: undefined },
    });
    saveRunState(state);
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.agentA.sessionId).toBe("abc-123");
    expect(loaded?.agentB.sessionId).toBeUndefined();
  });

  test("overwrites existing state file", () => {
    saveRunState(makeRunState({ currentStage: 2 }));
    saveRunState(makeRunState({ currentStage: 5 }));
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.currentStage).toBe(5);
  });
});

describe("loadRunState — missing / malformed", () => {
  test("returns undefined when file does not exist", () => {
    expect(loadRunState("org", "repo", 99)).toBeUndefined();
  });

  test("returns undefined for malformed JSON", () => {
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, "not json{{{");
    expect(loadRunState("org", "repo", 42)).toBeUndefined();
  });

  test("returns undefined when required fields are missing", () => {
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify({ owner: "org" }));
    expect(loadRunState("org", "repo", 42)).toBeUndefined();
  });

  test("returns undefined for invalid executionMode", () => {
    const state = { ...makeRunState(), executionMode: "turbo" };
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(state));
    expect(loadRunState("org", "repo", 42)).toBeUndefined();
  });

  test("returns undefined when agentA is missing cli field", () => {
    const raw = { ...makeRunState(), agentA: { model: "opus" } };
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    expect(loadRunState("org", "repo", 42)).toBeUndefined();
  });

  test("normalises null prNumber to undefined", () => {
    const raw = { ...makeRunState(), prNumber: null };
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded).toBeDefined();
    expect(loaded?.prNumber).toBeUndefined();
  });

  test("normalises null sessionId to undefined", () => {
    const raw = {
      ...makeRunState(),
      agentA: { cli: "claude", model: "opus", sessionId: null },
    };
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded).toBeDefined();
    expect(loaded?.agentA.sessionId).toBeUndefined();
  });
});

describe("deleteRunState", () => {
  test("removes the state file", () => {
    saveRunState(makeRunState());
    expect(loadRunState("org", "repo", 42)).toBeDefined();
    deleteRunState("org", "repo", 42);
    expect(loadRunState("org", "repo", 42)).toBeUndefined();
  });

  test("does not throw when file does not exist", () => {
    expect(() => deleteRunState("org", "repo", 999)).not.toThrow();
  });
});
