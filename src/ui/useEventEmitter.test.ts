/**
 * Tests for the useAgentLines hook logic.  Since React hooks cannot be
 * invoked outside a component, we test the underlying event-driven
 * accumulation pattern by simulating what the hook does: subscribe to
 * PipelineEventEmitter events and accumulate chunks into lines.
 */
import { describe, expect, test } from "vitest";
import type {
  AgentInvokeEvent,
  PipelineCiPollEvent,
  PipelineLoopEvent,
  PipelineVerdictEvent,
  StageEnterEvent,
  StageExitEvent,
} from "../pipeline-events.js";
import { PipelineEventEmitter } from "../pipeline-events.js";
import type {
  DiagnosticBlock,
  LineEntry,
  PromptBlock,
} from "./useEventEmitter.js";

// ---- line accumulation logic (mirrors useAgentLines) -------------------------

/**
 * Simplified version of the hook's accumulation logic, extracted for
 * testability without React.  Handles both chunk and prompt events,
 * storing prompt events as structured PromptBlock objects.
 */
function createLineAccumulator(
  emitter: PipelineEventEmitter,
  agent: "a" | "b",
  maxLines = 500,
) {
  let buffer = "";
  let lines: LineEntry[] = [];
  let stageName: string | undefined;
  const handlers: Array<{ event: string; fn: (...args: unknown[]) => void }> =
    [];

  function on<T>(event: string, fn: (ev: T) => void) {
    emitter.on(event as "agent:chunk", fn as never);
    handlers.push({ event, fn: fn as (...args: unknown[]) => void });
  }

  function push(block: DiagnosticBlock | PromptBlock) {
    const next: LineEntry[] = [...lines, block];
    lines = next.length > maxLines ? next.slice(-maxLines) : next;
  }

  function pushDiagnostic(message: string, global?: boolean) {
    // Flush any pending partial line before inserting the diagnostic
    // so it appears in the correct chronological position (mirrors
    // the real hook's pushDiagnostic logic).
    const base: DiagnosticBlock = {
      kind: "diagnostic",
      timestamp: "00:00:00",
      message,
      ...(global ? { global: true } : {}),
    };
    if (buffer) {
      const pending = buffer;
      buffer = "";
      const next: LineEntry[] = [...lines, pending, base];
      lines = next.length > maxLines ? next.slice(-maxLines) : next;
    } else {
      // Deduplicate consecutive identical diagnostics (mirrors
      // the real hook's deduplication logic).
      const last = lines.length > 0 ? lines[lines.length - 1] : undefined;
      if (
        last != null &&
        typeof last !== "string" &&
        last.kind === "diagnostic" &&
        last.message === message &&
        (last.global ?? false) === (global ?? false)
      ) {
        const updated: DiagnosticBlock = {
          ...last,
          timestamp: "00:00:00",
          count: (last.count ?? 1) + 1,
        };
        lines = [...lines.slice(0, -1), updated];
        return;
      }
      push(base);
    }
  }

  on<{ agent: "a" | "b"; chunk: string }>("agent:chunk", (ev) => {
    if (ev.agent !== agent) return;
    buffer += ev.chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    if (parts.length === 0) return;
    const next: LineEntry[] = [...lines, ...parts];
    lines = next.length > maxLines ? next.slice(-maxLines) : next;
  });

  on<{ agent: "a" | "b"; prompt: string }>("agent:prompt", (ev) => {
    if (ev.agent !== agent) return;
    const block: PromptBlock = { kind: "prompt", prompt: ev.prompt, stageName };
    if (buffer) {
      const pending = buffer;
      buffer = "";
      const next: LineEntry[] = [...lines, pending, block];
      lines = next.length > maxLines ? next.slice(-maxLines) : next;
    } else {
      push(block);
    }
  });

  // Buffer exit events and merge with the following enter to produce a
  // single transition line (mirrors the real hook's pendingExitRef logic).
  let pendingExit: {
    stageNumber: number;
    stageName: string | undefined;
    outcome: string;
  } | null = null;

  on<StageExitEvent>("stage:exit", (ev) => {
    pendingExit = {
      stageNumber: ev.stageNumber,
      stageName,
      outcome: ev.outcome,
    };
  });

  on<StageEnterEvent>("stage:enter", (ev) => {
    const pending = pendingExit;
    pendingExit = null;
    if (pending) {
      const from = pending.stageName
        ? `Stage ${pending.stageNumber} (${pending.stageName})`
        : `Stage ${pending.stageNumber}`;
      pushDiagnostic(
        `${from} → Stage ${ev.stageNumber} (${ev.stageName}) [outcome: ${pending.outcome}]`,
        true,
      );
    } else {
      pushDiagnostic(
        `Entering Stage ${ev.stageNumber} (${ev.stageName})`,
        true,
      );
    }
    stageName = ev.stageName;
  });

  on<PipelineVerdictEvent>("pipeline:verdict", (ev) => {
    if (ev.agent !== agent) return;
    pushDiagnostic(`Reviewer verdict parsed as "${ev.keyword}"`);
  });

  on<PipelineLoopEvent>("pipeline:loop", (ev) => {
    if (ev.agent !== undefined && ev.agent !== agent) return;
    if (ev.exhausted) {
      pushDiagnostic(`${ev.stageName} auto-budget exhausted`);
    } else {
      pushDiagnostic(
        `${ev.stageName} auto-budget ${ev.remaining}/${ev.budget} remaining`,
      );
    }
  });

  on<PipelineCiPollEvent>("pipeline:ci-poll", (ev) => {
    if (agent !== "a") return;
    if (ev.action === "start") {
      const sha = ev.sha ? ` (SHA: ${ev.sha.slice(0, 7)})` : "";
      pushDiagnostic(`CI polling started${sha}`);
    } else if (ev.action === "status") {
      const verdict = ev.verdict ? `: ${ev.verdict}` : "";
      pushDiagnostic(`CI poll status${verdict}`);
    } else {
      const verdict = ev.verdict ? `: ${ev.verdict}` : "";
      pushDiagnostic(`CI polling done${verdict}`);
    }
  });

  on<AgentInvokeEvent>("agent:invoke", (ev) => {
    if (ev.agent !== agent) return;
    const kindLabels: Record<string, string> = {
      work: "work prompt",
      review: "review prompt",
      "verdict-followup": "verdict follow-up",
      "ci-fix": "CI fix prompt",
      summary: "summary request",
    };
    const label = agent === "a" ? "Agent A" : "Agent B";
    const action = ev.type === "invoke" ? "Invoking" : "Resuming";
    const kindLabel = ev.kind ? (kindLabels[ev.kind] ?? ev.kind) : "";
    const roundSuffix = ev.round != null ? ` (round ${ev.round})` : "";
    const context = kindLabel ? ` with ${kindLabel}${roundSuffix}` : "";
    pushDiagnostic(`${action} ${label}${context}`);
  });

  return {
    getLines: () => lines,
    getBuffer: () => buffer,
    pushDiagnostic,
    cleanup: () => {
      for (const { event, fn } of handlers) {
        emitter.off(event as "agent:chunk", fn as never);
      }
    },
  };
}

