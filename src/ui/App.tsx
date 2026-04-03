import { Box } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import type {
  PipelineOptions,
  PipelineResult,
  UserPrompt,
} from "../pipeline.js";
import { runPipeline } from "../pipeline.js";
import type { PipelineEventEmitter } from "../pipeline-events.js";
import { AgentPane } from "./AgentPane.js";
import { InputArea, type InputRequest } from "./InputArea.js";
import { StatusBar } from "./StatusBar.js";
import { createTuiUserPrompt } from "./TuiUserPrompt.js";

export interface AppProps {
  emitter: PipelineEventEmitter;
  pipelineOptions: Omit<PipelineOptions, "prompt" | "events">;
  onExit: (result: PipelineResult) => void;
  /** Called once the TUI prompt is ready, so callers can late-bind to it. */
  onPromptReady?: (prompt: UserPrompt) => void;
}

export function App({
  emitter,
  pipelineOptions,
  onExit,
  onPromptReady,
}: AppProps) {
  const [inputRequest, setInputRequest] = useState<InputRequest | null>(null);
  const resolveRef = useRef<((value: string) => void) | null>(null);

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
    <Box flexDirection="column" width="100%" height="100%">
      {/* Top row: two agent panes side by side */}
      <Box flexDirection="row" flexGrow={1}>
        <AgentPane
          label={t()["agent.labelARole"]}
          agent="a"
          emitter={emitter}
          color="blue"
        />
        <AgentPane
          label={t()["agent.labelBRole"]}
          agent="b"
          emitter={emitter}
          color="green"
        />
      </Box>

      {/* Bottom: status bar + input area */}
      <StatusBar emitter={emitter} />
      <InputArea request={inputRequest} onSubmit={handleSubmit} />
    </Box>
  );
}
