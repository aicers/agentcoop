import { Box, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NotificationSettings } from "../config.js";
import { t } from "../i18n/index.js";
import { notifyInputWaiting } from "../notify.js";
import type {
  PipelineOptions,
  PipelineResult,
  UserPrompt,
} from "../pipeline.js";
import { runPipeline } from "../pipeline.js";
import type {
  AgentInvokeEvent,
  PipelineEventEmitter,
  PrResolvedEvent,
} from "../pipeline-events.js";
import { AgentPane, splitIntoRows } from "./AgentPane.js";
import { InputArea, type InputRequest } from "./InputArea.js";
import { StatusBar } from "./StatusBar.js";
import { TokenBar } from "./TokenBar.js";
import { createTuiUserPrompt } from "./TuiUserPrompt.js";

// ---- Terminal helpers --------------------------------------------------------

/**
 * Reserve one column so no serialized output row reaches the exact terminal
 * edge.  Some terminals visually wrap at column N when N characters are
 * written, which confuses log-update's line counting and produces stale-row
 * artifacts (see issue #203).  Ink's output serialization trims trailing
 * spaces, so the gap is invisible.
 */
export function computeLayoutWidth(
  terminalWidth: number | undefined,
): number | undefined {
  return terminalWidth !== undefined ? terminalWidth - 1 : undefined;
}

/** Read terminal dimensions from stdout, re-rendering on resize. */
export function useTerminalDimensions(): {
  height: number | undefined;
  width: number | undefined;
} {
  const { stdout } = useStdout();
  const isTTY = stdout.isTTY === true;
  const [dims, setDims] = useState<{
    height: number | undefined;
    width: number | undefined;
  }>({
    height: isTTY ? stdout.rows : undefined,
    width: isTTY ? stdout.columns : undefined,
  });

  useEffect(() => {
    if (!isTTY) return;
    const onResize = () =>
      setDims({ height: stdout.rows, width: stdout.columns });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, isTTY]);

  return dims;
}

/** Read terminal height from stdout.rows, re-rendering on resize. */
export function useTerminalHeight(): number | undefined {
  return useTerminalDimensions().height;
}

// ---- Visibility flag computation ---------------------------------------------

/** Minimum content rows per agent pane before hiding UI elements. */
export const MIN_PANE_CONTENT = 3;

export interface VisibilityFlags {
  showTokenBar: boolean;
  showKeyHints: boolean;
  showPaneSeparator: boolean;
  allowColumnLayout: boolean;
}

interface VisibilityBudgetOptions {
  terminalWidth?: number;
  paneHeaderTexts?: readonly string[];
}

/** Compute the height of the InputArea in terminal rows. */
export function inputAreaHeight(request: InputRequest | null): number {
  if (!request) return 1;
  const messageLines = request.message.split("\n").length;
  if (request.choices) return messageLines + request.choices.length;
  return messageLines + 1;
}

/**
 * Compute flags for a specific layout, progressively hiding elements
 * until each agent pane has at least MIN_PANE_CONTENT rows.
 */
