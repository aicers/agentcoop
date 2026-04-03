import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.js";
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
  const [roundDone, setRoundDone] = useState(false);

  useEffect(() => {
    const onEnter = (ev: StageEnterEvent) => {
      setStage(ev);
      setLastOutcome(null);
      setRoundDone(false);
    };
    const onExit = (ev: StageExitEvent) => {
      setLastOutcome(ev.outcome);
      setRoundDone(true);
    };
    emitter.on("stage:enter", onEnter);
    emitter.on("stage:exit", onExit);
    return () => {
      emitter.off("stage:enter", onEnter);
      emitter.off("stage:exit", onExit);
    };
  }, [emitter]);

  const m = t();

  const stageText = stage
    ? m["statusBar.stage"](stage.stageNumber, stage.stageName)
    : m["statusBar.initialising"];

  // Show current round (1-based) with in-progress/done status.
  const round = stage ? stage.iteration + 1 : 0;
  const iterText = stage
    ? roundDone
      ? m["statusBar.roundDone"](round)
      : m["statusBar.roundInProgress"](round)
    : "";

  const outcomeKey = lastOutcome
    ? (`outcome.${lastOutcome}` as keyof typeof m)
    : undefined;
  const outcomeLabel =
    outcomeKey && outcomeKey in m ? (m[outcomeKey] as string) : lastOutcome;
  const outcomeText = outcomeLabel ? m["statusBar.last"](outcomeLabel) : "";

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
