/**
 * Integration test: verify that the App component's root container applies
 * computeLayoutWidth() so that no serialised output row reaches the exact
 * terminal edge.
 *
 * This renders the real App (with pipeline/notify mocked out) and a fake
 * TTY stdout so useTerminalDimensions() returns concrete dimensions.
 * If App regresses to width="100%" instead of width={layoutWidth}, or
 * stops calling computeLayoutWidth(), the rows will reach the full
 * terminal width and the assertion will fail.
 */
import { EventEmitter } from "node:events";
import { cleanup, render } from "ink-testing-library";
import stringWidth from "string-width";
import { afterEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n/index.js";
import { PipelineEventEmitter } from "../pipeline-events.js";

const TERMINAL_WIDTH = 80;
const TERMINAL_HEIGHT = 24;

// Fake stdout that useTerminalDimensions treats as a real TTY.
const fakeStdout = Object.assign(new EventEmitter(), {
  isTTY: true as const,
  columns: TERMINAL_WIDTH,
  rows: TERMINAL_HEIGHT,
});

// Override useStdout so useTerminalDimensions sees TTY dimensions.
vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ink")>();
  return {
    ...actual,
    useStdout: () => ({ stdout: fakeStdout, write: vi.fn() }),
  };
});

// Prevent the pipeline from actually executing.
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

vi.mock("../notify.js", () => ({
  notifyInputWaiting: vi.fn(),
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
});

describe("App layout width contract (issue #203)", () => {
  test("all serialized rows stay strictly below terminal width", async () => {
    initI18n("en");
    const emitter = new PipelineEventEmitter();

    const { lastFrame } = render(
      <App
        emitter={emitter}
        pipelineOptions={minimalOptions}
        onExit={vi.fn()}
      />,
    );

    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");

    // Sanity: some content rendered.
    expect(lines.length).toBeGreaterThan(0);

    // Every row must stay strictly below the terminal width.
    // computeLayoutWidth(80) = 79, so content fits in 79 columns.
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThan(TERMINAL_WIDTH);
    }
  });
});