function computeFlagsForLayout(
  terminalHeight: number,
  inputHeight: number,
  hasTokenData: boolean,
  layout: "row" | "column",
  options: VisibilityBudgetOptions = {},
): VisibilityFlags {
  let showTokenBar = hasTokenData;
  let showKeyHints = true;
  let showPaneSeparator = true;
  let allowColumnLayout = true;

  function paneContentWidth(): number | undefined {
    if (options.terminalWidth === undefined) {
      return undefined;
    }

    const paneWidth =
      layout === "row"
        ? Math.floor(options.terminalWidth / 2)
        : options.terminalWidth;

    return Math.max(1, paneWidth - 4);
  }

  function paneHeaderRows(): number {
    const width = paneContentWidth();
    if (
      width === undefined ||
      !options.paneHeaderTexts ||
      options.paneHeaderTexts.length === 0
    ) {
      return 1;
    }

    return Math.max(
      1,
      ...options.paneHeaderTexts.map(
        (text) => splitIntoRows(text, width).length,
      ),
    );
  }

  function paneContentRows(
    tokenBar: boolean,
    keyHints: boolean,
    separator: boolean,
  ): number {
    // StatusBar: border (2) + issue line (1) + pipeline line (1) + optional key hints (1).
    const statusBarHeight = keyHints ? 5 : 4;
    // TokenBar is split into two boxes.  In row layout they sit side by
    // side (3 rows), in column layout they stack (6 rows).
    const tokenBarHeight = tokenBar ? (layout === "column" ? 6 : 3) : 0;
    const bottomChrome = inputHeight + statusBarHeight + tokenBarHeight;
    const paneArea = terminalHeight - bottomChrome;
    const paneOverhead = 2 + paneHeaderRows() + (separator ? 1 : 0);
    if (layout === "column") {
      return Math.floor(paneArea / 2) - paneOverhead;
    }
    return paneArea - paneOverhead;
  }

  // 1. Hide TokenBar (lowest information priority).
  if (
    paneContentRows(showTokenBar, showKeyHints, showPaneSeparator) <
    MIN_PANE_CONTENT
  ) {
    showTokenBar = false;
  }

  // 2. Hide StatusBar key hints line.
  if (
    paneContentRows(showTokenBar, showKeyHints, showPaneSeparator) <
    MIN_PANE_CONTENT
  ) {
    showKeyHints = false;
  }

  // 3. Hide AgentPane separator line (saves 1 row per pane).
  if (
    paneContentRows(showTokenBar, showKeyHints, showPaneSeparator) <
    MIN_PANE_CONTENT
  ) {
    showPaneSeparator = false;
  }

  // 4. Restrict column layout to prevent both panes from being unusable.
  if (
    layout === "column" &&
    paneContentRows(showTokenBar, showKeyHints, showPaneSeparator) <
      MIN_PANE_CONTENT
  ) {
    allowColumnLayout = false;
  }

  return { showTokenBar, showKeyHints, showPaneSeparator, allowColumnLayout };
}

/**
 * Compute which UI elements to show based on available terminal height.
 * Elements are hidden in priority order until each agent pane has at least
 * MIN_PANE_CONTENT rows of content space.
 *
 * When column layout is forced to row, the flags are recomputed for row
 * layout so we don't unnecessarily hide elements that fit in row mode.
 */
export function computeVisibilityFlags(
  terminalHeight: number,
  inputHeight: number,
  hasTokenData: boolean,
  preferredLayout: "row" | "column",
  options: VisibilityBudgetOptions = {},
): VisibilityFlags {
  const flags = computeFlagsForLayout(
    terminalHeight,
    inputHeight,
    hasTokenData,
    preferredLayout,
    options,
  );

  // When column is forced to row, recompute for the effective (row) layout
  // so that elements which fit in row mode are not hidden unnecessarily.
  if (!flags.allowColumnLayout && preferredLayout === "column") {
    const rowFlags = computeFlagsForLayout(
      terminalHeight,
      inputHeight,
      hasTokenData,
      "row",
      options,
    );
    rowFlags.allowColumnLayout = false;
    return rowFlags;
  }

  return flags;
}

// ---- App component -----------------------------------------------------------

export interface AppProps {
  emitter: PipelineEventEmitter;
  pipelineOptions: Omit<PipelineOptions, "prompt" | "events" | "signal">;
  onExit: (result: PipelineResult) => void;
  /** Called once the TUI prompt is ready, so callers can late-bind to it. */
  onPromptReady?: (prompt: UserPrompt) => void;
  /** Short model identifier for Agent A (e.g., "opus"). */
  modelNameA?: string;
  /** Short model identifier for Agent B (e.g., "gpt-5.4"). */
  modelNameB?: string;
  /** CLI identifier for Agent A (e.g. "claude" or "codex"). */
  cliTypeA?: string;
  /** CLI identifier for Agent B (e.g. "claude" or "codex"). */
  cliTypeB?: string;
  /** Notification settings (bell / desktop). */
  notifications?: NotificationSettings;
  /**
   * Called when the user presses Ctrl+C so the caller can kill running
   * agent child processes before the pipeline unwinds.
   */
  onCancel?: () => void;
  /** Timestamp (ms) when agentcoop started, for wall-clock elapsed time. */
  startedAt?: number;
  /** Persisted self-check count for StatusBar initialisation on resume. */
  initialSelfCheckCount?: number;
  /** Persisted review count for StatusBar initialisation on resume. */
  initialReviewCount?: number;
  /** Persisted PR number from RunState; seeds the StatusBar on resume. */
  initialPrNumber?: number;
}

