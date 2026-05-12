import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n/index.js";
import { PipelineEventEmitter } from "../pipeline-events.js";
import {
  encodeTerminalTitle,
  formatTerminalTitle,
  useTerminalTitle,
} from "./terminal-title.js";

// ---- formatTerminalTitle -----------------------------------------------------

describe("formatTerminalTitle", () => {
  test("no PR, with stageLabel", () => {
    expect(
      formatTerminalTitle({
        owner: "aicers",
        repo: "aice-web-next",
        issueNumber: 524,
        stageLabel: "Stage 1: Bootstrap",
      }),
    ).toBe("aicers/aice-web-next#524 Stage 1: Bootstrap");
  });

  test("with PR and stageLabel", () => {
    expect(
      formatTerminalTitle({
        owner: "aicers",
        repo: "aice-web-next",
        issueNumber: 524,
        prNumber: 531,
        stageLabel: "Stage 7: Review (round 4)",
      }),
    ).toBe("aicers/aice-web-next#524 (#531) Stage 7: Review (round 4)");
  });

  test("missing stageLabel — no trailing whitespace", () => {
    const out = formatTerminalTitle({
      owner: "aicers",
      repo: "agentcoop",
      issueNumber: 329,
    });
    expect(out).toBe("aicers/agentcoop#329");
    expect(out).not.toMatch(/\s$/);
  });

  test("missing stageLabel with PR", () => {
    expect(
      formatTerminalTitle({
        owner: "aicers",
        repo: "agentcoop",
        issueNumber: 329,
        prNumber: 999,
      }),
    ).toBe("aicers/agentcoop#329 (#999)");
  });

  test("transitional stageLabel passes through verbatim", () => {
    expect(
      formatTerminalTitle({
        owner: "o",
        repo: "r",
        issueNumber: 1,
        stageLabel: "Stage 1: Bootstrap → Stage 5: CI check",
      }),
    ).toBe("o/r#1 Stage 1: Bootstrap → Stage 5: CI check");
  });

  test("empty stageLabel treated as missing", () => {
    expect(
      formatTerminalTitle({
        owner: "o",
        repo: "r",
        issueNumber: 1,
        stageLabel: "",
      }),
    ).toBe("o/r#1");
  });
});

// ---- encodeTerminalTitle -----------------------------------------------------

describe("encodeTerminalTitle", () => {
  test("default — OSC 0 form", () => {
    expect(encodeTerminalTitle("hello", {})).toBe("\x1b]0;hello\x07");
  });

  test("TMUX env set — DCS passthrough plus screen window-name", () => {
    expect(
      encodeTerminalTitle("hi", { TMUX: "/tmp/tmux-1000/default,123,0" }),
    ).toBe("\x1bPtmux;\x1b\x1b]0;hi\x07\x1b\\\x1bkhi\x1b\\");
  });

  test("TERM starts with tmux — DCS passthrough", () => {
    expect(encodeTerminalTitle("hi", { TERM: "tmux-256color" })).toBe(
      "\x1bPtmux;\x1b\x1b]0;hi\x07\x1b\\\x1bkhi\x1b\\",
    );
  });

  test("TERM starts with screen, no TMUX — screen window-name", () => {
    expect(encodeTerminalTitle("hi", { TERM: "screen-256color" })).toBe(
      "\x1bkhi\x1b\\",
    );
  });

  test("cmux env set — OSC 0 form", () => {
    expect(
      encodeTerminalTitle("hi", {
        CMUX_WORKSPACE_ID: "ws-1",
        CMUX_SURFACE_ID: "sf-2",
        TERM: "xterm-ghostty",
        TERM_PROGRAM: "ghostty",
      } as never),
    ).toBe("\x1b]0;hi\x07");
  });

  test("strips control characters from title (BEL, ESC)", () => {
    const title = "ok\x07bad\x1b]0;evil\x07";
    const out = encodeTerminalTitle(title, {});
    expect(out).not.toContain("\x07bad");
    expect(out).not.toContain("\x1b]0;evil");
    // Outer wrapper still uses the trailing BEL — there is exactly one.
    const bel = "\x07";
    const oscOpen = "\x1b]0;";
    expect(out.split(bel).length - 1).toBe(1);
    // Outer wrapper still uses ESC ] 0 ; once at the start.
    expect(out.split(oscOpen).length - 1).toBe(1);
  });

  test("TMUX takes precedence over screen TERM", () => {
    // TMUX wins so we still emit the DCS passthrough form.
    const out = encodeTerminalTitle("hi", {
      TMUX: "x",
      TERM: "screen-256color",
    });
    expect(out.startsWith("\x1bPtmux;")).toBe(true);
  });
});

// ---- useTerminalTitle hook (ink integration) ---------------------------------

import type React from "react";

function HookHost(props: React.ComponentProps<typeof HookHostInner>) {
  return <HookHostInner {...props} />;
}

function HookHostInner(args: Parameters<typeof useTerminalTitle>[0]) {
  useTerminalTitle(args);
  return null;
}

