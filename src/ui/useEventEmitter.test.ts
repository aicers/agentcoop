/**
 * Tests for the useAgentLines hook logic.  Since React hooks cannot be
 * invoked outside a component, we test the underlying event-driven
 * accumulation pattern by simulating what the hook does: subscribe to
 * PipelineEventEmitter events and accumulate chunks into lines.
 */
import { describe, expect, test } from "vitest";
import { PipelineEventEmitter } from "../pipeline-events.js";
import {
  formatPromptForDisplay,
  PROMPT_LINE_PREFIX,
  PROMPT_SEPARATOR_CHAR,
} from "./useEventEmitter.js";

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

describe("formatPromptForDisplay", () => {
  test("formats a short prompt with separator and prefix", () => {
    const lines = formatPromptForDisplay("Hello\nWorld");

    // First line is separator with "Prompt" label
    expect(lines[0]).toContain("Prompt");
    expect(lines[0]).toContain(PROMPT_SEPARATOR_CHAR);
    // Content lines are prefixed
    expect(lines[1]).toBe(`${PROMPT_LINE_PREFIX}Hello`);
    expect(lines[2]).toBe(`${PROMPT_LINE_PREFIX}World`);
    // Last line is closing separator
    expect(lines[lines.length - 1]).toContain(PROMPT_SEPARATOR_CHAR);
  });

  test("footer length matches header length", () => {
    const lines = formatPromptForDisplay("Hello");
    const header = lines[0];
    const footer = lines[lines.length - 1];

    expect(footer).toBeDefined();
    expect(footer).toHaveLength(header.length);
    // Footer should be all separator chars
    expect(footer).toBe(PROMPT_SEPARATOR_CHAR.repeat(header.length));
  });

  test("footer length matches header length with stage name", () => {
    const lines = formatPromptForDisplay("Hello", "Create PR");
    const header = lines[0];
    const footer = lines[lines.length - 1];

    expect(footer).toBeDefined();
    expect(footer).toHaveLength(header.length);
    expect(footer).toBe(PROMPT_SEPARATOR_CHAR.repeat(header.length));
  });

  test("includes stage name in header when provided", () => {
    const lines = formatPromptForDisplay("Hello", "Self-check");

    expect(lines[0]).toContain("Prompt (Self-check)");
  });

  test("omits stage name from header when not provided", () => {
    const lines = formatPromptForDisplay("Hello");

    expect(lines[0]).toContain(" Prompt ");
    expect(lines[0]).not.toContain("(");
  });

  test("truncates long prompts to 8 lines with remainder count", () => {
    const prompt = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const lines = formatPromptForDisplay(prompt);

    // 1 header + 8 content + 1 truncation notice + 1 footer = 11
    expect(lines).toHaveLength(11);
    // First content line
    expect(lines[1]).toBe(`${PROMPT_LINE_PREFIX}line 0`);
    // Last content line shown
    expect(lines[8]).toBe(`${PROMPT_LINE_PREFIX}line 7`);
    // Truncation indicator
    expect(lines[9]).toContain("12 more lines");
  });

  test("does not truncate prompt with exactly 8 lines", () => {
    const prompt = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
    const lines = formatPromptForDisplay(prompt);

    // 1 header + 8 content + 1 footer = 10, no truncation line
    expect(lines).toHaveLength(10);
    expect(lines.join("\n")).not.toContain("more lines");
  });

  test("handles single-line prompt", () => {
    const lines = formatPromptForDisplay("Do the thing");

    expect(lines[1]).toBe(`${PROMPT_LINE_PREFIX}Do the thing`);
    expect(lines).toHaveLength(3); // header + 1 line + footer
  });
});

describe("agent:prompt integration with line accumulator", () => {
  test("prompt lines are injected into the accumulator", () => {
    const emitter = new PipelineEventEmitter();
    const acc = createLineAccumulator(emitter, "a");

    // Simulate agent:prompt by manually injecting formatted lines
    // (mirrors what the hook does).
    emitter.emit("agent:chunk", { agent: "a", chunk: "output\n" });

    const formatted = formatPromptForDisplay("hello");
    // Inject formatted lines as if the hook did it.
    for (const line of formatted) {
      emitter.emit("agent:chunk", { agent: "a", chunk: `${line}\n` });
    }

    const lines = acc.getLines();
    expect(lines[0]).toBe("output");
    expect(lines[1]).toContain("Prompt");
    expect(lines[2]).toBe(`${PROMPT_LINE_PREFIX}hello`);

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