// ---- tests -------------------------------------------------------------------

describe("line accumulation (useAgentLines logic)", () => {
  test("splits chunks into lines on newline boundaries", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "line1\nline2\n" });

    expect(acc.getLines()).toEqual(["line1", "line2"]);
    expect(acc.getBuffer()).toBe("");
  });

  test("buffers incomplete lines until next newline", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "partial" });
    expect(acc.getLines()).toEqual([]);
    expect(acc.getBuffer()).toBe("partial");

    emitter.emit("agent:chunk", { agent: "a", chunk: " data\n" });
    expect(acc.getLines()).toEqual(["partial data"]);
  });

  test("accumulates across multiple chunks", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "a\nb\n" });
    emitter.emit("agent:chunk", { agent: "a", chunk: "c\nd\n" });

    expect(acc.getLines()).toEqual(["a", "b", "c", "d"]);
  });

  test("ignores chunks from other agent", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "b", chunk: "other\n" });
    emitter.emit("agent:chunk", { agent: "a", chunk: "mine\n" });

    expect(acc.getLines()).toEqual(["mine"]);
  });

  test("caps at maxLines", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a", 3);

    emitter.emit("agent:chunk", {
      agent: "a",
      chunk: "1\n2\n3\n4\n5\n",
    });

    expect(acc.getLines()).toEqual(["3", "4", "5"]);
  });

  test("cleanup removes listener", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "before\n" });
    acc.cleanup();
    emitter.emit("agent:chunk", { agent: "a", chunk: "after\n" });

    expect(acc.getLines()).toEqual(["before"]);
  });

  test("handles chunk with only newlines", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "\n\n\n" });

    expect(acc.getLines()).toEqual(["", "", ""]);
  });

  test("handles empty chunk gracefully", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "" });

    expect(acc.getLines()).toEqual([]);
  });

  test("pending buffer is available for display (unterminated chunks)", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "partial token" });

    // No completed lines yet, but buffer holds the partial text.
    expect(acc.getLines()).toEqual([]);
    expect(acc.getBuffer()).toBe("partial token");
  });

  test("pending buffer clears when newline arrives", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "start" });
    expect(acc.getBuffer()).toBe("start");

    emitter.emit("agent:chunk", { agent: "a", chunk: " end\n" });
    expect(acc.getBuffer()).toBe("");
    expect(acc.getLines()).toEqual(["start end"]);
  });

  test("pending buffer survives across multiple partial chunks", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "one " });
    emitter.emit("agent:chunk", { agent: "a", chunk: "two " });
    emitter.emit("agent:chunk", { agent: "a", chunk: "three" });

    expect(acc.getLines()).toEqual([]);
    expect(acc.getBuffer()).toBe("one two three");
  });
});

