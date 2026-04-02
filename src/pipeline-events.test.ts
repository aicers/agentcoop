import { describe, expect, test, vi } from "vitest";
import {
  type AgentChunkEvent,
  type AgentInvokeEvent,
  PipelineEventEmitter,
  type StageEnterEvent,
  type StageExitEvent,
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
});
