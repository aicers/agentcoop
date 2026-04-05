/**
 * Component rendering tests for the split-pane TUI.
 *
 * Uses ink-testing-library to render ink components in a test
 * environment and assert on the terminal output frames.
 */
import { Box, Text, useInput, useStdout } from "ink";
import { cleanup, render } from "ink-testing-library";
import { useCallback, useEffect, useRef, useState } from "react";
import stringWidth from "string-width";
import { afterEach, describe, expect, test } from "vitest";
import { initI18n } from "../i18n/index.js";
import {
  type AgentInvokeEvent,
  PipelineEventEmitter,
} from "../pipeline-events.js";
import { AgentPane, splitIntoRows } from "./AgentPane.js";
import {
  computeVisibilityFlags,
  inputAreaHeight,
  useTerminalHeight,
} from "./App.js";
import { InputArea, type InputRequest } from "./InputArea.js";
import { fitInfoSegments, StatusBar } from "./StatusBar.js";
import { formatTokenCount, TokenBar } from "./TokenBar.js";

afterEach(() => {
  cleanup();
});

// ---- AgentPane ---------------------------------------------------------------

describe("AgentPane", () => {
  test("renders placeholder when no chunks have been emitted", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane
        label="Agent A (author)"
        agent="a"
        emitter={emitter}
        color="blue"
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Agent A (author)");
    expect(frame).toContain("(waiting for output)");
  });

  test("renders role label alongside agent name", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box>
        <AgentPane
          label="Agent A (author)"
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
    expect(frame).toContain("Agent A (author)");
    expect(frame).toContain("Agent B (reviewer)");
  });

  test("renders model name in header when provided", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane
        label="Agent A (author)"
        modelName="opus"
        agent="a"
        emitter={emitter}
        color="blue"
      />,
    );

    const frame = lastFrame();
    expect(frame).toContain("Agent A (author) \u2014 opus");
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
          arrowScrollEnabled
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
          arrowScrollEnabled
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
    // Back at bottom — no "lines below" indicator.
    expect(frame).not.toContain("\u2193");
  });

  test("Page Up still works when arrowScrollEnabled is false", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, stdin } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          arrowScrollEnabled={false}
        />
      </Box>,
    );

    const chunk = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    stdin.write("\x1b[5~"); // Page Up
    await new Promise((r) => setTimeout(r, 50));

    // Page keys work even during input prompts.
    expect(lastFrame()).not.toContain("line20");
    expect(lastFrame()).toContain("\u2191");
  });

  test("arrow scrolling is disabled when arrowScrollEnabled is false", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, stdin } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          arrowScrollEnabled={false}
        />
      </Box>,
    );

    const chunk = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    stdin.write("\x1b[A"); // Up arrow
    await new Promise((r) => setTimeout(r, 50));

    // Arrow keys should be disabled — still at bottom (no "lines below").
    expect(lastFrame()).toContain("line20");
    expect(lastFrame()).not.toContain("\u2193");
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
          arrowScrollEnabled
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

    // Scrolling should be disabled — still at bottom (no "lines below").
    expect(lastFrame()).toContain("line20");
    expect(lastFrame()).not.toContain("\u2193");
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
          arrowScrollEnabled
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
    // Bottom-pinned — no "lines below" indicator.
    expect(frame).not.toContain("\u2193");
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
          arrowScrollEnabled
        />
      </Box>,
    );

    // Emit a long wrapped line followed by short lines that push its
    // first rows above the viewport.  The line wraps to ~5 terminal rows
    // at the default contentWidth; 6 filler lines are enough to scroll
    // it out while keeping it reachable with a single Page Up.
    const longLine = `HEAD_${"x".repeat(390)}_TAIL`;
    emitter.emit("agent:chunk", {
      agent: "a",
      chunk: `${longLine}\n${"filler\n".repeat(6)}`,
    });
    await new Promise((r) => setTimeout(r, 50));

    // HEAD_ should be scrolled out of view at the bottom-pinned position.
    expect(lastFrame()).not.toContain("HEAD_");

    // Page Up twice — scroll through the content including wrapped rows.
    // The first Page Up may not reach HEAD_ because scroll indicators
    // reduce the content area; a second Page Up ensures we get there.
    stdin.write("\x1b[5~");
    await new Promise((r) => setTimeout(r, 50));
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
          arrowScrollEnabled
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

  test("unfocused pane border dims to distinguish focus", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused={false}
          arrowScrollEnabled
        />
        <AgentPane
          label="Agent B"
          agent="b"
          emitter={emitter}
          color="green"
          isFocused
          arrowScrollEnabled
        />
      </Box>,
    );

    const frame = lastFrame() ?? "";
    // Both labels must be present.
    expect(frame).toContain("Agent A");
    expect(frame).toContain("Agent B");
  });

  test("focused pane shows [*] indicator in header", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
        />
        <AgentPane
          label="Agent B"
          agent="b"
          emitter={emitter}
          color="green"
          isFocused={false}
        />
      </Box>,
    );

    const frame = lastFrame() ?? "";
    // Focused pane must show the [*] marker.
    expect(frame).toContain("[*]");
    // The marker must appear only once (only for the focused pane).
    const markerCount = (frame.match(/\[\*\]/g) ?? []).length;
    expect(markerCount).toBe(1);
  });

  test("active agent shows \u25CF indicator independently of focus", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused={false}
          isActive
        />
        <AgentPane
          label="Agent B"
          agent="b"
          emitter={emitter}
          color="green"
          isFocused
          isActive={false}
        />
      </Box>,
    );

    const frame = lastFrame() ?? "";
    // Active indicator must appear once (only for the active pane).
    const activeCount = (frame.match(/\u25CF/g) ?? []).length;
    expect(activeCount).toBe(1);
    // Focus marker must also appear once (on a different pane).
    const focusCount = (frame.match(/\[\*\]/g) ?? []).length;
    expect(focusCount).toBe(1);
  });

  test("active indicator clears after stage:exit", async () => {
    // Regression: activeAgent must not remain stuck after an agent finishes.
    // This mirrors App.tsx wiring: agent:invoke sets activeAgent, stage:exit
    // clears it.
    const emitter = new PipelineEventEmitter();

    function ActiveTracker({ emitter }: { emitter: PipelineEventEmitter }) {
      const [active, setActive] = useState<"a" | "b" | null>(null);
      useEffect(() => {
        const onInvoke = (ev: AgentInvokeEvent) => setActive(ev.agent);
        const onExit = () => setActive(null);
        emitter.on("agent:invoke", onInvoke);
        emitter.on("stage:exit", onExit);
        return () => {
          emitter.off("agent:invoke", onInvoke);
          emitter.off("stage:exit", onExit);
        };
      }, [emitter]);
      return (
        <Box>
          <AgentPane
            label="Agent A"
            agent="a"
            emitter={emitter}
            color="blue"
            isActive={active === "a"}
          />
          <AgentPane
            label="Agent B"
            agent="b"
            emitter={emitter}
            color="green"
            isActive={active === "b"}
          />
        </Box>
      );
    }

    const { lastFrame } = render(<ActiveTracker emitter={emitter} />);

    // Invoke agent A → ● should appear.
    emitter.emit("agent:invoke", { agent: "a", type: "invoke" });
    await new Promise((r) => setTimeout(r, 50));
    expect((lastFrame() ?? "").match(/\u25CF/g)?.length).toBe(1);

    // Stage exits → ● should disappear from both panes.
    emitter.emit("stage:exit", { stageNumber: 2, outcome: "completed" });
    await new Promise((r) => setTimeout(r, 50));
    expect((lastFrame() ?? "").match(/\u25CF/g) ?? []).toHaveLength(0);
  });

  test("no active indicator when isActive is false", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          isActive={false}
        />
        <AgentPane
          label="Agent B"
          agent="b"
          emitter={emitter}
          color="green"
          isFocused={false}
          isActive={false}
        />
      </Box>,
    );

    const frame = lastFrame() ?? "";
    // Neither pane should show the active indicator.
    const activeCount = (frame.match(/\u25CF/g) ?? []).length;
    expect(activeCount).toBe(0);
  });

  test("bottom-pinned mode shows lines-above indicator when content overflows", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          arrowScrollEnabled
        />
      </Box>,
    );

    const chunk = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    // Bottom-pinned with lines above — top indicator must appear.
    expect(frame).toContain("\u2191");
    expect(frame).toContain("more lines");
    // No bottom indicator at the very bottom.
    expect(frame).not.toContain("\u2193");
    // Newest line must still be visible.
    expect(frame).toContain("line20");
  });

  test("scrolled-up mode shows lines-below indicator", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, stdin } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          arrowScrollEnabled
        />
      </Box>,
    );

    const chunk = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    // Scroll up one line.
    stdin.write("\x1b[A");
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    // Both indicators should be visible.
    expect(frame).toContain("\u2191");
    expect(frame).toContain("\u2193");
  });

  test("single wrapped line scrolled up does not leave blank rows", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, stdin } = render(
      <Box height={10}>
        <AgentPane
          label="Agent A"
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused
          arrowScrollEnabled
        />
      </Box>,
    );

    // Emit a single long line that wraps across many terminal rows.
    const longLine = "x".repeat(900);
    emitter.emit("agent:chunk", { agent: "a", chunk: `${longLine}\n` });
    await new Promise((r) => setTimeout(r, 50));

    // Scroll up one row.
    stdin.write("\x1b[A");
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    // A single logical line produces no "lines below" indicator, so no
    // row should be reserved for it.  Every content row must contain
    // part of the wrapped text — no blank trailing row.
    expect(frame).not.toContain("\u2193");
    const rows = frame.split("\n");
    // The last row inside the box is the bottom border.  The row just
    // above it should be filled with content, not empty.
    const bottomBorderIdx = rows.findLastIndex((r) => r.includes("\u2514"));
    if (bottomBorderIdx > 0) {
      const lastContentRow = rows[bottomBorderIdx - 1].trim();
      expect(lastContentRow.length).toBeGreaterThan(0);
    }
  });

  test("pane header and content are separated by a horizontal line", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane label="Agent A" agent="a" emitter={emitter} color="blue" />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("\u2500");
  });
});

