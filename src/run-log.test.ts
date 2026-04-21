import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  type WriteStream,
} from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PipelineEventEmitter } from "./pipeline-events.js";
import { createRunLog, logFilePath, type RunLogMetadata } from "./run-log.js";

// Redirect homedir() to a temp directory so tests don't pollute the
// user's home.  vi.hoisted runs before imports, so we use require.
const { TEST_HOME, streamControl } = vi.hoisted(() => {
  const os = require("node:os");
  const path = require("node:path");
  return {
    TEST_HOME: path.join(os.tmpdir(), `agentcoop-run-log-test-${process.pid}`),
    /** Captures created WriteStreams so tests can manipulate them. */
    streamControl: { streams: [] as WriteStream[] },
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => TEST_HOME,
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    createWriteStream: (
      ...args: Parameters<typeof actual.createWriteStream>
    ) => {
      const stream = (actual.createWriteStream as (...a: never) => unknown)(
        ...args,
      );
      streamControl.streams.push(stream as WriteStream);
      return stream;
    },
  };
});

function meta(overrides?: Partial<RunLogMetadata>): RunLogMetadata {
  return {
    owner: "acme",
    repo: "widget",
    issueNumber: 42,
    worktreePath: "/tmp/wt",
    executionMode: "auto",
    agentA: {
      cli: "claude",
      model: "opus",
      contextWindow: "200k",
      effortLevel: "high",
    },
    agentB: { cli: "claude", model: "sonnet" },
    selfCheckAutoIterations: 5,
    reviewAutoRounds: 5,
    ciCheckAutoIterations: 3,
    ciCheckTimeoutMinutes: 10,
    inactivityTimeoutMinutes: 20,
    autoResumeAttempts: 3,
    ...overrides,
  };
}

describe("logFilePath", () => {
  test("produces expected file name", () => {
    const date = new Date("2026-03-15T09:05:07.000Z");
    const p = logFilePath("acme", "widget", 42, date);
    expect(p).toContain("acme-widget-#42-");
    expect(p).toMatch(/\.log$/);
  });
});

