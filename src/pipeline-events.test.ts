import { describe, expect, test, vi } from "vitest";
import {
  type AgentChunkEvent,
  type AgentInvokeEvent,
  type AgentPromptEvent,
  type AgentUsageEvent,
  type PipelineCiPollEvent,
  PipelineEventEmitter,
  type PipelineLoopEvent,
  type PipelineVerdictEvent,
  type StageEnterEvent,
  type StageExitEvent,
  type StageNameOverrideEvent,
} from "./pipeline-events.js";

describe("PipelineEventEmitter", () => {
  test("emits and receives agent:chunk events", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("agent:chunk", handler);

    const event: AgentChunkEvent = { agent: "a", chunk: "hello" };
    emitter.emit("agent:chunk", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("emits and receives stage:enter events", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("stage:enter", handler);

    const event: StageEnterEvent = {
      stageNumber: 2,
      stageName: "Implement",
      iteration: 0,
    };
    emitter.emit("stage:enter", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("emits and receives stage:exit events", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("stage:exit", handler);

    const event: StageExitEvent = { stageNumber: 2, outcome: "completed" };
    emitter.emit("stage:exit", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("emits and receives agent:invoke events", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("agent:invoke", handler);

    const event: AgentInvokeEvent = { agent: "b", type: "resume" };
    emitter.emit("agent:invoke", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("emits and receives agent:prompt events", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("agent:prompt", handler);

    const event: AgentPromptEvent = {
      agent: "a",
      prompt: "Do the thing",
      kind: "work",
    };
    emitter.emit("agent:prompt", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("supports multiple listeners for the same event", () => {
    const emitter = new PipelineEventEmitter();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    emitter.on("agent:chunk", handler1);
    emitter.on("agent:chunk", handler2);

    const event: AgentChunkEvent = { agent: "a", chunk: "data" };
    emitter.emit("agent:chunk", event);

    expect(handler1).toHaveBeenCalledWith(event);
    expect(handler2).toHaveBeenCalledWith(event);
  });

  test("off removes listener", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("agent:chunk", handler);
    emitter.off("agent:chunk", handler);

    emitter.emit("agent:chunk", { agent: "a", chunk: "data" });

    expect(handler).not.toHaveBeenCalled();
  });

  test("emits and receives agent:usage events", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("agent:usage", handler);

    const event: AgentUsageEvent = {
      agent: "a",
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 },
    };
    emitter.emit("agent:usage", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("emits and receives stage:name-override events", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("stage:name-override", handler);

    const event: StageNameOverrideEvent = { stageName: "Rebase" };
    emitter.emit("stage:name-override", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("different event types do not interfere", () => {
    const emitter = new PipelineEventEmitter();
    const chunkHandler = vi.fn();
    const enterHandler = vi.fn();
    emitter.on("agent:chunk", chunkHandler);
    emitter.on("stage:enter", enterHandler);

    emitter.emit("agent:chunk", { agent: "a", chunk: "x" });

    expect(chunkHandler).toHaveBeenCalledTimes(1);
    expect(enterHandler).not.toHaveBeenCalled();
  });

  test("emits and receives agent:prompt events with kind", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("agent:prompt", handler);

    const event: AgentPromptEvent = {
      agent: "a",
      prompt: "Fix it",
      kind: "ci-fix",
    };
    emitter.emit("agent:prompt", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("emits and receives pipeline:verdict events", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("pipeline:verdict", handler);

    const event: PipelineVerdictEvent = {
      agent: "a",
      keyword: "COMPLETED",
      raw: "All done.\n\nCOMPLETED",
    };
    emitter.emit("pipeline:verdict", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("emits and receives pipeline:loop events", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("pipeline:loop", handler);

    const event: PipelineLoopEvent = {
      stageNumber: 2,
      stageName: "Implement",
      remaining: 1,
      budget: 3,
      exhausted: false,
    };
    emitter.emit("pipeline:loop", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("emits and receives pipeline:ci-poll events", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("pipeline:ci-poll", handler);

    const event: PipelineCiPollEvent = {
      action: "start",
      sha: "abc123",
    };
    emitter.emit("pipeline:ci-poll", event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  test("pipeline:ci-poll done event includes verdict", () => {
    const emitter = new PipelineEventEmitter();
    const handler = vi.fn();
    emitter.on("pipeline:ci-poll", handler);

    const event: PipelineCiPollEvent = {
      action: "done",
      sha: "abc123",
      verdict: "pass",
    };
    emitter.emit("pipeline:ci-poll", event);

    expect(handler).toHaveBeenCalledWith(event);
  });
});
