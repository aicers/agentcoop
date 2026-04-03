/**
 * Component rendering tests for the split-pane TUI.
 *
 * Uses ink-testing-library to render ink components in a test
 * environment and assert on the terminal output frames.
 */
import { Box } from "ink";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, test } from "vitest";
import { PipelineEventEmitter } from "../pipeline-events.js";
import { AgentPane } from "./AgentPane.js";
import { InputArea, type InputRequest } from "./InputArea.js";
import { StatusBar } from "./StatusBar.js";

afterEach(() => {
  cleanup();
});

// ---- AgentPane ---------------------------------------------------------------

describe("AgentPane", () => {
  test("renders placeholder when no chunks have been emitted", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane
        label="Agent A (implementer)"
        agent="a"
        emitter={emitter}
        color="blue"
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Agent A (implementer)");
    expect(frame).toContain("(waiting for output)");
  });

  test("renders role label alongside agent name", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box>
        <AgentPane
          label="Agent A (implementer)"
          agent="a"
          emitter={emitter}
          color="blue"
        />
        <AgentPane
          label="Agent B (reviewer)"
          agent="b"
          emitter={emitter}
          color="green"
        />
      </Box>,
    );

    const frame = lastFrame();
    expect(frame).toContain("Agent A (implementer)");
    expect(frame).toContain("Agent B (reviewer)");
  });

  test("renders model name in header when provided", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane
        label="Agent A (implementer)"
        modelName="opus"
        agent="a"
        emitter={emitter}
        color="blue"
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Agent A (implementer) \u2014 opus");
  });

  test("renders streamed lines after agent:chunk events", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane label="Agent A" agent="a" emitter={emitter} color="blue" />,
    );

    emitter.emit("agent:chunk", { agent: "a", chunk: "Hello world\n" });
    // ink renders synchronously after state update.
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain("Hello world");
    expect(lastFrame()).not.toContain("(waiting for output)");
  });

  test("only shows chunks for the assigned agent", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane label="Agent A" agent="a" emitter={emitter} color="blue" />,
    );

    emitter.emit("agent:chunk", { agent: "b", chunk: "Agent B data\n" });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain("(waiting for output)");
    expect(lastFrame()).not.toContain("Agent B data");
  });

  test("renders unterminated (pending) chunk without waiting for newline", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane label="Agent A" agent="a" emitter={emitter} color="blue" />,
    );

    emitter.emit("agent:chunk", { agent: "a", chunk: "partial token" });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain("partial token");
    expect(lastFrame()).not.toContain("(waiting for output)");
  });

  test("accumulates multiple chunks into lines", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box height={10}>
        <AgentPane label="Agent B" agent="b" emitter={emitter} color="green" />
      </Box>,
    );

    emitter.emit("agent:chunk", { agent: "b", chunk: "line1\nline2\n" });
    emitter.emit("agent:chunk", { agent: "b", chunk: "line3\n" });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame();
    expect(frame).toContain("line1");
    expect(frame).toContain("line2");
    expect(frame).toContain("line3");
  });

  test("shows newest lines (tail) in a height-constrained container", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box height={10}>
        <AgentPane label="Agent A" agent="a" emitter={emitter} color="blue" />
      </Box>,
    );

    // Emit 20 lines — only the last few should be visible.
    const chunk = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    // The label must remain visible (not pushed off by too many rows).
    expect(frame).toContain("Agent A");
    // The newest lines must be visible as a contiguous tail.
    expect(frame).toContain("line20");
    expect(frame).toContain("line19");
    expect(frame).toContain("line18");
    // The oldest lines must be clipped away.
    expect(frame).not.toContain("line1\n");
    expect(frame).not.toContain("line2\n");
  });

  test("shows idle status for agent B before review stage", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane label="Agent B" agent="b" emitter={emitter} color="green" />,
    );

    emitter.emit("stage:enter", {
      stageNumber: 2,
      stageName: "Implement",
      iteration: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("idle");
    expect(frame).not.toContain("waiting for output");
  });

  test("shows waiting status for agent B at review stage", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane label="Agent B" agent="b" emitter={emitter} color="green" />,
    );

    emitter.emit("stage:enter", {
      stageNumber: 7,
      stageName: "Review",
      iteration: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("waiting for output");
    expect(frame).not.toContain("idle");
  });

  test("shows waiting status for agent A regardless of stage", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane label="Agent A" agent="a" emitter={emitter} color="blue" />,
    );

    emitter.emit("stage:enter", {
      stageNumber: 2,
      stageName: "Implement",
      iteration: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("waiting for output");
    expect(frame).not.toContain("idle");
  });

  test("shows newest content of a long wrapped line (auto-scroll)", async () => {
    const emitter = new PipelineEventEmitter();
    // Render in a narrow (40 cols), short (8 rows) container so one long
    // line wraps into many terminal rows and must be tailed correctly.
    const { lastFrame } = render(
      <Box width={40} height={8}>
        <AgentPane label="Agent A" agent="a" emitter={emitter} color="blue" />
      </Box>,
    );

    // Build a single long line (no newlines) that exceeds the pane width.
    // The tail marker must remain visible after wrapping.
    const longLine = `${"x".repeat(200)}LATEST_TOKEN`;
    emitter.emit("agent:chunk", { agent: "a", chunk: longLine });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("LATEST_TOKEN");
  });

  test("shows 'pane too small' instead of log lines in a tiny pane", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box height={3}>
        <AgentPane label="Agent A" agent="a" emitter={emitter} color="blue" />
      </Box>,
    );

    emitter.emit("agent:chunk", { agent: "a", chunk: "line1\nline2\nline3\n" });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    // No log lines should leak through — there is no content space.
    expect(frame).not.toContain("line1");
    expect(frame).not.toContain("line2");
    expect(frame).not.toContain("line3");
    // Must not show the waiting placeholder — output exists.
    expect(frame).not.toContain("waiting for output");
    expect(frame).toContain("pane too small");
  });

  test("Page Up reveals earlier lines and shows scroll indicator", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, stdin } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          scrollEnabled
        />
      </Box>,
    );

    const chunk = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain("line20");

    // Page Up.
    stdin.write("\x1b[5~");
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    // Scroll indicator must appear.
    expect(frame).toContain("\u2191");
    expect(frame).toContain("more lines");
    // Newest line should be scrolled out of view.
    expect(frame).not.toContain("line20");
  });

  test("Page Down returns to newest output after scrolling up", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, stdin } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          scrollEnabled
        />
      </Box>,
    );

    const chunk = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    // Scroll up.
    stdin.write("\x1b[5~");
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).not.toContain("line20");

    // Scroll back down.
    stdin.write("\x1b[6~");
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("line20");
    // Indicator should be gone (back at bottom).
    expect(frame).not.toContain("\u2191");
  });

  test("scrolling is disabled when scrollEnabled is false", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, stdin } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          scrollEnabled={false}
        />
      </Box>,
    );

    const chunk = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    stdin.write("\x1b[5~");
    await new Promise((r) => setTimeout(r, 50));

    // View should not have moved — still at bottom.
    expect(lastFrame()).toContain("line20");
    expect(lastFrame()).not.toContain("\u2191");
  });

  test("scrolling is disabled when isFocused is false", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, stdin } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused={false}
          scrollEnabled
        />
      </Box>,
    );

    const chunk = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    stdin.write("\x1b[5~");
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain("line20");
    expect(lastFrame()).not.toContain("\u2191");
  });

  test("auto-follow keeps view at bottom when new lines arrive", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          scrollEnabled
        />
      </Box>,
    );

    const chunk = Array.from({ length: 15 }, (_, i) => `old${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain("old15");

    // New line arrives while at bottom — view should follow.
    emitter.emit("agent:chunk", { agent: "a", chunk: "newtail\n" });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("newtail");
    expect(frame).not.toContain("\u2191");
  });

  test("scrolling through a single long wrapped line reveals earlier rows", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, stdin } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          scrollEnabled
        />
      </Box>,
    );

    // Emit a long wrapped line followed by short lines that push its
    // first rows above the viewport.  The line wraps to ~5 terminal rows
    // at the default contentWidth; 8 filler lines are enough to scroll
    // it out while keeping it reachable with a single Page Up.
    const longLine = `HEAD_${"x".repeat(390)}_TAIL`;
    emitter.emit("agent:chunk", {
      agent: "a",
      chunk: `${longLine}\n${"filler\n".repeat(8)}`,
    });
    await new Promise((r) => setTimeout(r, 50));

    // HEAD_ should be scrolled out of view at the bottom-pinned position.
    expect(lastFrame()).not.toContain("HEAD_");

    // Page Up — scroll through the content including wrapped rows.
    stdin.write("\x1b[5~");
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    // The earlier rows of the wrapped line must be reachable via
    // row-level scrolling (not dropped as a whole logical line).
    expect(frame).toContain("HEAD_");
  });

  test("viewport stays stable when pendingLine wraps further while scrolled up", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, stdin } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          scrollEnabled
        />
      </Box>,
    );

    // Emit enough lines to enable scrolling.
    const chunk = Array.from({ length: 25 }, (_, i) => `line${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    // Scroll up so line10 is visible and line25 is hidden.
    stdin.write("\x1b[5~");
    await new Promise((r) => setTimeout(r, 50));
    const frameBefore = lastFrame() ?? "";
    expect(frameBefore).not.toContain("line25");

    // Simulate a streaming pendingLine that wraps into extra rows.
    // Each chunk extends the pending line, potentially adding wrapped rows.
    emitter.emit("agent:chunk", { agent: "a", chunk: "x".repeat(100) });
    await new Promise((r) => setTimeout(r, 50));

    const frameAfter = lastFrame() ?? "";
    // The viewport must NOT shift to reveal the newest content;
    // the user is scrolled up and should stay in place.
    expect(frameAfter).not.toContain("line25");
  });

  test("unfocused pane border dims when scrollEnabled", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused={false}
          scrollEnabled
        />
        <AgentPane
          label="Agent B"
          agent="b"
          emitter={emitter}
          color="green"
          isFocused
          scrollEnabled
        />
      </Box>,
    );

    const frame = lastFrame() ?? "";
    // Both labels must be present.
    expect(frame).toContain("Agent A");
    expect(frame).toContain("Agent B");
  });
});