describe("useTerminalTitle", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;
  let originalTERM: string | undefined;
  let originalTMUX: string | undefined;

  beforeEach(() => {
    initI18n("en");
    originalIsTTY = process.stdout.isTTY;
    originalTERM = process.env.TERM;
    originalTMUX = process.env.TMUX;
    delete process.env.TMUX;
    process.env.TERM = "xterm-256color";
    writeSpy = vi
      .spyOn(process.stdout, "write")
      // biome-ignore lint/suspicious/noExplicitAny: stub
      .mockImplementation((() => true) as any);
  });

  afterEach(() => {
    cleanup();
    writeSpy.mockRestore();
    if (originalIsTTY === undefined) {
      delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
    } else {
      process.stdout.isTTY = originalIsTTY;
    }
    if (originalTERM === undefined) delete process.env.TERM;
    else process.env.TERM = originalTERM;
    if (originalTMUX === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTMUX;
  });

  test("writes nothing when stdout is not a TTY", async () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = false;
    const emitter = new PipelineEventEmitter();
    render(
      <HookHost
        emitter={emitter}
        owner="o"
        repo="r"
        issueNumber={1}
        firstExecutingStage={2}
      />,
    );
    emitter.emit("stage:enter", {
      stageNumber: 2,
      stageName: "Implement",
      iteration: 0,
    });
    await vi.waitFor(() => {
      // Nothing scheduled.  The write spy must not have seen any
      // OSC/DCS bytes.
    });
    const calls = writeSpy.mock.calls.flat().join("");
    expect(calls).not.toContain("\x1b]0;");
    expect(calls).not.toContain("\x1bPtmux;");
    expect(calls).not.toContain("\x1bk");
  });

  test("writes OSC 0 with the composed title on stage:enter", async () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = true;
    const emitter = new PipelineEventEmitter();
    render(
      <HookHost
        emitter={emitter}
        owner="aicers"
        repo="agentcoop"
        issueNumber={329}
        firstExecutingStage={2}
      />,
    );

    // Initial transitional title.
    await vi.waitFor(() => {
      const calls = writeSpy.mock.calls.flat().join("");
      expect(calls).toContain(
        "\x1b]0;aicers/agentcoop#329 Stage 1: Bootstrap → Stage 2: Implement\x07",
      );
    });

    writeSpy.mockClear();
    emitter.emit("stage:enter", {
      stageNumber: 2,
      stageName: "Implement",
      iteration: 0,
    });
    await vi.waitFor(() => {
      const calls = writeSpy.mock.calls.flat().join("");
      expect(calls).toContain(
        "\x1b]0;aicers/agentcoop#329 Stage 2: Implement\x07",
      );
    });
  });

  test("includes (round R) only on iterating stages", async () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = true;
    const emitter = new PipelineEventEmitter();
    render(<HookHost emitter={emitter} owner="o" repo="r" issueNumber={1} />);

    // Non-iterating: Stage 2 (Implement) — no round suffix.
    emitter.emit("stage:enter", {
      stageNumber: 2,
      stageName: "Implement",
      iteration: 3,
    });
    await vi.waitFor(() => {
      const calls = writeSpy.mock.calls.flat().join("");
      expect(calls).toContain("\x1b]0;o/r#1 Stage 2: Implement\x07");
    });
    expect(writeSpy.mock.calls.flat().join("")).not.toContain("(round");

    writeSpy.mockClear();

    // Iterating: Stage 7 (Review) — round suffix from iteration + 1.
    emitter.emit("stage:enter", {
      stageNumber: 7,
      stageName: "Review",
      iteration: 3,
    });
    await vi.waitFor(() => {
      const calls = writeSpy.mock.calls.flat().join("");
      expect(calls).toContain("\x1b]0;o/r#1 Stage 7: Review (round 4)\x07");
    });
  });

  test("includes (#PR) after pr:resolved", async () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = true;
    const emitter = new PipelineEventEmitter();
    render(<HookHost emitter={emitter} owner="o" repo="r" issueNumber={1} />);

    emitter.emit("stage:enter", {
      stageNumber: 7,
      stageName: "Review",
      iteration: 0,
    });
    emitter.emit("pr:resolved", { prNumber: 42 });
    await vi.waitFor(() => {
      const calls = writeSpy.mock.calls.flat().join("");
      expect(calls).toContain(
        "\x1b]0;o/r#1 (#42) Stage 7: Review (round 1)\x07",
      );
    });
  });

  test("does not write on every render — only when title changes", async () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = true;
    const emitter = new PipelineEventEmitter();
    const { rerender } = render(
      <HookHost
        emitter={emitter}
        owner="o"
        repo="r"
        issueNumber={1}
        firstExecutingStage={2}
      />,
    );

    await vi.waitFor(() => {
      expect(writeSpy.mock.calls.length).toBeGreaterThan(0);
    });
    const initialWrites = writeSpy.mock.calls.length;

    // Re-render with identical props — no additional title writes.
    rerender(
      <HookHost
        emitter={emitter}
        owner="o"
        repo="r"
        issueNumber={1}
        firstExecutingStage={2}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writeSpy.mock.calls.length).toBe(initialWrites);
  });

  test("stage:name-override updates the title", async () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = true;
    const emitter = new PipelineEventEmitter();
    render(<HookHost emitter={emitter} owner="o" repo="r" issueNumber={1} />);

    emitter.emit("stage:enter", {
      stageNumber: 5,
      stageName: "CI check",
      iteration: 0,
    });
    emitter.emit("stage:name-override", { stageName: "CI fix" });
    await vi.waitFor(() => {
      const calls = writeSpy.mock.calls.flat().join("");
      expect(calls).toContain("\x1b]0;o/r#1 Stage 5: CI fix\x07");
    });
  });
});