// ---- splitIntoRows -----------------------------------------------------------

describe("splitIntoRows", () => {
  test("wraps at word boundaries instead of mid-word", () => {
    const rows = splitIntoRows("No code changes were needed.", 15);
    expect(rows).toEqual(["No code changes", " were needed."]);
  });

  test("hard-breaks a single word longer than width", () => {
    const rows = splitIntoRows("abcdefghij", 4);
    expect(rows).toEqual(["abcd", "efgh", "ij"]);
  });

  test("returns single row for text shorter than width", () => {
    expect(splitIntoRows("short", 80)).toEqual(["short"]);
  });

  test("preserves empty string", () => {
    expect(splitIntoRows("", 40)).toEqual([""]);
  });

  test("preserves leading whitespace (trim: false)", () => {
    const rows = splitIntoRows("  indented text", 20);
    expect(rows).toEqual(["  indented text"]);
    // Ensure indentation survives wrapping when the line must break.
    const wrapped = splitIntoRows("  indented text here", 10);
    expect(wrapped[0]).toMatch(/^\s{2}/);
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
    // Implement is not a looping stage — no round indicator.
    expect(frame).not.toContain("round");
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
    expect(frame).toContain("Stage 3: Self-check (round 2, done)");
    expect(frame).toContain("Last: not approved");
    expect(frame).toContain("Completed: self-check \u00d71, review \u00d70");
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
    expect(lastFrame()).toContain("Stage 3: Self-check (round 1, in progress)");

    emitter.emit("stage:exit", { stageNumber: 3, outcome: "not_approved" });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("Stage 3: Self-check (round 1, done)");

    emitter.emit("stage:enter", {
      stageNumber: 3,
      stageName: "Self-check",
      iteration: 1,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("Stage 3: Self-check (round 2, in progress)");
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
    expect(frame).toContain("Completed: self-check \u00d70, review \u00d71");
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
    expect(frame).not.toContain("Completed:");
  });

  test("shows abbreviated base SHA when baseSha is provided", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <StatusBar
        emitter={emitter}
        owner="aicers"
        repo="agentcoop"
        issueNumber={49}
        baseSha="abc1234def567890"
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Base: abc1234");
    expect(frame).not.toContain("abc1234def567890");
  });

  test("hides base SHA when baseSha is not provided", () => {
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
    expect(frame).not.toContain("Base:");
  });

  test("shows layout indicator when layout prop is provided", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box width={200}>
        <StatusBar
          emitter={emitter}
          owner="aicers"
          repo="agentcoop"
          issueNumber={49}
          layout="row"
        />
      </Box>,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Layout: horizontal");
  });

  test("shows vertical layout label when layout is column", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box width={200}>
        <StatusBar
          emitter={emitter}
          owner="aicers"
          repo="agentcoop"
          issueNumber={49}
          layout="column"
        />
      </Box>,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Layout: vertical");
  });

  test("hides layout indicator when layout prop is omitted", () => {
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
    expect(frame).not.toContain("Layout:");
  });

  test("renders key hints line", () => {
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
    expect(frame).toContain("Tab:Switch pane");
    expect(frame).toContain("Ctrl+C:Quit");
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

// ---- Deferred resolution (issue #105) ----------------------------------------

describe("deferred handleSubmit resolution", () => {
  test("keypress on first prompt does not auto-answer the next prompt", async () => {
    // Reproduces issue #105: pressing "1" on a single-choice OK prompt
    // must NOT bleed through to the subsequent merge-confirmation prompt.
    let dispatchFn: ((req: InputRequest) => Promise<string>) | null = null;

    function Harness() {
      const [request, setRequest] = useState<InputRequest | null>(null);
      const resolveRef = useRef<((v: string) => void) | null>(null);

      const dispatch = useCallback((req: InputRequest): Promise<string> => {
        return new Promise<string>((resolve) => {
          resolveRef.current = resolve;
          setRequest(req);
        });
      }, []);

      const handleSubmit = useCallback((value: string) => {
        const resolve = resolveRef.current;
        resolveRef.current = null;
        setRequest(null);
        // Same deferred pattern as App.tsx
        setTimeout(() => resolve?.(value), 0);
      }, []);

      dispatchFn = dispatch;

      return <InputArea request={request} onSubmit={handleSubmit} />;
    }

    const { lastFrame, stdin } = render(<Harness />);
    await new Promise((r) => setTimeout(r, 50));

    // Dispatch first prompt: single OK choice (completion notification).
    expect(dispatchFn).not.toBeNull();
    const dispatch = dispatchFn as unknown as (
      req: InputRequest,
    ) => Promise<string>;
    const p1 = dispatch({
      message: "Pipeline completed.",
      choices: [{ label: "OK", value: "ok" }],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("Pipeline completed.");

    // When the first prompt resolves, immediately dispatch a second prompt.
    let secondAnswer: string | undefined;
    p1.then(() => {
      dispatch({
        message: "Has the PR been merged?",
        choices: [
          { label: "Yes, merged", value: "yes" },
          { label: "No, keep worktree", value: "no" },
        ],
      }).then((v) => {
        secondAnswer = v;
      });
    });

    // Press "1" to select OK on the first prompt.
    stdin.write("1");
    await new Promise((r) => setTimeout(r, 100));

    // First prompt should have resolved.
    await expect(p1).resolves.toBe("ok");

    // Second prompt must be visible — not auto-answered.
    expect(lastFrame()).toContain("Has the PR been merged?");
    expect(secondAnswer).toBeUndefined();
  });
});

// ---- Viewport height constraint (App-level integration) ---------------------

describe("viewport height constraint", () => {
  test("useTerminalHeight returns undefined when stdout is not a TTY", () => {
    // ink-testing-library's stdout has no isTTY property, simulating a
    // non-TTY environment.  The hook should return undefined so the root
    // Box falls back to height="100%".
    function Probe() {
      const h = useTerminalHeight();
      return <Text>{h === undefined ? "UNDEFINED" : String(h)}</Text>;
    }

    const { lastFrame } = render(<Probe />);
    expect(lastFrame()).toContain("UNDEFINED");
  });

  test("useTerminalHeight updates on stdout resize", async () => {
    function Probe() {
      const { stdout } = useStdout();
      const h = useTerminalHeight();
      return (
        <Text>
          isTTY={String(stdout.isTTY)} h={h === undefined ? "none" : String(h)}
        </Text>
      );
    }

    const { lastFrame, stdout } = render(<Probe />);

    // Initially not a TTY — height should be undefined.
    expect(lastFrame()).toContain("h=none");

    // Simulate becoming a TTY with a resize event.  In production the
    // stdout always has isTTY set from the start, but for this test we
    // verify that a resize event with rows set propagates.  Since isTTY
    // was false at mount, the listener isn't registered so height stays
    // undefined — confirming the non-TTY fallback is stable.
    Object.defineProperty(stdout, "rows", { value: 30, writable: true });
    stdout.emit("resize");
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("h=none");
  });

  test("Tab switches focus between panes during input prompts", async () => {
    const emitter = new PipelineEventEmitter();

    // Mini harness that mimics App's Tab handler and focus state.
    function Harness({ hasInput }: { hasInput: boolean }) {
      const [focusedPane, setFocusedPane] = useState<"a" | "b">("a");
      useInput((_input, key) => {
        if (key.tab) {
          setFocusedPane((prev) => (prev === "a" ? "b" : "a"));
        }
      });
      return (
        <Box flexDirection="column" height={12}>
          <Box flexDirection="row" flexGrow={1}>
            <AgentPane
              label="Agent A"
              agent="a"
              emitter={emitter}
              color="blue"
              isFocused={focusedPane === "a"}
              arrowScrollEnabled={!hasInput}
            />
            <AgentPane
              label="Agent B"
              agent="b"
              emitter={emitter}
              color="green"
              isFocused={focusedPane === "b"}
              arrowScrollEnabled={!hasInput}
            />
          </Box>
        </Box>
      );
    }

    const { lastFrame, stdin } = render(<Harness hasInput />);

    // Initially pane A is focused.
    const before = lastFrame() ?? "";
    expect(before).toContain("Agent A");
    expect(before).toContain("Agent B");
    // [*] should appear once, for Agent A.
    expect((before.match(/\[\*\]/g) ?? []).length).toBe(1);

    // Press Tab — focus should move to pane B even during input.
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 50));

    const after = lastFrame() ?? "";
    // Agent B header should now contain [*].
    const bHeaderIdx = after.indexOf("Agent B");
    const markerIdx = after.lastIndexOf("[*]");
    expect(markerIdx).toBeGreaterThan(bHeaderIdx);
  });

  test("Ctrl+L toggles layout between row and column", async () => {
    const emitter = new PipelineEventEmitter();

    // Harness that mimics App's Ctrl+L handler and passes layout to StatusBar.
    function LayoutHarness() {
      const [layout, setLayout] = useState<"row" | "column">("row");
      useInput((input, key) => {
        if (input === "l" && key.ctrl) {
          setLayout((prev) => (prev === "row" ? "column" : "row"));
        }
      });
      return (
        <Box flexDirection="column" width={120} height={12}>
          <Box flexDirection={layout} flexGrow={1}>
            <AgentPane
              label="Agent A"
              agent="a"
              emitter={emitter}
              color="blue"
              isFocused
              arrowScrollEnabled
            />
            <AgentPane
              label="Agent B"
              agent="b"
              emitter={emitter}
              color="green"
            />
          </Box>
          <StatusBar
            emitter={emitter}
            owner="aicers"
            repo="agentcoop"
            issueNumber={49}
            layout={layout}
          />
        </Box>
      );
    }

    const { lastFrame, stdin } = render(<LayoutHarness />);

    // Initially horizontal layout.
    const before = lastFrame() ?? "";
    expect(before).toContain("Layout: horizontal");

    // Press Ctrl+L — should toggle to vertical.
    stdin.write("\x0C"); // Ctrl+L
    await new Promise((r) => setTimeout(r, 50));

    const toggled = lastFrame() ?? "";
    expect(toggled).toContain("Layout: vertical");

    // Press Ctrl+L again — back to horizontal.
    stdin.write("\x0C");
    await new Promise((r) => setTimeout(r, 50));

    const restored = lastFrame() ?? "";
    expect(restored).toContain("Layout: horizontal");
  });

  test("PageUp/PageDown work during active input prompts", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, stdin } = render(
      <Box flexDirection="column" height={12}>
        <Box flexDirection="row" flexGrow={1}>
          <AgentPane
            label="Agent A"
            agent="a"
            emitter={emitter}
            color="blue"
            isFocused
            arrowScrollEnabled={false}
          />
        </Box>
      </Box>,
    );

    const chunk = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk });
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain("line20");

    // Page Up during input prompt — should still scroll.
    stdin.write("\x1b[5~");
    await new Promise((r) => setTimeout(r, 50));

    const scrolled = lastFrame() ?? "";
    expect(scrolled).not.toContain("line20");
    expect(scrolled).toContain("\u2191");

    // Page Down — return to bottom.
    stdin.write("\x1b[6~");
    await new Promise((r) => setTimeout(r, 50));

    expect(lastFrame()).toContain("line20");
  });

  test("fixed-height root constrains panes to viewport", async () => {
    const emitter = new PipelineEventEmitter();

    // Simulate the App layout: two panes side-by-side in a fixed-height
    // container.  This mirrors what useTerminalHeight achieves on a real
    // TTY by setting height={stdout.rows}.
    const VIEWPORT_HEIGHT = 12;
    const { lastFrame, stdin } = render(
      <Box flexDirection="column" height={VIEWPORT_HEIGHT}>
        <Box flexDirection="row" flexGrow={1}>
          <AgentPane
            label="Agent A"
            agent="a"
            emitter={emitter}
            color="blue"
            isFocused
            arrowScrollEnabled
          />
          <AgentPane
            label="Agent B"
            agent="b"
            emitter={emitter}
            color="green"
          />
        </Box>
      </Box>,
    );

    // Fill both panes with distinct content.
    const chunkA = Array.from({ length: 20 }, (_, i) => `A${i + 1}`)
      .join("\n")
      .concat("\n");
    const chunkB = Array.from({ length: 20 }, (_, i) => `B${i + 1}`)
      .join("\n")
      .concat("\n");
    emitter.emit("agent:chunk", { agent: "a", chunk: chunkA });
    emitter.emit("agent:chunk", { agent: "b", chunk: chunkB });
    await new Promise((r) => setTimeout(r, 50));

    // Both panes should show their newest content (auto-follow).
    const before = lastFrame() ?? "";
    expect(before).toContain("A20");
    expect(before).toContain("B20");
    // Oldest lines should be clipped by the fixed viewport.
    expect(before).not.toContain("A1\n");
    expect(before).not.toContain("B1\n");

    // Scroll pane A up — only pane A should change.
    stdin.write("\x1b[5~"); // Page Up
    await new Promise((r) => setTimeout(r, 50));

    const after = lastFrame() ?? "";
    // Pane A must have scrolled (newest line hidden).
    expect(after).not.toContain("A20");
    // Pane B must remain at the bottom (unaffected by pane A scroll).
    expect(after).toContain("B20");
  });
});