// ---- StatusBar ---------------------------------------------------------------

describe("StatusBar", () => {
  test("shows Initialising before any events", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <StatusBar
        emitter={emitter}
        owner="aicers"
        repo="agentcoop"
        issueNumber={49}
      />,
    );

    expect(lastFrame()).toContain("Initialising...");
    expect(lastFrame()).toContain("aicers/agentcoop#49");
  });

  test("updates stage display on stage:enter", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <StatusBar
        emitter={emitter}
        owner="aicers"
        repo="agentcoop"
        issueNumber={49}
      />,
    );

    emitter.emit("stage:enter", {
      stageNumber: 2,
      stageName: "Implement",
      iteration: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame();
    expect(frame).toContain("Stage 2: Implement");
    expect(frame).toContain("Round: 1 (in progress)");
    expect(frame).not.toContain("Initialising");
  });

  test("shows last outcome after stage:exit", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box width={200}>
        <StatusBar
          emitter={emitter}
          owner="aicers"
          repo="agentcoop"
          issueNumber={49}
        />
      </Box>,
    );

    emitter.emit("stage:enter", {
      stageNumber: 3,
      stageName: "Self-check",
      iteration: 1,
    });
    emitter.emit("stage:exit", { stageNumber: 3, outcome: "not_approved" });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame();
    expect(frame).toContain("Stage 3: Self-check");
    expect(frame).toContain("Round: 2 (done)");
    expect(frame).toContain("Last: not approved");
    expect(frame).toContain("SC: 1");
    expect(frame).toContain("RV: 0");
  });

  test("shows in-progress then done on successive events", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box width={200}>
        <StatusBar
          emitter={emitter}
          owner="aicers"
          repo="agentcoop"
          issueNumber={49}
        />
      </Box>,
    );

    emitter.emit("stage:enter", {
      stageNumber: 3,
      stageName: "Self-check",
      iteration: 0,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("Round: 1 (in progress)");

    emitter.emit("stage:exit", { stageNumber: 3, outcome: "not_approved" });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("Round: 1 (done)");

    emitter.emit("stage:enter", {
      stageNumber: 3,
      stageName: "Self-check",
      iteration: 1,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("Round: 2 (in progress)");
  });

  test("clears outcome on new stage:enter", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <StatusBar
        emitter={emitter}
        owner="aicers"
        repo="agentcoop"
        issueNumber={49}
      />,
    );

    emitter.emit("stage:enter", {
      stageNumber: 2,
      stageName: "Implement",
      iteration: 0,
    });
    emitter.emit("stage:exit", { stageNumber: 2, outcome: "completed" });
    emitter.emit("stage:enter", {
      stageNumber: 3,
      stageName: "Self-check",
      iteration: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame();
    expect(frame).toContain("Stage 3: Self-check");
    expect(frame).not.toContain("completed");
  });

  test("increments review count on stage:exit for review stage", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box width={200}>
        <StatusBar
          emitter={emitter}
          owner="aicers"
          repo="agentcoop"
          issueNumber={49}
        />
      </Box>,
    );

    emitter.emit("stage:enter", {
      stageNumber: 7,
      stageName: "Review",
      iteration: 0,
    });
    emitter.emit("stage:exit", { stageNumber: 7, outcome: "approved" });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame();
    expect(frame).toContain("SC: 0");
    expect(frame).toContain("RV: 1");
  });

  test("hides cumulative counts when both are zero", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <StatusBar
        emitter={emitter}
        owner="aicers"
        repo="agentcoop"
        issueNumber={49}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("SC:");
    expect(frame).not.toContain("RV:");
  });
});

