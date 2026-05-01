import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const tmpHome = join(import.meta.dirname, "..", ".tmp-test-home-run-state");

vi.mock("node:os", () => ({
  homedir: () => tmpHome,
}));

const {
  RUN_STATE_VERSION,
  deleteRunState,
  loadRunState,
  runStatePath,
  saveRunState,
} = await import("./run-state.js");

import type { RunState } from "./run-state.js";

// ---- helpers -------------------------------------------------------------

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    version: RUN_STATE_VERSION,
    owner: "org",
    repo: "repo",
    issueNumber: 42,
    branch: "issue-42",
    worktreePath: "/tmp/wt/issue-42",
    baseSha: undefined,
    prNumber: undefined,
    currentStage: 2,
    stageLoopCount: 0,
    reviewRound: 0,
    selfCheckCount: 0,
    reviewCount: 0,
    executionMode: "auto",
    agentA: {
      cli: "claude",
      model: "opus",
      contextWindow: undefined,
      effortLevel: undefined,
      sessionId: "sess-a",
    },
    agentB: {
      cli: "claude",
      model: "sonnet",
      contextWindow: undefined,
      effortLevel: undefined,
      sessionId: undefined,
    },
    issueSyncStatus: "skipped",
    issueChanges: [],
    squashSubStep: undefined,
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

  test("preserves reviewerWorktreePath", () => {
    const state = makeRunState({
      reviewerWorktreePath: "/tmp/wt/issue-42-review",
    });
    saveRunState(state);
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.reviewerWorktreePath).toBe("/tmp/wt/issue-42-review");
  });

  test("preserves agent sessionIds", () => {
    const state = makeRunState({
      agentA: {
        cli: "claude",
        model: "opus",
        contextWindow: "1m",
        effortLevel: "high",
        sessionId: "abc-123",
      },
      agentB: {
        cli: "codex",
        model: "gpt-5.5",
        contextWindow: undefined,
        effortLevel: "xhigh",
        sessionId: undefined,
      },
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

  test("normalises null reviewerWorktreePath to undefined", () => {
    const raw = { ...makeRunState(), reviewerWorktreePath: null };
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded).toBeDefined();
    expect(loaded?.reviewerWorktreePath).toBeUndefined();
  });

  test("normalises null sessionId to undefined", () => {
    const raw = {
      ...makeRunState(),
      agentA: {
        cli: "claude",
        model: "opus",
        contextWindow: null,
        effortLevel: null,
        sessionId: null,
      },
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

describe("loadRunState — migration from v1 (unversioned)", () => {
  /** Write a raw v1 state (no version field) to disk. */
  function writeV1State(overrides: Record<string, unknown> = {}) {
    const { version: _, ...rest } = makeRunState();
    const raw = { ...rest, ...overrides };
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
  }

  test("migrates stage 7 (old squash) → 8 (new squash)", () => {
    writeV1State({ currentStage: 7 });
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.currentStage).toBe(8);
    expect(loaded?.version).toBe(RUN_STATE_VERSION);
  });

  test("migrates stage 8 (old review) → 7 (new review)", () => {
    writeV1State({ currentStage: 8 });
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.currentStage).toBe(7);
    expect(loaded?.version).toBe(RUN_STATE_VERSION);
  });

  test("leaves other stages unchanged", () => {
    writeV1State({ currentStage: 5 });
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.currentStage).toBe(5);
    expect(loaded?.version).toBe(RUN_STATE_VERSION);
  });

  test("does not migrate a current-version state", () => {
    saveRunState(makeRunState({ currentStage: 7 }));
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.currentStage).toBe(7);
  });
});

describe("loadRunState — migration from v2", () => {
  /**
   * Write a raw v2 state (post-stage-swap, pre-squashSubStep) to disk.
   * v2 files already have stages 7=review and 8=squash; the upgrade
   * to v3 must not re-apply the v1→v2 swap.
   */
  function writeV2State(overrides: Record<string, unknown> = {}) {
    const { squashSubStep: _, ...rest } = makeRunState();
    const raw = { ...rest, version: 2, ...overrides };
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
  }

  test("preserves stage 7 across v2 → v3 upgrade", () => {
    writeV2State({ currentStage: 7 });
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.currentStage).toBe(7);
    expect(loaded?.version).toBe(RUN_STATE_VERSION);
  });

  test("preserves stage 8 across v2 → v3 upgrade", () => {
    writeV2State({ currentStage: 8 });
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.currentStage).toBe(8);
    expect(loaded?.version).toBe(RUN_STATE_VERSION);
  });

  test("backfills squashSubStep as undefined on v2 → v3 upgrade", () => {
    writeV2State({ currentStage: 8 });
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.squashSubStep).toBeUndefined();
  });
});

