import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.js";
import type {
  PipelineEventEmitter,
  StageEnterEvent,
  StageExitEvent,
} from "../pipeline-events.js";

/** Stage number for the self-check stage. */
const SELF_CHECK_STAGE = 3;
/** Stage number for the review stage. */
const REVIEW_STAGE = 7;

interface StatusBarProps {
  emitter: PipelineEventEmitter;
  owner: string;
  repo: string;
  issueNumber: number;
  /** Full SHA of the base commit; displayed abbreviated in the bar. */
  baseSha?: string;
  /** Current pane layout direction. */
  layout?: "row" | "column";
}

export function StatusBar({
  emitter,
  owner,
  repo,
  issueNumber,
  baseSha,
  layout,
}: StatusBarProps) {
  const [stage, setStage] = useState<StageEnterEvent | null>(null);
  const [lastOutcome, setLastOutcome] = useState<string | null>(null);
  const [roundDone, setRoundDone] = useState(false);
  const [selfCheckCount, setSelfCheckCount] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);

  useEffect(() => {
    const onEnter = (ev: StageEnterEvent) => {
      setStage(ev);
      setLastOutcome(null);
      setRoundDone(false);
    };
    const onExit = (ev: StageExitEvent) => {
      setLastOutcome(ev.outcome);
      setRoundDone(true);
      if (ev.stageNumber === SELF_CHECK_STAGE) {
        setSelfCheckCount((c) => c + 1);
      } else if (ev.stageNumber === REVIEW_STAGE) {
        setReviewCount((c) => c + 1);
      }
    };
    emitter.on("stage:enter", onEnter);
    emitter.on("stage:exit", onExit);
    return () => {
      emitter.off("stage:enter", onEnter);
      emitter.off("stage:exit", onExit);
    };
  }, [emitter]);

  const m = t();

  // Show current round (1-based) only on stages that can iterate.
  const showRound =
    stage !== null &&
    (stage.stageNumber === SELF_CHECK_STAGE ||
      stage.stageNumber === REVIEW_STAGE);
  const round = stage ? stage.iteration + 1 : 0;

  const stageText = stage
    ? showRound
      ? roundDone
        ? m["statusBar.stageRoundDone"](
            stage.stageNumber,
            stage.stageName,
            round,
          )
        : m["statusBar.stageRoundInProgress"](
            stage.stageNumber,
            stage.stageName,
            round,
          )
      : m["statusBar.stage"](stage.stageNumber, stage.stageName)
    : m["statusBar.initialising"];

  const outcomeKey = lastOutcome
    ? (`outcome.${lastOutcome}` as keyof typeof m)
    : undefined;
  const outcomeLabel =
    outcomeKey && outcomeKey in m ? (m[outcomeKey] as string) : lastOutcome;
  const outcomeText = outcomeLabel ? m["statusBar.last"](outcomeLabel) : "";

  const issueLabel = `${owner}/${repo}#${issueNumber}`;
  const baseText = baseSha ? m["statusBar.base"](baseSha.slice(0, 7)) : "";
  const layoutText = layout
    ? m["statusBar.layout"](
        layout === "row"
          ? m["statusBar.layoutHorizontal"]
          : m["statusBar.layoutVertical"],
      )
    : "";

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
      flexShrink={0}
    >
      <Box>
        <Text bold color="cyan">
          {issueLabel}
        </Text>
        {baseText && (
          <Text>
            {"  |  "}
            {baseText}
          </Text>
        )}
        <Text>{"  |  "}</Text>
        <Text bold>{stageText}</Text>
        {outcomeText && (
          <Text>
            {"  |  "}
            {outcomeText}
          </Text>
        )}
        {(selfCheckCount > 0 || reviewCount > 0) && (
          <Text>
            {"  |  "}
            {m["statusBar.completed"](selfCheckCount, reviewCount)}
          </Text>
        )}
        {layoutText && (
          <Text>
            {"  |  "}
            {layoutText}
          </Text>
        )}
      </Box>
      <Text dimColor>{m["statusBar.keyHints"]}</Text>
    </Box>
  );
}
