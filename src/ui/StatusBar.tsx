import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type {
  PipelineEventEmitter,
  StageEnterEvent,
  StageExitEvent,
} from "../pipeline-events.js";

interface StatusBarProps {
  emitter: PipelineEventEmitter;
}

export function StatusBar({ emitter }: StatusBarProps) {
  const [stage, setStage] = useState<StageEnterEvent | null>(null);
  const [lastOutcome, setLastOutcome] = useState<string | null>(null);

  useEffect(() => {
    const onEnter = (ev: StageEnterEvent) => {
      setStage(ev);
      setLastOutcome(null);
    };
    const onExit = (ev: StageExitEvent) => {
      setLastOutcome(ev.outcome);
    };
    emitter.on("stage:enter", onEnter);
    emitter.on("stage:exit", onExit);
    return () => {
      emitter.off("stage:enter", onEnter);
      emitter.off("stage:exit", onExit);
    };
  }, [emitter]);

  const stageText = stage
    ? `Stage ${stage.stageNumber}: ${stage.stageName}`
    : "Initialising...";

  const iterText = stage ? `Loop: ${stage.iteration}` : "";

  const outcomeText = lastOutcome ? `Last: ${lastOutcome}` : "";

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold>{stageText}</Text>
      {iterText && (
        <Text>
          {"  |  "}
          {iterText}
        </Text>
      )}
      {outcomeText && (
        <Text>
          {"  |  "}
          {outcomeText}
        </Text>
      )}
    </Box>
  );
}
