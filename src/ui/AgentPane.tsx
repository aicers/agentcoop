import { Box, type DOMElement, measureElement, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import wrapAnsi from "wrap-ansi";
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
const REVIEW_STAGE = 7;

/** Split a logical line into terminal rows of the given width. */
export function splitIntoRows(line: string, width: number): string[] {
  if (width < 1) return [line];
  const wrapped = wrapAnsi(line, width, { hard: true, trim: false });
  return wrapped.split("\n");
}

/** A single terminal row tagged with display metadata. */
interface RowEntry {
  text: string;
  isPrompt: boolean;
  /** Index of the parent logical line in allLines. */
  lineIdx: number;
}

interface AgentPaneProps {
  label: string;
  modelName?: string;
  agent: "a" | "b";
  emitter: PipelineEventEmitter;
  color: string;
  /** Whether this pane currently has keyboard focus for scrolling. */
  isFocused?: boolean;
  /** Whether this agent is currently running (producing output). */
  isActive?: boolean;
  /** Whether up/down arrow scrolling is active (false during input prompts). */
  arrowScrollEnabled?: boolean;
}

export function AgentPane({
  label,
  modelName,
  agent,
  emitter,
  color,
  isFocused = false,
  isActive = false,
  arrowScrollEnabled = false,
}: AgentPaneProps) {
  const { lines, pendingLine } = useAgentLines(emitter, agent);
  const containerRef = useRef<DOMElement>(null);
  const [visibleRows, setVisibleRows] = useState(20);
  const [contentWidth, setContentWidth] = useState(80);
  const [currentStage, setCurrentStage] = useState<number | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const prevTotalRowsRef = useRef(0);

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
      // Reserve 2 rows for top/bottom border, 1 for label, 1 for separator.
      setVisibleRows(height > 4 ? height - 4 : 0);
      // Subtract 4 for borderStyle="single" (2) + paddingX={1} (2).
      setContentWidth(width > 4 ? width - 4 : 1);
    }
  });

  const allLines = pendingLine ? [...lines, pendingLine] : lines;

  // Build a flat array of terminal rows from logical lines so that
  // scrolling operates at the row level, correctly handling wrapped
  // lines that span multiple terminal rows.
  const allRows: RowEntry[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const isPrompt =
      line.startsWith(PROMPT_LINE_PREFIX) ||
      line.startsWith(PROMPT_SEPARATOR_CHAR);
    for (const row of splitIntoRows(line, contentWidth)) {
      allRows.push({ text: row, isPrompt, lineIdx: i });
    }
  }

  const totalRows = allRows.length;
  const maxOffset = Math.max(0, totalRows - visibleRows);
  const effectiveOffset = Math.min(scrollOffset, maxOffset);

  // Auto-adjust scrollOffset when total rows grow (new completed lines
  // or pendingLine wrapping further) to keep the viewport stable while
  // the user is scrolled up.
  useEffect(() => {
    const prev = prevTotalRowsRef.current;
    prevTotalRowsRef.current = totalRows;
    if (totalRows > prev && prev > 0) {
      setScrollOffset((o) => (o > 0 ? o + (totalRows - prev) : 0));
    }
  }, [totalRows]);

  // Clamp scrollOffset when it exceeds the valid range (e.g. after
  // the pane is resized or the user over-scrolls with Page Up).
  useEffect(() => {
    if (scrollOffset > 0 && scrollOffset > maxOffset) {
      setScrollOffset(Math.max(0, maxOffset));
    }
  }, [scrollOffset, maxOffset]);

  // PageUp/PageDown: always active when focused (no conflict with text input).
  useInput(
    (_input, key) => {
      if (key.pageUp) {
        setScrollOffset((o) => o + visibleRows);
      } else if (key.pageDown) {
        setScrollOffset((o) => Math.max(0, o - visibleRows));
      }
    },
    { isActive: isFocused },
  );

  // Up/Down arrows: disabled during input prompts to avoid conflicts.
  useInput(
    (_input, key) => {
      if (key.upArrow) {
        setScrollOffset((o) => o + 1);
      } else if (key.downArrow) {
        setScrollOffset((o) => Math.max(0, o - 1));
      }
    },
    { isActive: isFocused && arrowScrollEnabled },
  );

  // Compute the visible window from the flat row array.
  let visibleRowEntries: RowEntry[];
  let linesAbove = 0;

  if (visibleRows === 0) {
    visibleRowEntries = [];
  } else if (effectiveOffset === 0) {
    // Bottom-pinned (auto-follow).
    const startRow = Math.max(0, totalRows - visibleRows);
    visibleRowEntries = allRows.slice(startRow);
    linesAbove = startRow > 0 ? allRows[startRow].lineIdx : 0;
  } else {
    // Scrolled up: row-level window.
    const endRow = totalRows - effectiveOffset;

    // First pass: fill the viewport without the indicator.
    let startRow = Math.max(0, endRow - visibleRows);
    linesAbove = startRow > 0 ? allRows[startRow].lineIdx : 0;

    // If there are logical lines fully above the viewport the scroll
    // indicator will be rendered, so reclaim 1 row for it.
    if (linesAbove > 0) {
      startRow = Math.max(0, endRow - (visibleRows - 1));
      linesAbove = allRows[startRow].lineIdx;
    }

    visibleRowEntries = allRows.slice(startRow, endRow);
  }

  const hasOutput = allLines.length > 0;

  let placeholder: string | undefined;
  if (visibleRowEntries.length === 0 && effectiveOffset === 0) {
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

  const scrollIndicator =
    effectiveOffset > 0 && linesAbove > 0
      ? t()["agentPane.linesAbove"](linesAbove)
      : undefined;

  // Dim unfocused pane border so the focused pane is always distinguishable.
  const borderCol = isFocused ? color : "gray";

  return (
    <Box
      ref={containerRef}
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      borderStyle="single"
      borderColor={borderCol}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color={borderCol}>
        {modelName ? `${label} \u2014 ${modelName}` : label}
        {isActive ? " \u25CF" : ""}
        {isFocused ? " [*]" : ""}
      </Text>
      <Text dimColor>{"\u2500".repeat(contentWidth)}</Text>
      {placeholder !== undefined ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        <>
          {scrollIndicator && <Text dimColor>{scrollIndicator}</Text>}
          {visibleRowEntries.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are derived without stable IDs
            <Text key={i} dimColor={row.isPrompt}>
              {row.text}
            </Text>
          ))}
        </>
      )}
    </Box>
  );
}
