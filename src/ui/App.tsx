import { Box, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import type {
  PipelineOptions,
  PipelineResult,
  UserPrompt,
} from "../pipeline.js";
import { runPipeline } from "../pipeline.js";
import type {
  AgentInvokeEvent,
  PipelineEventEmitter,
} from "../pipeline-events.js";
import { AgentPane } from "./AgentPane.js";
import { InputArea, type InputRequest } from "./InputArea.js";
import { StatusBar } from "./StatusBar.js";
import { TokenBar } from "./TokenBar.js";
import { createTuiUserPrompt } from "./TuiUserPrompt.js";

/** Read terminal height from stdout.rows, re-rendering on resize. */
export function useTerminalHeight(): number | undefined {
  const { stdout } = useStdout();
  const isTTY = stdout.isTTY === true;
  const [height, setHeight] = useState<number | undefined>(
    isTTY ? stdout.rows : undefined,
  );

  useEffect(() => {
    if (!isTTY) return;
    const onResize = () => setHeight(stdout.rows);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout, isTTY]);

  return height;
}

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
  /**
   * Called when the user presses Ctrl+C so the caller can kill running
   * agent child processes before the pipeline unwinds.
   */
  onCancel?: () => void;
}

export function App({
  emitter,
  pipelineOptions,
  onExit,
  onPromptReady,
  modelNameA,
  modelNameB,
  onCancel,
}: AppProps) {
  const terminalHeight = useTerminalHeight();
  const [inputRequest, setInputRequest] = useState<InputRequest | null>(null);
  const resolveRef = useRef<((value: string) => void) | null>(null);
  const [focusedPane, setFocusedPane] = useState<"a" | "b">("a");
  const [activeAgent, setActiveAgent] = useState<"a" | "b" | null>(null);
  const [layout, setLayout] = useState<"row" | "column">("row");

  // AbortController for pipeline cancellation on Ctrl+C.
  const abortController = useMemo(() => new AbortController(), []);
  const cancelledRef = useRef(false);

  // Store props in refs so the mount effect never re-runs.
  const emitterRef = useRef(emitter);
  const optsRef = useRef(pipelineOptions);
  const onExitRef = useRef(onExit);
  const onPromptReadyRef = useRef(onPromptReady);
  const onCancelRef = useRef(onCancel);

  const dispatch = useCallback((request: InputRequest): Promise<string> => {
    return new Promise<string>((resolve) => {
      resolveRef.current = resolve;
      setInputRequest(request);
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
      setLayout((prev) => (prev === "row" ? "column" : "row"));
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
    <Box flexDirection="column" width="100%" height={terminalHeight ?? "100%"}>
      {/* Agent panes: side by side (row) or stacked (column) */}
      <Box flexDirection={layout} flexGrow={1}>
        <AgentPane
          label={t()["agent.labelARole"]}
          modelName={modelNameA}
          agent="a"
          emitter={emitter}
          color="blue"
          isFocused={focusedPane === "a"}
          isActive={activeAgent === "a"}
          arrowScrollEnabled={!inputRequest}
        />
        <AgentPane
          label={t()["agent.labelBRole"]}
          modelName={modelNameB}
          agent="b"
          emitter={emitter}
          color="green"
          isFocused={focusedPane === "b"}
          isActive={activeAgent === "b"}
          arrowScrollEnabled={!inputRequest}
        />
      </Box>

      {/* Bottom: token bar + status bar + input area */}
      <TokenBar emitter={emitter} />
      <StatusBar
        emitter={emitter}
        owner={pipelineOptions.context.owner}
        repo={pipelineOptions.context.repo}
        issueNumber={pipelineOptions.context.issueNumber}
        baseSha={pipelineOptions.context.baseSha}
        layout={layout}
      />
      <InputArea request={inputRequest} onSubmit={handleSubmit} />
    </Box>
  );
}
