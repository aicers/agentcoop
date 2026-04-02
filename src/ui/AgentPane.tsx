import { Box, type DOMElement, measureElement, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { PipelineEventEmitter } from "../pipeline-events.js";
import { useAgentLines } from "./useEventEmitter.js";

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

  // Measure the content area after each render so we know
  // exactly how many lines fit without relying on heuristics.
  useEffect(() => {
    if (containerRef.current) {
      const { height } = measureElement(containerRef.current);
      // Reserve 2 rows for the top/bottom border and 1 for the label.
      setVisibleRows(height > 3 ? height - 3 : 0);
    }
  });

  const allLines = pendingLine ? [...lines, pendingLine] : lines;
  const visible =
    visibleRows === 0
      ? []
      : allLines.length > visibleRows
        ? allLines.slice(-visibleRows)
        : allLines;

  const hasOutput = allLines.length > 0;

  let placeholder: string | undefined;
  if (visible.length === 0) {
    placeholder = hasOutput ? "(pane too small)" : "(waiting for output)";
  }

  return (
    <Box
      ref={containerRef}
      flexDirection="column"
      flexGrow={1}
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
        visible.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are plain strings without stable IDs
          <Text key={i} wrap="truncate">
            {line}
          </Text>
        ))
      )}
    </Box>
  );
}
