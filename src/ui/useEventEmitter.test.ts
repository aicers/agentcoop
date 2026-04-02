/**
 * Tests for the useAgentLines hook logic.  Since React hooks cannot be
 * invoked outside a component, we test the underlying event-driven
 * accumulation pattern by simulating what the hook does: subscribe to
 * PipelineEventEmitter events and accumulate chunks into lines.
 */
import { describe, expect, test } from "vitest";
import { PipelineEventEmitter } from "../pipeline-events.js";

// ---- line accumulation logic (mirrors useAgentLines) -------------------------

/**
 * Simplified version of the hook's accumulation logic, extracted for
 * testability without React.
 */
function createLineAccumulator(
  emitter: PipelineEventEmitter,
  agent: "a" | "b",
  maxLines = 500,
) {
  let buffer = "";
  let lines: string[] = [];

  const handler = (ev: { agent: "a" | "b"; chunk: string }) => {
    if (ev.agent !== agent) return;
    buffer += ev.chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    if (parts.length === 0) return;
    const next = [...lines, ...parts];
    lines = next.length > maxLines ? next.slice(-maxLines) : next;
  };

  emitter.on("agent:chunk", handler);

  return {
    getLines: () => lines,
    getBuffer: () => buffer,
    cleanup: () => emitter.off("agent:chunk", handler),
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