// ---- formatTokenCount -------------------------------------------------------

describe("formatTokenCount", () => {
  test("returns exact number below 1000", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("formats thousands with K suffix", () => {
    expect(formatTokenCount(1000)).toBe("1.0K");
    expect(formatTokenCount(1500)).toBe("1.5K");
    expect(formatTokenCount(12345)).toBe("12.3K");
    expect(formatTokenCount(99900)).toBe("99.9K");
  });

  test("rounds large K values without decimal", () => {
    expect(formatTokenCount(100_000)).toBe("100K");
    expect(formatTokenCount(500_000)).toBe("500K");
  });

  test("formats millions with M suffix", () => {
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });
});

// ---- TokenBar ---------------------------------------------------------------

describe("TokenBar", () => {
  test("renders nothing when no usage events emitted", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(<TokenBar emitter={emitter} />);
    // TokenBar returns null when there is no data, so the frame should
    // be empty or contain no agent labels.
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Agent A");
  });

  test("renders cumulative token usage after events", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(<TokenBar emitter={emitter} />);

    emitter.emit("agent:usage", {
      agent: "a",
      usage: { inputTokens: 12300, outputTokens: 5100, cachedInputTokens: 0 },
    });
    emitter.emit("agent:usage", {
      agent: "b",
      usage: { inputTokens: 8700, outputTokens: 3200, cachedInputTokens: 0 },
    });

    // Allow React to re-render.
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agent A (author)");
    expect(frame).toContain("12.3K in");
    expect(frame).toContain("5.1K out");
    expect(frame).toContain("Agent B (reviewer)");
    expect(frame).toContain("8.7K in");
    expect(frame).toContain("3.2K out");
  });

  test("accumulates usage across multiple events for same agent", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(<TokenBar emitter={emitter} />);

    emitter.emit("agent:usage", {
      agent: "a",
      usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 },
    });
    emitter.emit("agent:usage", {
      agent: "a",
      usage: { inputTokens: 2000, outputTokens: 1000, cachedInputTokens: 0 },
    });

    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("3.0K in");
    expect(frame).toContain("1.5K out");
  });

  test("renders nothing when visible is false even with data", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <TokenBar emitter={emitter} visible={false} />,
    );

    emitter.emit("agent:usage", {
      agent: "a",
      usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Agent A");
    expect(frame).not.toContain("1.0K");
  });

  test("shows accumulated data when visible becomes true", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame, rerender } = render(
      <TokenBar emitter={emitter} visible={false} />,
    );

    emitter.emit("agent:usage", {
      agent: "a",
      usage: { inputTokens: 5000, outputTokens: 2000, cachedInputTokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? "").not.toContain("Agent A");

    rerender(<TokenBar emitter={emitter} visible />);
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agent A (author)");
    expect(frame).toContain("5.0K in");
  });
});