// ---- InputArea ---------------------------------------------------------------

describe("InputArea", () => {
  test("shows 'Pipeline running...' when no request", () => {
    const { lastFrame } = render(
      <InputArea request={null} onSubmit={() => {}} />,
    );

    expect(lastFrame()).toContain("Pipeline running...");
  });

  test("renders choice options when request has choices", () => {
    const request: InputRequest = {
      message: "What do you want to do?",
      choices: [
        { label: "Continue", value: "continue" },
        { label: "Stop", value: "stop" },
      ],
    };
    const { lastFrame } = render(
      <InputArea request={request} onSubmit={() => {}} />,
    );

    const frame = lastFrame();
    expect(frame).toContain("What do you want to do?");
    expect(frame).toContain("1");
    expect(frame).toContain("Continue");
    expect(frame).toContain("2");
    expect(frame).toContain("Stop");
  });

  test("renders text input when request has no choices", () => {
    const request: InputRequest = {
      message: "Enter your instruction:",
    };
    const { lastFrame } = render(
      <InputArea request={request} onSubmit={() => {}} />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Enter your instruction:");
    expect(frame).toContain(">");
  });

  test("transitions from idle to active when request appears", async () => {
    const { lastFrame, rerender } = render(
      <InputArea request={null} onSubmit={() => {}} />,
    );

    expect(lastFrame()).toContain("Pipeline running...");

    const request: InputRequest = {
      message: "Blocked. Choose:",
      choices: [{ label: "Halt", value: "halt" }],
    };
    rerender(<InputArea request={request} onSubmit={() => {}} />);
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain("Blocked. Choose:");
    expect(lastFrame()).not.toContain("Pipeline running...");
  });
});