export function App({
  emitter,
  pipelineOptions,
  onExit,
  onPromptReady,
  modelNameA,
  modelNameB,
  cliTypeA,
  cliTypeB,
  notifications,
  onCancel,
  startedAt,
  initialSelfCheckCount,
  initialReviewCount,
  initialPrNumber,
}: AppProps) {
  const { height: terminalHeight, width: terminalWidth } =
    useTerminalDimensions();

  const layoutWidth = computeLayoutWidth(terminalWidth);

  const messages = t();
  const [inputRequest, setInputRequest] = useState<InputRequest | null>(null);
  const resolveRef = useRef<((value: string) => void) | null>(null);
  const [focusedPane, setFocusedPane] = useState<"a" | "b">("a");
  const [activeAgent, setActiveAgent] = useState<"a" | "b" | null>(null);
  const [preferredLayout, setPreferredLayout] = useState<"row" | "column">(
    "row",
  );
  const [hasTokenData, setHasTokenData] = useState(false);
  const [prNumber, setPrNumber] = useState<number | undefined>(initialPrNumber);

  useEffect(() => {
    const onPrResolved = (ev: PrResolvedEvent) => setPrNumber(ev.prNumber);
    emitter.on("pr:resolved", onPrResolved);
    return () => {
      emitter.off("pr:resolved", onPrResolved);
    };
  }, [emitter]);

  // AbortController for pipeline cancellation on Ctrl+C.
  const abortController = useMemo(() => new AbortController(), []);
  const cancelledRef = useRef(false);

  // Store props in refs so the mount effect never re-runs.
  const emitterRef = useRef(emitter);
  const optsRef = useRef(pipelineOptions);
  const onExitRef = useRef(onExit);
  const onPromptReadyRef = useRef(onPromptReady);
  const onCancelRef = useRef(onCancel);

  // Track whether any token usage has been reported.
  useEffect(() => {
    const onUsage = () => setHasTokenData(true);
    emitter.on("agent:usage", onUsage);
    return () => {
      emitter.off("agent:usage", onUsage);
    };
  }, [emitter]);

  // Compute visibility flags based on terminal dimensions.
  const inputHeight = inputAreaHeight(inputRequest);
  const labelA = messages["agent.labelARole"];
  const labelB = messages["agent.labelBRole"];
  const paneHeaderTexts = useMemo(
    () => [
      `${modelNameA ? `${labelA} \u2014 ${modelNameA}` : labelA} \u25CF [*]`,
      `${modelNameB ? `${labelB} \u2014 ${modelNameB}` : labelB} \u25CF [*]`,
    ],
    [labelA, labelB, modelNameA, modelNameB],
  );
  const flags = useMemo<VisibilityFlags>(() => {
    if (terminalHeight === undefined) {
      return {
        showTokenBar: true,
        showKeyHints: true,
        showPaneSeparator: true,
        allowColumnLayout: true,
      };
    }
    return computeVisibilityFlags(
      terminalHeight,
      inputHeight,
      hasTokenData,
      preferredLayout,
      {
        terminalWidth: layoutWidth,
        paneHeaderTexts,
      },
    );
  }, [
    terminalHeight,
    inputHeight,
    hasTokenData,
    preferredLayout,
    layoutWidth,
    paneHeaderTexts,
  ]);

  const effectiveLayout =
    preferredLayout === "column" && !flags.allowColumnLayout
      ? "row"
      : preferredLayout;

  // Content width budget for bordered components (StatusBar, TokenBar):
  // layout width minus border (2) and paddingX (2).
  const borderedContentWidth =
    layoutWidth !== undefined ? layoutWidth - 4 : undefined;

  // Per-box content width for the split TokenBar.
  // Row layout: each box gets half the layout width.
  // Column layout: each box gets the full layout width.
  const tokenBarContentWidth =
    layoutWidth !== undefined
      ? effectiveLayout === "row"
        ? Math.floor(layoutWidth / 2) - 4
        : layoutWidth - 4
      : undefined;

  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;

  const dispatch = useCallback((request: InputRequest): Promise<string> => {
    return new Promise<string>((resolve) => {
      resolveRef.current = resolve;
      setInputRequest(request);
      if (notificationsRef.current) {
        notifyInputWaiting(notificationsRef.current, request.message);
      }
    });
  }, []);

  const handleSubmit = useCallback((value: string) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setInputRequest(null);
    // Defer resolution so the current keypress event is fully drained
    // before the next prompt's useInput handler is registered.
    setTimeout(() => resolve?.(value), 0);
  }, []);

  // Switch focused pane with Tab; toggle layout with Ctrl+L.
  // Ctrl+C triggers graceful cancellation.
  useInput((input, key) => {
    if (key.tab) {
      setFocusedPane((prev) => (prev === "a" ? "b" : "a"));
    }
    if (input === "l" && key.ctrl) {
      setPreferredLayout((prev) => (prev === "row" ? "column" : "row"));
    }
    if (input === "c" && key.ctrl && !cancelledRef.current) {
      cancelledRef.current = true;
      // Kill running agent child processes.
      onCancelRef.current?.();
      // Abort the pipeline.
      abortController.abort();
      // Force-resolve any pending dispatch so the pipeline can unwind.
      if (resolveRef.current) {
        const resolve = resolveRef.current;
        resolveRef.current = null;
        setInputRequest(null);
        setTimeout(() => resolve("__cancelled__"), 0);
      }
    }
  });

  // Track which agent is currently running.
  // Set on agent:invoke, cleared on stage:exit (no agent runs between stages).
  useEffect(() => {
    const onInvoke = (ev: AgentInvokeEvent) => setActiveAgent(ev.agent);
    const onStageExit = () => setActiveAgent(null);
    emitter.on("agent:invoke", onInvoke);
    emitter.on("stage:exit", onStageExit);
    return () => {
      emitter.off("agent:invoke", onInvoke);
      emitter.off("stage:exit", onStageExit);
    };
  }, [emitter]);

  // Run the pipeline once on mount.
  useEffect(() => {
    const prompt = createTuiUserPrompt(dispatch);
    onPromptReadyRef.current?.(prompt);

    runPipeline({
      ...optsRef.current,
      prompt,
      events: emitterRef.current,
      signal: abortController.signal,
    }).then(
      (result) => onExitRef.current(result),
      (err) => {
        onExitRef.current({
          success: false,
          stoppedAt: undefined,
          message: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }, [dispatch, abortController]);

  return (
    <Box
      flexDirection="column"
      width={layoutWidth ?? "100%"}
      height={terminalHeight ?? "100%"}
    >
      {/* Agent panes: side by side (row) or stacked (column) */}
      <Box flexDirection={effectiveLayout} flexGrow={1}>
        <AgentPane
          label={labelA}
          modelName={modelNameA}
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused={focusedPane === "a"}
          isActive={activeAgent === "a"}
          arrowScrollEnabled={!inputRequest}
          showSeparator={flags.showPaneSeparator}
        />
        <AgentPane
          label={labelB}
          modelName={modelNameB}
          agent="b"
          emitter={emitter}
          color="green"
          isFocused={focusedPane === "b"}
          isActive={activeAgent === "b"}
          arrowScrollEnabled={!inputRequest}
          showSeparator={flags.showPaneSeparator}
        />
      </Box>

      {/* Bottom: token bar + status bar + input area */}
      <TokenBar
        emitter={emitter}
        visible={flags.showTokenBar}
        contentWidth={tokenBarContentWidth}
        layout={effectiveLayout}
        cliTypeA={cliTypeA}
        cliTypeB={cliTypeB}
      />
      <StatusBar
        emitter={emitter}
        owner={pipelineOptions.context.owner}
        repo={pipelineOptions.context.repo}
        issueNumber={pipelineOptions.context.issueNumber}
        issueTitle={pipelineOptions.context.issueTitle}
        prNumber={prNumber}
        baseSha={pipelineOptions.context.baseSha}
        layout={effectiveLayout}
        showKeyHints={flags.showKeyHints}
        contentWidth={borderedContentWidth}
        paused={inputRequest !== null}
        startedAt={startedAt}
        initialSelfCheckCount={initialSelfCheckCount}
        initialReviewCount={initialReviewCount}
      />
      <InputArea request={inputRequest} onSubmit={handleSubmit} />
    </Box>
  );
}