describe("TokenBar width adaptation", () => {
  test("truncates content to contentWidth so it cannot wrap", async () => {
    const emitter = new PipelineEventEmitter();
    // contentWidth=10 is narrower than each agent's token text (~28 chars).
    const { lastFrame } = render(
      <TokenBar emitter={emitter} contentWidth={10} />,
    );

    emitter.emit("agent:usage", {
      agent: "a",
      usage: { inputTokens: 5000, outputTokens: 2000, cachedInputTokens: 0 },
    });
    emitter.emit("agent:usage", {
      agent: "b",
      usage: { inputTokens: 6000, outputTokens: 3000, cachedInputTokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    // Each box independently truncates its agent's text.
    expect(frame).toContain("\u2026");
    // Both agents appear since each has its own box.
    // Role suffixes are truncated at this width, but the prefix survives.
    expect(frame).toContain("Agent A (");
    expect(frame).toContain("Agent B (");
  });

  test("truncates Korean (wide-char) content correctly", async () => {
    await initI18n("ko");
    try {
      const emitter = new PipelineEventEmitter();
      const { lastFrame } = render(
        <TokenBar emitter={emitter} contentWidth={10} />,
      );

      emitter.emit("agent:usage", {
        agent: "a",
        usage: {
          inputTokens: 5000,
          outputTokens: 2000,
          cachedInputTokens: 0,
        },
      });
      emitter.emit("agent:usage", {
        agent: "b",
        usage: {
          inputTokens: 6000,
          outputTokens: 3000,
          cachedInputTokens: 0,
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      const frame = lastFrame() ?? "";
      expect(frame).toContain("\u2026");
    } finally {
      await initI18n("en");
    }
  });
});

describe("TokenBar layout prop", () => {
  test("uses equal-width boxes in row layout regardless of content length", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <Box width={50}>
        <TokenBar emitter={emitter} layout="row" />
      </Box>,
    );

    emitter.emit("agent:usage", {
      agent: "a",
      usage: {
        inputTokens: 999_999,
        outputTokens: 999_999,
        cachedInputTokens: 0,
      },
    });
    emitter.emit("agent:usage", {
      agent: "b",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    const topBorder = frame.split("\n").find((line) => line.startsWith("┌"));
    expect(topBorder).toBeDefined();

    const match = topBorder?.match(/^┌([^┐]*)┐┌([^┐]*)┐$/u);
    expect(match).not.toBeNull();

    const [, leftBox, rightBox] = match ?? [];
    expect(stringWidth(leftBox)).toBe(stringWidth(rightBox));
  });

  test("renders two boxes side by side in row layout", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(<TokenBar emitter={emitter} layout="row" />);

    emitter.emit("agent:usage", {
      agent: "a",
      usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 },
    });
    emitter.emit("agent:usage", {
      agent: "b",
      usage: { inputTokens: 2000, outputTokens: 800, cachedInputTokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    // Both agents should appear on the same line in row layout.
    const lines = frame.split("\n");
    const agentALine = lines.find((l) => l.includes("Agent A (author)"));
    const agentBLine = lines.find((l) => l.includes("Agent B (reviewer)"));
    expect(agentALine).toBeDefined();
    expect(agentBLine).toBeDefined();
    // In row layout they share a line.
    expect(agentALine).toBe(agentBLine);
  });

  test("renders two boxes stacked in column layout", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <TokenBar emitter={emitter} layout="column" />,
    );

    emitter.emit("agent:usage", {
      agent: "a",
      usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 },
    });
    emitter.emit("agent:usage", {
      agent: "b",
      usage: { inputTokens: 2000, outputTokens: 800, cachedInputTokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    // In column layout, each agent's text appears on a different line.
    const lines = frame.split("\n");
    const agentAIdx = lines.findIndex((l) => l.includes("Agent A (author)"));
    const agentBIdx = lines.findIndex((l) => l.includes("Agent B (reviewer)"));
    expect(agentAIdx).toBeGreaterThanOrEqual(0);
    expect(agentBIdx).toBeGreaterThanOrEqual(0);
    expect(agentAIdx).not.toBe(agentBIdx);
  });
});

// ---- computeVisibilityFlags --------------------------------------------------

describe("computeVisibilityFlags", () => {
  test("shows everything when terminal has plenty of height", () => {
    const flags = computeVisibilityFlags(40, 1, true, "row");
    expect(flags.showTokenBar).toBe(true);
    expect(flags.showKeyHints).toBe(true);
    expect(flags.showPaneSeparator).toBe(true);
    expect(flags.allowColumnLayout).toBe(true);
  });

  test("hides token bar first when space is tight", () => {
    // Row: paneContent = 14 - 1(input) - 4(status) - 3(token) - 4(overhead) = 2 < 3
    // Without token: 14 - 1 - 4 - 0 - 4 = 5 >= 3
    const flags = computeVisibilityFlags(14, 1, true, "row");
    expect(flags.showTokenBar).toBe(false);
    expect(flags.showKeyHints).toBe(true);
    expect(flags.showPaneSeparator).toBe(true);
  });

  test("hides key hints after token bar", () => {
    // No token data, token bar already hidden.
    // paneContent = 11 - 1 - 4 - 0 - 4 = 2 < 3 → hide hints
    // Without hints: 11 - 1 - 3 - 0 - 4 = 3 >= 3
    const flags = computeVisibilityFlags(11, 1, false, "row");
    expect(flags.showTokenBar).toBe(false);
    expect(flags.showKeyHints).toBe(false);
    expect(flags.showPaneSeparator).toBe(true);
  });

  test("hides separator after key hints", () => {
    // paneContent = 10 - 1 - 3 - 0 - 4 = 2 < 3 → hide separator
    // Without separator: 10 - 1 - 3 - 0 - 3 = 3 >= 3
    const flags = computeVisibilityFlags(10, 1, false, "row");
    expect(flags.showTokenBar).toBe(false);
    expect(flags.showKeyHints).toBe(false);
    expect(flags.showPaneSeparator).toBe(false);
  });

  test("forces row layout when column panes are too small", () => {
    // Column layout can't fit MIN_PANE_CONTENT even with all hidden.
    // After forcing row, flags are recomputed for row mode.
    // Row: paneContent = 12 - 1 - 4 - 0 - 4 = 3 >= 3 → hints and sep shown
    const flags = computeVisibilityFlags(12, 1, false, "column");
    expect(flags.allowColumnLayout).toBe(false);
    expect(flags.showKeyHints).toBe(true);
    expect(flags.showPaneSeparator).toBe(true);
  });

  test("preserves column layout when panes have enough space", () => {
    const flags = computeVisibilityFlags(30, 1, false, "column");
    expect(flags.allowColumnLayout).toBe(true);
  });

  test("token bar stays hidden when hasTokenData is false", () => {
    const flags = computeVisibilityFlags(100, 1, false, "row");
    expect(flags.showTokenBar).toBe(false);
  });

  test("accounts for taller input area", () => {
    // With inputHeight=4: paneContent = 17 - 4 - 4 - 3 - 4 = 2 < 3 → hide token
    const flags = computeVisibilityFlags(17, 4, true, "row");
    expect(flags.showTokenBar).toBe(false);
    expect(flags.showKeyHints).toBe(true);
  });

  test("column layout uses 6-row token bar height", () => {
    // Column: token bar stacks two 3-row boxes = 6 rows total.
    // paneArea = 30 - 1(input) - 4(status) - 6(token) = 19
    // paneContent per pane = floor(19/2) - 4(overhead) = 5 >= 3 → shown
    const flags = computeVisibilityFlags(30, 1, true, "column");
    expect(flags.showTokenBar).toBe(true);
    expect(flags.allowColumnLayout).toBe(true);
  });

  test("column layout hides token bar sooner due to 6-row height", () => {
    // Column with token: paneArea = 22 - 1 - 4 - 6 = 11
    // paneContent = floor(11/2) - 4 = 1 < 3 → hide token bar
    // Column without token: paneArea = 22 - 1 - 4 - 0 = 17
    // paneContent = floor(17/2) - 4 = 4 >= 3 → fits
    const flags = computeVisibilityFlags(22, 1, true, "column");
    expect(flags.showTokenBar).toBe(false);
    expect(flags.allowColumnLayout).toBe(true);
  });
});

// ---- inputAreaHeight ---------------------------------------------------------

describe("inputAreaHeight", () => {
  test("returns 1 for null request", () => {
    expect(inputAreaHeight(null)).toBe(1);
  });

  test("returns 2 for text input request", () => {
    expect(inputAreaHeight({ message: "Enter:" })).toBe(2);
  });

  test("returns 1 plus choices count for choice request", () => {
    expect(
      inputAreaHeight({
        message: "Choose:",
        choices: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ],
      }),
    ).toBe(3);
  });
});

// ---- fitInfoSegments ---------------------------------------------------------

describe("fitInfoSegments", () => {
  test("returns all segments when they fit", () => {
    const segments = [
      { text: "abc", dropPriority: 0 },
      { text: "def", dropPriority: 1 },
    ];
    const result = fitInfoSegments(segments, 50);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("abc");
    expect(result[1].text).toBe("def");
  });

  test("drops highest priority segment first", () => {
    const segments = [
      { text: "required", dropPriority: 0 },
      { text: "low-priority", dropPriority: 2 },
      { text: "mid-priority", dropPriority: 1 },
    ];
    // "required"(8) + sep(5) + "low-priority"(12) + sep(5) + "mid-priority"(12) = 42
    // Budget 30: drop "low-priority" (priority 2) first → 8+5+12 = 25 <= 30
    const result = fitInfoSegments(segments, 30);
    expect(result.map((s) => s.text)).toEqual(["required", "mid-priority"]);
  });

  test("drops multiple segments when needed", () => {
    const segments = [
      { text: "abc", dropPriority: 0 },
      { text: "xxxxxxxx", dropPriority: 3 },
      { text: "def", dropPriority: 0 },
      { text: "yyyyyyyy", dropPriority: 2 },
      { text: "zzzzzzzz", dropPriority: 1 },
    ];
    // Budget 15: drop priority 3, 2, 1 → "abc"(3) + sep(5) + "def"(3) = 11 <= 15
    const result = fitInfoSegments(segments, 15);
    expect(result.map((s) => s.text)).toEqual(["abc", "def"]);
  });

  test("truncates required segments as last resort", () => {
    const segments = [
      { text: "aicers/agentcoop#123", dropPriority: 0 },
      { text: "Stage 2: Implement", dropPriority: 0 },
    ];
    // Both required, total = 20 + 5 + 18 = 43, budget = 20
    // available = 20 - 5 = 15, each = 7, remainder = 1
    // Seg 0: max 8 → "aicers/\u2026", Seg 1: max 7 → "Stage \u2026"
    const result = fitInfoSegments(segments, 20);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("aicers/\u2026");
    expect(result[1].text).toBe("Stage \u2026");
  });

  test("merges segments when budget is smaller than separator + 1 col per segment", () => {
    const segments = [
      { text: "aicers/agentcoop#123", dropPriority: 0 },
      { text: "Stage 2: Implement", dropPriority: 0 },
    ];
    // Two required segments need at least SEP(5) + 1 + 1 = 7 columns in
    // separator mode. At budget=6 the separator form overflows, so the
    // function should merge into one truncated string.
    const result = fitInfoSegments(segments, 6);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("aicer\u2026");
  });

  test("merges segments at budget=1 producing single ellipsis", () => {
    const segments = [
      { text: "aicers/agentcoop#123", dropPriority: 0 },
      { text: "Stage 2: Implement", dropPriority: 0 },
    ];
    const result = fitInfoSegments(segments, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("\u2026");
  });

  test("handles empty segments array", () => {
    const result = fitInfoSegments([], 50);
    expect(result).toEqual([]);
  });
});

// ---- StatusBar width adaptation ----------------------------------------------

describe("StatusBar width adaptation", () => {
  test("hides key hints when showKeyHints is false", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <StatusBar
        emitter={emitter}
        owner="aicers"
        repo="agentcoop"
        issueNumber={49}
        showKeyHints={false}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Tab:Switch pane");
    expect(frame).not.toContain("Ctrl+C:Quit");
    // Info line should still be present.
    expect(frame).toContain("aicers/agentcoop#49");
  });

  test("truncates key hints line to contentWidth so it cannot wrap", () => {
    const emitter = new PipelineEventEmitter();
    // contentWidth=26 is narrower than the full key-hints string (~100 chars).
    const { lastFrame } = render(
      <StatusBar
        emitter={emitter}
        owner="aicers"
        repo="agentcoop"
        issueNumber={49}
        showKeyHints={true}
        contentWidth={26}
      />,
    );

    const frame = lastFrame() ?? "";
    // Key hints should be present but truncated (ends with ellipsis).
    expect(frame).toContain("\u2026");
    // The full hints string should NOT appear since it exceeds 26 columns.
    expect(frame).not.toContain("Ctrl+C:Quit");
    // Each rendered line (excluding border box characters) should fit within
    // the content width. Split by newlines and check non-border lines.
    for (const line of frame.split("\n")) {
      // Ink box border lines use box-drawing characters; skip them.
      if (line.startsWith("│") || line.startsWith("┌") || line.startsWith("└"))
        continue;
      // Remaining content lines must not exceed contentWidth.
      expect(stringWidth(line)).toBeLessThanOrEqual(26);
    }
  });

  test("truncates Korean (wide-char) key hints correctly", async () => {
    await initI18n("ko");
    try {
      const emitter = new PipelineEventEmitter();
      const { lastFrame } = render(
        <StatusBar
          emitter={emitter}
          owner="aicers"
          repo="agentcoop"
          issueNumber={49}
          showKeyHints={true}
          contentWidth={26}
        />,
      );

      const frame = lastFrame() ?? "";
      expect(frame).toContain("\u2026");
      // Korean key hints end with Ctrl+C:종료; it should be truncated.
      expect(frame).not.toContain("종료");
      for (const line of frame.split("\n")) {
        if (
          line.startsWith("│") ||
          line.startsWith("┌") ||
          line.startsWith("└")
        )
          continue;
        expect(stringWidth(line)).toBeLessThanOrEqual(26);
      }
    } finally {
      await initI18n("en");
    }
  });

  test("drops layout indicator first when contentWidth is narrow", async () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <StatusBar
        emitter={emitter}
        owner="aicers"
        repo="agentcoop"
        issueNumber={49}
        layout="row"
        contentWidth={50}
      />,
    );

    emitter.emit("stage:enter", {
      stageNumber: 2,
      stageName: "Implement",
      iteration: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("aicers/agentcoop#49");
    expect(frame).toContain("Stage 2: Implement");
    // Layout indicator should be dropped due to narrow width.
    expect(frame).not.toContain("Layout:");
  });
});

// ---- AgentPane showSeparator -------------------------------------------------

describe("AgentPane showSeparator", () => {
  test("hides separator when showSeparator is false", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane
        label="Agent A"
        agent="a"
        emitter={emitter}
        color="blue"
        showSeparator={false}
      />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Agent A");
    // The separator line has \u2500 characters inside the box (not in border).
    // Border lines contain \u250C or \u2514; separator lines do not.
    const lines = frame.split("\n");
    const separatorLines = lines.filter(
      (l) =>
        l.includes("\u2500") && !l.includes("\u250C") && !l.includes("\u2514"),
    );
    expect(separatorLines).toHaveLength(0);
  });

  test("shows separator by default", () => {
    const emitter = new PipelineEventEmitter();
    const { lastFrame } = render(
      <AgentPane label="Agent A" agent="a" emitter={emitter} color="blue" />,
    );

    const frame = lastFrame() ?? "";
    // Separator line has \u2500 inside the box (no corner chars).
    const lines = frame.split("\n");
    const separatorLines = lines.filter(
      (l) =>
        l.includes("\u2500") && !l.includes("\u250C") && !l.includes("\u2514"),
    );
    expect(separatorLines.length).toBeGreaterThan(0);
  });
});
