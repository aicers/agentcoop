import { Box, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
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
  pipelineOptions: Omit<PipelineOptions, "prompt" | "events">;
  onExit: (result: PipelineResult) => void;
  /** Called once the TUI prompt is ready, so callers can late-bind to it. */
  onPromptReady?: (prompt: UserPrompt) => void;
  /** Display name for Agent A (e.g., "Claude Opus 4.6 (1M) / Max"). */
  modelNameA?: string;
  /** Display name for Agent B (e.g., "GPT-5.4"). */
  modelNameB?: string;
}

export function App({
  emitter,
  pipelineOptions,
  onExit,
  onPromptReady,
  modelNameA,
  modelNameB,
}: AppProps) {
  const terminalHeight = useTerminalHeight();
  const [inputRequest, setInputRequest] = useState<InputRequest | null>(null);
  const resolveRef = useRef<((value: string) => void) | null>(null);
  const [focusedPane, setFocusedPane] = useState<"a" | "b">("a");
  const [activeAgent, setActiveAgent] = useState<"a" | "b" | null>(null);

  // Store props in refs so the mount effect never re-runs.
  const emitterRef = useRef(emitter);
  const optsRef = useRef(pipelineOptions);
  const onExitRef = useRef(onExit);
  const onPromptReadyRef = useRef(onPromptReady);

  const dispatch = useCallback((request: InputRequest): Promise<string> => {
    return new Promise<string>((resolve) => {
      resolveRef.current = resolve;
      setInputRequest(request);
    });
  }, []);

  const handleSubmit = useCallback((value: string) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setInputRequest(null);
  }, []);

  // Track which agent is currently running (independent of focused pane).
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

  // Switch focused pane with Tab (always active; no conflict with text input).
  useInput((_input, key) => {
    if (key.tab) {
      setFocusedPane((prev) => (prev === "a" ? "b" : "a"));
    }
  });

  // Run the pipeline once on mount.
  useEffect(() => {
    const prompt = createTuiUserPrompt(dispatch);
    onPromptReadyRef.current?.(prompt);

    runPipeline({
      ...optsRef.current,
      prompt,
      events: emitterRef.current,
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
  }, [dispatch]);

  return (
    <Box flexDirection="column" width="100%" height={terminalHeight ?? "100%"}>
      {/* Top row: two agent panes side by side */}
      <Box flexDirection="row" flexGrow={1}>
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

      {/* Bottom: status bar + input area */}
      <StatusBar
        emitter={emitter}
        owner={pipelineOptions.context.owner}
        repo={pipelineOptions.context.repo}
        issueNumber={pipelineOptions.context.issueNumber}
      />
      <InputArea request={inputRequest} onSubmit={handleSubmit} />
    </Box>
  );
}
