/**
 * App-level tests that verify dispatch() triggers notifications when
 * entering the input-wait state.
 */
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n/index.js";
import type { UserPrompt } from "../pipeline.js";
import { PipelineEventEmitter } from "../pipeline-events.js";

// Mock runPipeline so it never actually executes.
vi.mock("../pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline.js")>();
  return {
    ...actual,
    runPipeline: vi.fn(async () => ({
      success: true,
      stoppedAt: undefined,
      message: "",
    })),
  };
});

// Spy on notifyInputWaiting.
const notifyInputWaitingSpy = vi.fn();
vi.mock("../notify.js", () => ({
  notifyInputWaiting: (...args: unknown[]) => notifyInputWaitingSpy(...args),
}));

const { App } = await import("./App.js");

const minimalOptions = {
  context: {
    owner: "test",
    repo: "repo",
    issueNumber: 1,
    baseSha: "abc",
  },
} as never;

afterEach(() => {
  cleanup();
  notifyInputWaitingSpy.mockClear();
});

describe("App dispatch notifications", () => {
  test("calls notifyInputWaiting when dispatch enters input-wait state", async () => {
    initI18n("en");
    const emitter = new PipelineEventEmitter();
    let capturedPrompt: UserPrompt | undefined;

    render(
      <App
        emitter={emitter}
        pipelineOptions={minimalOptions}
        onExit={vi.fn()}
        onPromptReady={(prompt) => {
          capturedPrompt = prompt;
        }}
        notifications={{ bell: true, desktop: false }}
      />,
    );

    // Wait for the useEffect to run and call onPromptReady.
    await vi.waitFor(() => {
      expect(capturedPrompt).toBeDefined();
    });

    // Call a prompt method that dispatches an InputRequest.
    // Don't await — dispatch returns a Promise that resolves on user submit,
    // but notifyInputWaiting fires synchronously in the Promise constructor.
    capturedPrompt?.confirmNextStage("CI check");

    expect(notifyInputWaitingSpy).toHaveBeenCalledOnce();
    expect(notifyInputWaitingSpy).toHaveBeenCalledWith(
      { bell: true, desktop: false },
      expect.stringContaining("CI check"),
    );
  });

  test("renders PR segment after pr:resolved event", async () => {
    initI18n("en");
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <App
        emitter={emitter}
        pipelineOptions={minimalOptions}
        onExit={vi.fn()}
      />,
    );

    // Before the event, no PR segment is rendered.
    await vi.waitFor(() => {
      expect(lastFrame() ?? "").not.toContain("PR: #");
    });

    emitter.emit("pr:resolved", { prNumber: 523 });

    await vi.waitFor(() => {
      expect(lastFrame() ?? "").toContain("PR: #523");
    });
  });

  test("seeds PR segment from initialPrNumber on resume", async () => {
    initI18n("en");
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <App
        emitter={emitter}
        pipelineOptions={minimalOptions}
        onExit={vi.fn()}
        initialPrNumber={42}
      />,
    );

    await vi.waitFor(() => {
      expect(lastFrame() ?? "").toContain("PR: #42");
    });
  });

  test("does not call notifyInputWaiting when notifications prop is undefined", async () => {
    initI18n("en");
    const emitter = new PipelineEventEmitter();
    let capturedPrompt: UserPrompt | undefined;

    render(
      <App
        emitter={emitter}
        pipelineOptions={minimalOptions}
        onExit={vi.fn()}
        onPromptReady={(prompt) => {
          capturedPrompt = prompt;
        }}
      />,
    );

    await vi.waitFor(() => {
      expect(capturedPrompt).toBeDefined();
    });

    capturedPrompt?.confirmNextStage("CI check");

    expect(notifyInputWaitingSpy).not.toHaveBeenCalled();
  });
});