describe("agent:prompt integration with line accumulator", () => {
  test("prompt events are stored as structured PromptBlock objects", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "output\n" });
    emitter.emit("stage:enter", {
      stageNumber: 1,
      stageName: "Implement",
      iteration: 0,
    });
    emitter.emit("agent:prompt", { agent: "a", prompt: "hello", kind: "work" });

    const lines = acc.getLines();
    expect(lines[0]).toBe("output");
    // stage:enter also produces a diagnostic block
    expect(lines[1]).toMatchObject({ kind: "diagnostic" });
    expect(lines[2]).toEqual({
      kind: "prompt",
      prompt: "hello",
      stageName: "Implement",
    });

    acc.cleanup();
  });

  test("prompt block flushes pending buffer first", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "partial" });
    expect(acc.getBuffer()).toBe("partial");

    emitter.emit("agent:prompt", {
      agent: "a",
      prompt: "question",
      kind: "work",
    });

    const lines = acc.getLines();
    expect(lines[0]).toBe("partial");
    expect(lines[1]).toEqual({
      kind: "prompt",
      prompt: "question",
      stageName: undefined,
    });
    expect(acc.getBuffer()).toBe("");

    acc.cleanup();
  });

  test("prompt block without prior stage has undefined stageName", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:prompt", { agent: "a", prompt: "hi", kind: "work" });

    const lines = acc.getLines();
    expect(lines[0]).toEqual({
      kind: "prompt",
      prompt: "hi",
      stageName: undefined,
    });

    acc.cleanup();
  });

  test("prompt events for other agents are ignored", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:prompt", {
      agent: "b",
      prompt: "not mine",
      kind: "work",
    });

    expect(acc.getLines()).toEqual([]);

    acc.cleanup();
  });
});