describe("createRunLog", () => {
  beforeEach(() => {
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    streamControl.streams = [];
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  function readLog(path: string): string {
    return readFileSync(path, "utf-8");
  }

  test("creates log file with header", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());
    await log.close();

    expect(existsSync(log.path)).toBe(true);
    const content = readLog(log.path);
    expect(content).toContain("=== AgentCoop Run Log ===");
    expect(content).toContain("acme/widget");
    expect(content).toContain("#42");
    expect(content).toContain("claude / opus");
    expect(content).toContain("context  : 200k");
    expect(content).toContain("effort   : high");
    expect(content).toContain("claude / sonnet");
    expect(content).toContain("self-check=5");
    expect(content).toContain("review=5");
    expect(content).toContain("ci-check=3");
    expect(content).toContain("ciCheck=10m");
    expect(content).toContain("inactivity=20m");
    expect(content).toContain("autoResume=3");
    expect(content).toContain("auto");
  });

  test("records cliVersion in header when provided", async () => {
    // The run-log header is a postmortem surface — when version
    // detection succeeded for this run we want the CLI build to land
    // on disk next to the agent/model lines.
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(
      emitter,
      meta({
        agentA: {
          cli: "claude",
          model: "opus",
          contextWindow: "200k",
          effortLevel: "high",
          cliVersion: "1.2.3",
        },
        agentB: { cli: "codex", model: "sonnet", cliVersion: "0.46.0" },
      }),
    );
    await log.close();

    const content = readLog(log.path);
    expect(content).toContain("version  : 1.2.3");
    expect(content).toContain("version  : 0.46.0");
  });

  test("omits version line when cliVersion is undefined", async () => {
    // On a fresh run where `--version` failed we have no value to
    // record — the header must omit the line rather than print a
    // stray `version  : undefined`.
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());
    await log.close();

    const content = readLog(log.path);
    expect(content).not.toContain("version  :");
  });

  test("logs agent:chunk events", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());

    emitter.emit("agent:chunk", { agent: "a", chunk: "hello world" });
    await log.close();

    const content = readLog(log.path);
    expect(content).toContain("[Agent A] hello world");
  });

  test("logs agent:prompt events", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());

    emitter.emit("agent:prompt", {
      agent: "b",
      prompt: "Fix the bug",
      kind: "ci-fix",
    });
    await log.close();

    const content = readLog(log.path);
    expect(content).toContain("[Agent B:prompt] --- prompt start (ci-fix) ---");
    expect(content).toContain("[Agent B:prompt] Fix the bug");
    expect(content).toContain("[Agent B:prompt] --- prompt end ---");
  });

  test("logs agent:invoke events with prompt kind and stage context", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());

    // "work" before any stage:enter — falls back to generic "work".
    emitter.emit("agent:invoke", {
      agent: "a",
      type: "invoke",
      kind: "work",
    });

    // Enter a stage so subsequent "work" prompts include stage context.
    emitter.emit("stage:enter", {
      stageNumber: 2,
      stageName: "Implement",
      iteration: 0,
    });

    emitter.emit("agent:invoke", {
      agent: "b",
      type: "invoke",
      kind: "work",
    });
    emitter.emit("agent:invoke", {
      agent: "a",
      type: "invoke",
      kind: "ci-fix",
    });
    emitter.emit("agent:invoke", { agent: "b", type: "invoke" });
    await log.close();

    const content = readLog(log.path);
    // Before stage:enter, "work" has no stage context.
    expect(content).toContain("[Pipeline] Invoking Agent A (work)");
    // After stage:enter, "work" includes stage name.
    expect(content).toContain("[Pipeline] Invoking Agent B (work: Implement)");
    // Non-work kinds are unchanged.
    expect(content).toContain("[Pipeline] Invoking Agent A (ci-fix)");
    // Without kind, no parenthetical suffix.
    expect(content).toMatch(/Invoking Agent B\n/);
  });

  test("logs stage:enter and stage:exit events", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());

    emitter.emit("stage:enter", {
      stageNumber: 2,
      stageName: "Implement",
      iteration: 0,
    });
    emitter.emit("stage:exit", { stageNumber: 2, outcome: "completed" });
    await log.close();

    const content = readLog(log.path);
    expect(content).toContain(
      "[Pipeline] Stage 2 (Implement) → enter (iteration 0)",
    );
    expect(content).toContain(
      "[Pipeline] Stage 2 (Implement) → exit (completed)",
    );
  });

  test("logs pipeline:verdict events", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());

    emitter.emit("pipeline:verdict", {
      agent: "a",
      keyword: "APPROVED",
      raw: "Looks good.\n\nAPPROVED",
    });
    await log.close();

    const content = readLog(log.path);
    expect(content).toContain(
      '[Pipeline] Agent A verdict parsed as "APPROVED"',
    );
  });

  test("logs pipeline:loop events", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());

    emitter.emit("pipeline:loop", {
      stageNumber: 3,
      stageName: "Self-check",
      remaining: 4,
      exhausted: false,
    });
    emitter.emit("pipeline:loop", {
      stageNumber: 3,
      stageName: "Self-check",
      remaining: 0,
      exhausted: true,
    });
    await log.close();

    const content = readLog(log.path);
    expect(content).toContain(
      "[Pipeline] Auto-budget 4 remaining for stage 3 (Self-check)",
    );
    expect(content).toContain(
      "[Pipeline] Auto-budget exhausted for stage 3 (Self-check)",
    );
  });

  test("logs pipeline:ci-poll events", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());

    emitter.emit("pipeline:ci-poll", { action: "start", sha: "abc1234" });
    emitter.emit("pipeline:ci-poll", {
      action: "status",
      verdict: "pending",
    });
    emitter.emit("pipeline:ci-poll", {
      action: "done",
      sha: "abc1234",
      verdict: "pass",
    });
    await log.close();

    const content = readLog(log.path);
    expect(content).toContain("[Pipeline] CI polling started (SHA: abc1234)");
    expect(content).toContain("[Pipeline] CI polling status: pending");
    expect(content).toContain("[Pipeline] CI polling done (verdict: pass)");
  });

  test("timestamps are present on event lines", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());

    emitter.emit("agent:chunk", { agent: "a", chunk: "tick" });
    await log.close();

    const content = readLog(log.path);
    expect(content).toMatch(/\[\d{2}:\d{2}:\d{2}\] \[Agent A\] tick/);
  });

  test("returns no-op writer when log directory cannot be created", async () => {
    // Point homedir at a path that cannot be created (a file, not a dir).
    const fs = require("node:fs");
    const blockerPath = `${TEST_HOME}/.agentcoop/logs`;
    fs.mkdirSync(`${TEST_HOME}/.agentcoop`, { recursive: true });
    fs.writeFileSync(blockerPath, "block");

    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());

    // Should return a no-op writer (empty path, close is safe to call).
    expect(log.path).toBe("");
    await log.close(); // must not throw

    fs.rmSync(blockerPath);
  });

  test("close writes footer", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());
    await log.close();

    const content = readLog(log.path);
    expect(content).toContain("[Pipeline] Log closed");
  });

  test("disables itself on write failure", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());
    expect(log.path).not.toBe("");

    // Destroy the underlying stream to simulate a disk I/O error.
    const stream = streamControl.streams.at(-1) as WriteStream;
    const closed = new Promise<void>((resolve) =>
      stream.once("close", resolve),
    );
    stream.destroy(new Error("simulated disk error"));
    await closed;

    // Subsequent emits must not throw — the writer is disabled.
    expect(() => {
      emitter.emit("agent:chunk", { agent: "a", chunk: "should not crash" });
    }).not.toThrow();

    // close() must not throw.
    await log.close();
  });

  test("avoids filename collision with exclusive create", async () => {
    const fs = require("node:fs");

    // Freeze time so both createRunLog calls produce the same timestamp,
    // deterministically forcing the EEXIST retry path.
    vi.useFakeTimers({ now: new Date("2026-06-01T12:00:00.000Z") });
    try {
      const emitter1 = new PipelineEventEmitter();
      const emitter2 = new PipelineEventEmitter();

      const log1 = createRunLog(emitter1, meta());
      expect(log1.path).not.toBe("");

      // The unsuffixed path is now taken; the second log must get a
      // collision on "wx" and retry with the "-1" suffix.
      const log2 = createRunLog(emitter2, meta());
      expect(log2.path).not.toBe("");
      expect(log2.path).not.toBe(log1.path);
      expect(log2.path).toMatch(/-1\.log$/);

      await log1.close();
      await log2.close();

      expect(fs.existsSync(log1.path)).toBe(true);
      expect(fs.existsSync(log2.path)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stage:name-override updates context for subsequent agent:invoke", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());

    // Enter the Done stage.
    emitter.emit("stage:enter", {
      stageNumber: 9,
      stageName: "Done",
      iteration: 0,
    });

    // Override to "Rebase" (as the pipeline does before invoking the rebase agent).
    emitter.emit("stage:name-override", { stageName: "Rebase" });

    // A "work" invoke should now show "Rebase", not "Done".
    emitter.emit("agent:invoke", {
      agent: "a",
      type: "invoke",
      kind: "work",
    });

    // Restore to "Done".
    emitter.emit("stage:name-override", { stageName: "Done" });

    emitter.emit("agent:invoke", {
      agent: "a",
      type: "invoke",
      kind: "work",
    });

    await log.close();

    const content = readLog(log.path);
    expect(content).toContain("[Pipeline] Stage name override → Rebase");
    expect(content).toContain("[Pipeline] Invoking Agent A (work: Rebase)");
    expect(content).toContain("[Pipeline] Stage name override → Done");
    expect(content).toContain("[Pipeline] Invoking Agent A (work: Done)");
  });

  test("multiline chunks produce separate prefixed lines", async () => {
    const emitter = new PipelineEventEmitter();
    const log = createRunLog(emitter, meta());

    emitter.emit("agent:chunk", {
      agent: "b",
      chunk: "line1\nline2\nline3",
    });
    await log.close();

    const content = readLog(log.path);
    expect(content).toContain("[Agent B] line1");
    expect(content).toContain("[Agent B] line2");
    expect(content).toContain("[Agent B] line3");
  });
});