describe("squashSubStep persistence", () => {
  test("round-trips squashSubStep", () => {
    const state = makeRunState({
      currentStage: 8,
      squashSubStep: "applied_via_github",
    });
    saveRunState(state);
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.squashSubStep).toBe("applied_via_github");
  });

  test("migrates v3 'applied_in_pr_body' to 'applied_via_github'", () => {
    const { squashSubStep: _, ...rest } = makeRunState({ currentStage: 8 });
    const raw = {
      ...rest,
      version: 3,
      squashSubStep: "applied_in_pr_body",
    };
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.squashSubStep).toBe("applied_via_github");
    expect(loaded?.version).toBe(RUN_STATE_VERSION);
  });

  test("defaults to undefined for old state files without squashSubStep", () => {
    const { squashSubStep: _, ...raw } = makeRunState();
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded).toBeDefined();
    expect(loaded?.squashSubStep).toBeUndefined();
  });
});

describe("selfCheckCount and reviewCount persistence", () => {
  test("round-trips selfCheckCount and reviewCount", () => {
    const state = makeRunState({ selfCheckCount: 3, reviewCount: 5 });
    saveRunState(state);
    const loaded = loadRunState("org", "repo", 42);
    expect(loaded?.selfCheckCount).toBe(3);
    expect(loaded?.reviewCount).toBe(5);
  });

  test("defaults to zero for old state files without count fields", () => {
    const { selfCheckCount: _, reviewCount: __, ...raw } = makeRunState();
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRunState("org", "repo", 42);

    expect(loaded).toBeDefined();
    expect(loaded?.selfCheckCount).toBe(0);
    expect(loaded?.reviewCount).toBe(0);
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

describe("resume preserves contextWindow and effortLevel", () => {
  test("round-trips contextWindow and effortLevel for both agents", () => {
    const state = makeRunState({
      agentA: {
        cli: "claude",
        model: "claude-opus-4-6",
        contextWindow: "1m",
        effortLevel: "high",
        sessionId: "sess-a",
      },
      agentB: {
        cli: "codex",
        model: "gpt-5.5",
        contextWindow: undefined,
        effortLevel: "xhigh",
        sessionId: undefined,
      },
    });
    saveRunState(state);
    const loaded = loadRunState("org", "repo", 42);

    expect(loaded?.agentA.contextWindow).toBe("1m");
    expect(loaded?.agentA.effortLevel).toBe("high");
    expect(loaded?.agentB.contextWindow).toBeUndefined();
    expect(loaded?.agentB.effortLevel).toBe("xhigh");
  });

  test("normalises null contextWindow and effortLevel to undefined", () => {
    const raw = {
      ...makeRunState(),
      agentA: {
        cli: "claude",
        model: "opus",
        contextWindow: null,
        effortLevel: null,
        sessionId: null,
      },
    };
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRunState("org", "repo", 42);

    expect(loaded).toBeDefined();
    expect(loaded?.agentA.contextWindow).toBeUndefined();
    expect(loaded?.agentA.effortLevel).toBeUndefined();
  });

  test("loads state saved without baseSha (backward compat)", () => {
    const raw = { ...makeRunState() };
    delete (raw as Record<string, unknown>).baseSha;
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRunState("org", "repo", 42);

    expect(loaded).toBeDefined();
    expect(loaded?.baseSha).toBeUndefined();
  });

  test("loads state saved without contextWindow/effortLevel (backward compat)", () => {
    const raw = {
      ...makeRunState(),
      agentA: { cli: "claude", model: "opus", sessionId: "s1" },
      agentB: { cli: "codex", model: "gpt-5.5", sessionId: undefined },
    };
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRunState("org", "repo", 42);

    expect(loaded).toBeDefined();
    expect(loaded?.agentA.contextWindow).toBeUndefined();
    expect(loaded?.agentA.effortLevel).toBeUndefined();
    expect(loaded?.agentB.contextWindow).toBeUndefined();
    expect(loaded?.agentB.effortLevel).toBeUndefined();
  });
});

describe("start-fresh clears issue sync state", () => {
  test("loadRunState returns undefined after deleteRunState so stale sync data is not hydrated", () => {
    const state = makeRunState({
      issueSyncStatus: "completed",
      issueChanges: [
        { type: "minor", description: "corrected file path" },
        { type: "major", description: "scope expanded to include API" },
      ],
    });
    saveRunState(state);
    expect(loadRunState("org", "repo", 42)).toBeDefined();

    // Simulate "Start fresh" path: delete on disk, then verify
    // the hydration pattern from index.ts yields clean defaults.
    deleteRunState("org", "repo", 42);
    const afterFresh = loadRunState("org", "repo", 42);
    expect(afterFresh).toBeUndefined();

    // This mirrors the hydration in index.ts (lines 322-324):
    //   const issueChanges = [...(savedState?.issueChanges ?? [])];
    //   let issueSyncStatus = savedState?.issueSyncStatus ?? "skipped";
    const issueChanges = [...(afterFresh?.issueChanges ?? [])];
    const issueSyncStatus = afterFresh?.issueSyncStatus ?? "skipped";
    expect(issueChanges).toEqual([]);
    expect(issueSyncStatus).toBe("skipped");
  });
});

describe("resume preserves issue sync state", () => {
  test("round-trips issueSyncStatus and issueChanges", () => {
    const state = makeRunState({
      currentStage: 5,
      issueSyncStatus: "completed",
      issueChanges: [
        { type: "minor", description: "corrected file path" },
        { type: "major", description: "scope expanded to include API" },
      ],
    });
    saveRunState(state);
    const loaded = loadRunState("org", "repo", 42);

    expect(loaded?.issueSyncStatus).toBe("completed");
    expect(loaded?.issueChanges).toEqual([
      { type: "minor", description: "corrected file path" },
      { type: "major", description: "scope expanded to include API" },
    ]);
  });

  test("round-trips completed status with empty changes", () => {
    const state = makeRunState({
      currentStage: 5,
      issueSyncStatus: "completed",
      issueChanges: [],
    });
    saveRunState(state);
    const loaded = loadRunState("org", "repo", 42);

    expect(loaded?.issueSyncStatus).toBe("completed");
    expect(loaded?.issueChanges).toEqual([]);
  });

  test("round-trips failed status", () => {
    const state = makeRunState({
      currentStage: 5,
      issueSyncStatus: "failed",
      issueChanges: [],
    });
    saveRunState(state);
    const loaded = loadRunState("org", "repo", 42);

    expect(loaded?.issueSyncStatus).toBe("failed");
  });

  test("defaults to skipped and empty changes for old state files", () => {
    // Simulate a state file written before issue sync fields existed.
    const { issueSyncStatus: _, issueChanges: __, ...raw } = makeRunState();
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    const loaded = loadRunState("org", "repo", 42);

    expect(loaded).toBeDefined();
    expect(loaded?.issueSyncStatus).toBe("skipped");
    expect(loaded?.issueChanges).toEqual([]);
  });

  test("rejects invalid issueSyncStatus value", () => {
    const raw = { ...makeRunState(), issueSyncStatus: "unknown" };
    const path = runStatePath("org", "repo", 42);
    mkdirSync(join(tmpHome, ".agentcoop", "runs", "org", "repo"), {
      recursive: true,
    });
    writeFileSync(path, JSON.stringify(raw));
    expect(loadRunState("org", "repo", 42)).toBeUndefined();
  });
});