describe("event subscription patterns", () => {
  test("receives stage:enter events", () => {
    const emitter = new PipelineEventEmitter();
    const received: unknown[] = [];

    emitter.on("stage:enter", (ev) => received.push(ev));

    emitter.emit("stage:enter", {
      stageNumber: 3,
      stageName: "Self-check",
      iteration: 1,
    });

    expect(received).toEqual([
      { stageNumber: 3, stageName: "Self-check", iteration: 1 },
    ]);
  });

  test("receives stage:exit events", () => {
    const emitter = new PipelineEventEmitter();
    const received: unknown[] = [];

    emitter.on("stage:exit", (ev) => received.push(ev));

    emitter.emit("stage:exit", { stageNumber: 3, outcome: "completed" });

    expect(received).toEqual([{ stageNumber: 3, outcome: "completed" }]);
  });

  test("agent:chunk events for different agents are isolated", () => {
    const emitter = new PipelineEventEmitter();
    const accA = createLineAccumulator(emitter, "a");
    const accB = createLineAccumulator(emitter, "b");

    emitter.emit("agent:chunk", { agent: "a", chunk: "from-a\n" });
    emitter.emit("agent:chunk", { agent: "b", chunk: "from-b\n" });

    expect(accA.getLines()).toEqual(["from-a"]);
    expect(accB.getLines()).toEqual(["from-b"]);

    accA.cleanup();
    accB.cleanup();
  });
});

