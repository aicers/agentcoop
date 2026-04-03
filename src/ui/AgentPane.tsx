import { Box, type DOMElement, measureElement, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import type {
  PipelineEventEmitter,
  StageEnterEvent,
} from "../pipeline-events.js";
import {
  PROMPT_LINE_PREFIX,
  PROMPT_SEPARATOR_CHAR,
  useAgentLines,
} from "./useEventEmitter.js";

/** Stage number at which Agent B becomes active. */
const REVIEW_STAGE = 8;

interface AgentPaneProps {
  label: string;
  agent: "a" | "b";
  emitter: PipelineEventEmitter;
  color: string;
}

export function AgentPane({ label, agent, emitter, color }: AgentPaneProps) {
  const { lines, pendingLine } = useAgentLines(emitter, agent);
  const containerRef = useRef<DOMElement>(null);
  const [visibleRows, setVisibleRows] = useState(20);
  const [contentWidth, setContentWidth] = useState(80);
  const [currentStage, setCurrentStage] = useState<number | null>(null);

  // Track the current pipeline stage for idle status display.
  useEffect(() => {
    const onStageEnter = (ev: StageEnterEvent) => {
      setCurrentStage(ev.stageNumber);
    };
    emitter.on("stage:enter", onStageEnter);
    return () => {
      emitter.off("stage:enter", onStageEnter);
    };
  }, [emitter]);

  // Measure the content area after each render so we know
  // exactly how many lines fit without relying on heuristics.
  useEffect(() => {
    if (containerRef.current) {
      const { height, width } = measureElement(containerRef.current);
      // Reserve 2 rows for the top/bottom border and 1 for the label.
      setVisibleRows(height > 3 ? height - 3 : 0);
      // Subtract 2 for paddingX={1} (left + right).
      setContentWidth(width > 2 ? width - 2 : 1);
    }
  });

  const allLines = pendingLine ? [...lines, pendingLine] : lines;

  // Tail by rendered rows, not logical lines. Each logical line may
  // wrap into multiple terminal rows when wrap="wrap" is active.
  let visible: string[];
  if (visibleRows === 0) {
    visible = [];
  } else {
    let rowBudget = visibleRows;
    let startIdx = allLines.length;
    while (startIdx > 0 && rowBudget > 0) {
      startIdx--;
      const lineRows = Math.max(
        1,
        Math.ceil(allLines[startIdx].length / contentWidth),
      );
      rowBudget -= lineRows;
    }
    // If the first included line overflows the budget, still include it
    // (Ink will clip the top via overflow="hidden", showing the tail).
    if (startIdx < 0) startIdx = 0;
    visible = allLines.slice(startIdx);
  }

  const hasOutput = allLines.length > 0;

  let placeholder: string | undefined;
  if (visible.length === 0) {
    const m = t();
    if (hasOutput) {
      placeholder = m["agentPane.tooSmall"];
    } else if (
      agent === "b" &&
      currentStage !== null &&
      currentStage < REVIEW_STAGE
    ) {
      placeholder = m["agentPane.idle"];
    } else {
      placeholder = m["agentPane.waiting"];
    }
  }

  return (
    <Box
      ref={containerRef}
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      borderStyle="single"
      borderColor={color}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color={color}>
        {label}
      </Text>
      {placeholder !== undefined ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        visible.map((line, i) => {
          const isPromptLine =
            line.startsWith(PROMPT_LINE_PREFIX) ||
            line.startsWith(PROMPT_SEPARATOR_CHAR);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are plain strings without stable IDs
            <Text key={i} wrap="wrap" dimColor={isPromptLine}>
              {line}
            </Text>
          );
        })
      )}
    </Box>
  );
}