describe("diagnostic event routing", () => {
  function diagnostics(lines: LineEntry[]): DiagnosticBlock[] {
    return lines.filter(
      (l): l is DiagnosticBlock =>
        typeof l !== "string" && l.kind === "diagnostic",
    );
  }

  test("pipeline:verdict routes to the agent that produced it", () => {
    const emitter = new PipelineEventEmitter();
    const accA = createLineAccumulator(emitter, "a");
    const accB = createLineAccumulator(emitter, "b");

    emitter.emit("pipeline:verdict", {
      agent: "b",
      keyword: "APPROVED",
      raw: "APPROVED",
    });

    expect(diagnostics(accA.getLines())).toEqual([]);
    const bDiags = diagnostics(accB.getLines());
    expect(bDiags).toHaveLength(1);
    expect(bDiags[0].message).toBe('Reviewer verdict parsed as "APPROVED"');

    accA.cleanup();
    accB.cleanup();
  });

  test("stage:enter and stage:exit combine into a single transition line", () => {
    const emitter = new PipelineEventEmitter();
    const accA = createLineAccumulator(emitter, "a");
    const accB = createLineAccumulator(emitter, "b");

    emitter.emit("stage:enter", {
      stageNumber: 7,
      stageName: "Review",
      iteration: 0,
    });
    emitter.emit("stage:exit", { stageNumber: 7, outcome: "completed" });
    emitter.emit("stage:enter", {
      stageNumber: 8,
      stageName: "Squash",
      iteration: 0,
    });

    for (const acc of [accA, accB]) {
      const diags = diagnostics(acc.getLines());
      expect(diags).toHaveLength(2);
      expect(diags[0].message).toBe("Entering Stage 7 (Review)");
      expect(diags[0].global).toBe(true);
      expect(diags[1].message).toBe(
        "Stage 7 (Review) → Stage 8 (Squash) [outcome: completed]",
      );
      expect(diags[1].global).toBe(true);
    }

    accA.cleanup();
    accB.cleanup();
  });

  test("pipeline:loop shows remaining/total budget in the owning pane", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "b");

    emitter.emit("pipeline:loop", {
      stageNumber: 7,
      stageName: "Review",
      remaining: 4,
      budget: 5,
      exhausted: false,
      agent: "b",
    });

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("Review auto-budget 4/5 remaining");

    acc.cleanup();
  });

  test("pipeline:loop shows exhausted message", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "b");

    emitter.emit("pipeline:loop", {
      stageNumber: 7,
      stageName: "Review",
      remaining: 0,
      budget: 5,
      exhausted: true,
      agent: "b",
    });

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("Review auto-budget exhausted");

    acc.cleanup();
  });

  test("pipeline:loop does not appear in the non-owning pane", () => {
    const emitter = new PipelineEventEmitter();
    const accA = createLineAccumulator(emitter, "a");
    const accB = createLineAccumulator(emitter, "b");

    emitter.emit("pipeline:loop", {
      stageNumber: 7,
      stageName: "Review",
      remaining: 3,
      budget: 5,
      exhausted: false,
      agent: "b",
    });

    // Agent B owns the loop — should receive the diagnostic.
    expect(diagnostics(accB.getLines())).toHaveLength(1);
    // Agent A should not receive it.
    expect(diagnostics(accA.getLines())).toHaveLength(0);

    accA.cleanup();
    accB.cleanup();
  });

  test("pipeline:ci-poll routes only to agent A", () => {
    const emitter = new PipelineEventEmitter();
    const accA = createLineAccumulator(emitter, "a");
    const accB = createLineAccumulator(emitter, "b");

    emitter.emit("pipeline:ci-poll", {
      action: "start",
      sha: "abc1234567890",
    });

    const aDiags = diagnostics(accA.getLines());
    expect(aDiags).toHaveLength(1);
    expect(aDiags[0].message).toBe("CI polling started (SHA: abc1234)");

    // Agent B should not receive ci-poll diagnostics
    const bDiags = diagnostics(accB.getLines());
    expect(bDiags).toHaveLength(0);

    accA.cleanup();
    accB.cleanup();
  });

  test("pipeline:ci-poll status includes verdict when present", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("pipeline:ci-poll", {
      action: "status",
      verdict: "pending",
    });

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("CI poll status: pending");

    acc.cleanup();
  });

  test("pipeline:ci-poll status without verdict", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("pipeline:ci-poll", { action: "status" });

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("CI poll status");

    acc.cleanup();
  });

  test("pipeline:ci-poll start without SHA", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("pipeline:ci-poll", { action: "start" });

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("CI polling started");

    acc.cleanup();
  });

  test("pipeline:ci-poll done includes verdict", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("pipeline:ci-poll", {
      action: "done",
      sha: "abc",
      verdict: "pass",
    });

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("CI polling done: pass");

    acc.cleanup();
  });

  test("agent:invoke routes to the target agent's pane with kind context", () => {
    const emitter = new PipelineEventEmitter();
    const accA = createLineAccumulator(emitter, "a");
    const accB = createLineAccumulator(emitter, "b");

    emitter.emit("agent:invoke", {
      agent: "b",
      type: "invoke",
      kind: "work",
    });

    const aDiags = diagnostics(accA.getLines());
    expect(aDiags).toHaveLength(0);

    const bDiags = diagnostics(accB.getLines());
    expect(bDiags).toHaveLength(1);
    expect(bDiags[0].message).toBe("Invoking Agent B with work prompt");

    accA.cleanup();
    accB.cleanup();
  });

  test("agent:invoke resume produces correct message with kind", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:invoke", {
      agent: "a",
      type: "resume",
      kind: "verdict-followup",
    });

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("Resuming Agent A with verdict follow-up");

    acc.cleanup();
  });

  test("agent:invoke review kind includes round", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "b");

    emitter.emit("agent:invoke", {
      agent: "b",
      type: "invoke",
      kind: "review",
      round: 2,
    });

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe(
      "Invoking Agent B with review prompt (round 2)",
    );

    acc.cleanup();
  });

  test("agent:invoke without kind falls back to generic message", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "b");

    emitter.emit("agent:invoke", { agent: "b", type: "invoke" });

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("Invoking Agent B");

    acc.cleanup();
  });

  test("diagnostic blocks are capped by maxLines", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a", 2);

    emitter.emit("agent:chunk", { agent: "a", chunk: "line1\n" });
    emitter.emit("pipeline:verdict", {
      agent: "a",
      keyword: "BLOCKED",
      raw: "BLOCKED",
    });
    emitter.emit("pipeline:verdict", {
      agent: "a",
      keyword: "APPROVED",
      raw: "APPROVED",
    });

    // maxLines = 2: should keep only the last two entries
    expect(acc.getLines()).toHaveLength(2);

    acc.cleanup();
  });

  test("diagnostic arriving mid-chunk flushes the partial buffer first", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("agent:chunk", { agent: "a", chunk: "partial" });
    expect(acc.getBuffer()).toBe("partial");

    emitter.emit("pipeline:verdict", {
      agent: "a",
      keyword: "APPROVED",
      raw: "APPROVED",
    });

    const lines = acc.getLines();
    // The partial text should be flushed as a plain string line
    // before the diagnostic block.
    expect(lines[0]).toBe("partial");
    expect(lines[1]).toMatchObject({
      kind: "diagnostic",
      message: 'Reviewer verdict parsed as "APPROVED"',
    });
    expect(acc.getBuffer()).toBe("");

    acc.cleanup();
  });

  test("consecutive identical diagnostics are collapsed with count", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    // Emit three identical CI poll status events.
    emitter.emit("pipeline:ci-poll", { action: "status", verdict: "pending" });
    emitter.emit("pipeline:ci-poll", { action: "status", verdict: "pending" });
    emitter.emit("pipeline:ci-poll", { action: "status", verdict: "pending" });

    const lines = acc.getLines();
    // Should collapse to a single diagnostic entry with count 3.
    expect(lines).toHaveLength(1);
    const diag = lines[0] as DiagnosticBlock;
    expect(diag.kind).toBe("diagnostic");
    expect(diag.message).toBe("CI poll status: pending");
    expect(diag.count).toBe(3);

    acc.cleanup();
  });

  test("non-consecutive identical diagnostics are not collapsed", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("pipeline:ci-poll", { action: "status", verdict: "pending" });
    emitter.emit("agent:chunk", { agent: "a", chunk: "some output\n" });
    emitter.emit("pipeline:ci-poll", { action: "status", verdict: "pending" });

    const diags = diagnostics(acc.getLines());
    // Separated by a chunk line, so they should be two distinct entries.
    expect(diags).toHaveLength(2);
    expect(diags[0].count).toBeUndefined();
    expect(diags[1].count).toBeUndefined();

    acc.cleanup();
  });

  test("different consecutive diagnostics are not collapsed", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("pipeline:ci-poll", { action: "status", verdict: "pending" });
    emitter.emit("pipeline:ci-poll", { action: "status", verdict: "pass" });

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(2);
    expect(diags[0].message).toBe("CI poll status: pending");
    expect(diags[1].message).toBe("CI poll status: pass");

    acc.cleanup();
  });

  test("global and non-global diagnostics with same message are not collapsed", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    // Push a global diagnostic, then a non-global one with the exact
    // same message text.  The dedup condition at useEventEmitter.ts:188
    // must keep them as separate entries.
    acc.pushDiagnostic("same message", true);
    acc.pushDiagnostic("same message");

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(2);
    expect(diags[0].global).toBe(true);
    expect(diags[0].count).toBeUndefined();
    expect(diags[1].global).toBeUndefined();
    expect(diags[1].count).toBeUndefined();

    acc.cleanup();
  });

  test("deduplication after partial chunk flush produces separate entries", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    emitter.emit("pipeline:ci-poll", { action: "status", verdict: "pending" });
    // Emit a partial chunk then an identical diagnostic — the flush
    // breaks the consecutive sequence, so they should not be collapsed.
    emitter.emit("agent:chunk", { agent: "a", chunk: "partial" });
    emitter.emit("pipeline:ci-poll", { action: "status", verdict: "pending" });

    const diags = diagnostics(acc.getLines());
    expect(diags).toHaveLength(2);
    expect(diags[0].count).toBeUndefined();
    expect(diags[1].count).toBeUndefined();

    acc.cleanup();
  });
});
