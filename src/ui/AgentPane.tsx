import { Box, type DOMElement, measureElement, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import wrapAnsi from "wrap-ansi";
import type { BootstrapLogEntry } from "../bootstrap-log.js";
import { t } from "../i18n/index.js";
import type {
  PipelineEventEmitter,
  StageEnterEvent,
} from "../pipeline-events.js";
import {
  type DiagnosticBlock,
  type LineEntry,
  PROMPT_LINE_PREFIX,
  PROMPT_SEPARATOR_CHAR,
  type PromptBlock,
  useAgentLines,
} from "./useEventEmitter.js";

/** Stage number at which Agent B becomes active. */
const REVIEW_STAGE = 7;

/** Maximum number of wrapped content rows in a rendered prompt block. */
const MAX_PROMPT_ROWS = 12;

/** Split a logical line into terminal rows of the given width. */
export function splitIntoRows(line: string, width: number): string[] {
  if (width < 1) return [line];
  const wrapped = wrapAnsi(line, width, { hard: true, trim: false });
  return wrapped.split("\n");
}

/**
 * Render a structured prompt block into terminal rows at the given
 * width.  Separator length is derived from the width, and content
 * lines are truncated by wrapped row count rather than source line
 * count.
 */
export function renderPromptRows(block: PromptBlock, width: number): string[] {
  if (width < 1) return [];

  const label = block.stageName ? ` Prompt (${block.stageName}) ` : " Prompt ";

  // Header: separator chars + label + separator chars, total ≤ width.
  const availSep = Math.max(0, width - label.length);
  const leftSep = Math.floor(availSep / 2);
  const rightSep = availSep - leftSep;
  const header =
    PROMPT_SEPARATOR_CHAR.repeat(leftSep) +
    label +
    PROMPT_SEPARATOR_CHAR.repeat(rightSep);

  const result: string[] = [];

  // Header — normally one row, but wrap if the label exceeds the width.
  for (const row of splitIntoRows(header, width)) {
    result.push(row);
  }

  // Content lines with wrapped row budget.
  const rawLines = block.prompt.split("\n");
  let rowsUsed = 0;
  let linesShown = 0;

  for (const line of rawLines) {
    const prefixed = `${PROMPT_LINE_PREFIX}${line}`;
    const wrapped = splitIntoRows(prefixed, width);
    if (rowsUsed + wrapped.length > MAX_PROMPT_ROWS) {
      break;
    }
    result.push(...wrapped);
    rowsUsed += wrapped.length;
    linesShown++;
  }

  if (linesShown < rawLines.length) {
    const notice = `${PROMPT_LINE_PREFIX}\u2026 (${rawLines.length - linesShown} more lines)`;
    for (const row of splitIntoRows(notice, width)) {
      result.push(row);
    }
  }

  // Footer: separator chars filling the pane width.
  result.push(PROMPT_SEPARATOR_CHAR.repeat(width));

  return result;
}

/**
 * Render a diagnostic block as a single formatted line.
 *
 * Global (stage-transition) diagnostics use a divider style:
 * `── Stage 4 (Create PR) → Stage 5 (CI check) [outcome: completed] ──`
 *
 * Agent-specific diagnostics keep the activity-log style:
 * `[HH:MM:SS] Pipeline: <message>`
 */
export function renderDiagnosticRow(block: DiagnosticBlock): string {
  const suffix =
    block.count != null && block.count > 1 ? ` x${block.count}` : "";
  if (block.global) {
    return `\u2500\u2500 ${block.message}${suffix} \u2500\u2500`;
  }
  return `[${block.timestamp}] Pipeline: ${block.message}${suffix}`;
}

/** A single terminal row tagged with display metadata. */
interface RowEntry {
  text: string;
  isPrompt: boolean;
  isDiagnostic: boolean;
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
  /** Whether to show the separator line between header and content. */
  showSeparator?: boolean;
  /**
   * Buffered Stage 1 (Bootstrap) log entries to replay into this pane.
   * Both A and B panes receive the same buffer so bootstrap state is
   * visible symmetrically.
   */
  bootstrapLog?: readonly BootstrapLogEntry[];
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
  showSeparator = true,
  bootstrapLog,
}: AgentPaneProps) {
  const { lines, pendingLine } = useAgentLines(emitter, agent, {
    bootstrapLog,
  });
  const contentRef = useRef<DOMElement>(null);
  const [visibleRows, setVisibleRows] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
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

  // Measure the inner content box after each render so visibleRows
  // and contentWidth reflect the real scrollable area regardless of
  // how many rows the header consumes.
  useEffect(() => {
    if (contentRef.current) {
      const { height, width } = measureElement(contentRef.current);
      setVisibleRows(height);
      setContentWidth(width);
    }
  });

  const allLines: LineEntry[] = pendingLine ? [...lines, pendingLine] : lines;

  // Build a flat array of terminal rows from logical lines and prompt
  // blocks so that scrolling operates at the row level, correctly
  // handling wrapped lines that span multiple terminal rows.
  const allRows: RowEntry[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const entry = allLines[i];
    if (typeof entry === "string") {
      const isPrompt =
        entry.startsWith(PROMPT_LINE_PREFIX) ||
        entry.startsWith(PROMPT_SEPARATOR_CHAR);
      for (const row of splitIntoRows(entry, contentWidth)) {
        allRows.push({ text: row, isPrompt, isDiagnostic: false, lineIdx: i });
      }
    } else if (entry.kind === "diagnostic") {
      // DiagnosticBlock: single formatted row.
      const text = renderDiagnosticRow(entry);
      for (const row of splitIntoRows(text, contentWidth)) {
        allRows.push({
          text: row,
          isPrompt: false,
          isDiagnostic: true,
          lineIdx: i,
        });
      }
    } else {
      // PromptBlock: render size-aware with current content width.
      for (const row of renderPromptRows(entry, contentWidth)) {
        allRows.push({
          text: row,
          isPrompt: true,
          isDiagnostic: false,
          lineIdx: i,
        });
      }
    }
  }

  const totalRows = allRows.length;
  // Compute maxOffset so the user can scroll far enough to see the first
  // row.  Add 1 only when a bottom indicator would actually appear at max
  // scroll (i.e. when the viewport at that position cannot reach the last
  // logical line).  For a single wrapped line, no bottom indicator is ever
  // shown, so no extra row is needed.
  let maxOffset = Math.max(0, totalRows - visibleRows);
  if (maxOffset > 0 && visibleRows > 0) {
    const endRowAtMax = totalRows - maxOffset; // = visibleRows
    const lastIdxAtMax = allRows[endRowAtMax - 1]?.lineIdx ?? 0;
    if (allLines.length - 1 - lastIdxAtMax > 0) {
      maxOffset += 1;
    }
  }
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
  //
  // To avoid viewport size discontinuity at scroll transitions, we
  // determine which indicators are needed first, then consistently
  // allocate the remaining rows to content.
  let visibleRowEntries: RowEntry[];
  let linesAbove = 0;
  let linesBelow = 0;

  if (visibleRows === 0) {
    visibleRowEntries = [];
  } else if (effectiveOffset === 0) {
    // Bottom-pinned (auto-follow).
    // Tentatively check if a top indicator is needed.
    const tentativeStart = Math.max(0, totalRows - visibleRows);
    const needTopIndicator =
      tentativeStart > 0 && allRows[tentativeStart].lineIdx > 0;

    const contentRows = visibleRows - (needTopIndicator ? 1 : 0);
    const startRow = Math.max(0, totalRows - contentRows);
    visibleRowEntries = allRows.slice(startRow);
    linesAbove = startRow > 0 ? allRows[startRow].lineIdx : 0;
  } else {
    // Scrolled up: row-level window.
    const endRow = totalRows - effectiveOffset;

    // Tentatively check if indicators are needed using the full viewport.
    const tentativeStart = Math.max(0, endRow - visibleRows);
    const needTopIndicator =
      tentativeStart > 0 && allRows[tentativeStart].lineIdx > 0;
    // Count logical lines fully below the viewport (determined by
    // endRow alone, independent of the top indicator).
    const lastVisibleLineIdx = allRows[endRow - 1]?.lineIdx ?? 0;
    const totalLogicalLines = allLines.length;
    linesBelow = totalLogicalLines - 1 - lastVisibleLineIdx;

    const needBottomIndicator = linesBelow > 0;

    const contentRows =
      visibleRows - (needTopIndicator ? 1 : 0) - (needBottomIndicator ? 1 : 0);
    const startRow = Math.max(0, endRow - contentRows);

    visibleRowEntries = allRows.slice(startRow, endRow);
    linesAbove = startRow > 0 ? allRows[startRow].lineIdx : 0;
  }

  // Diagnostic-only panes should still show the placeholder message.
  const hasOutput = allLines.some(
    (l) => typeof l === "string" || l.kind !== "diagnostic",
  );

  // Suppress the empty-state placeholder while the pane's contents are
  // exclusively Stage 1 (Bootstrap) rows.  Once any non-bootstrap entry
  // arrives (e.g. a stage:enter divider for the first real stage), the
  // normal placeholder logic resumes so Agent B's "idle" hint still
  // appears at its usual time.
  const hasOnlyBootstrap =
    allLines.length > 0 &&
    allLines.every(
      (l) =>
        typeof l !== "string" &&
        l.kind === "diagnostic" &&
        l.bootstrap === true,
    );

  let placeholder: string | undefined;
  if (
    effectiveOffset === 0 &&
    (!hasOutput || visibleRowEntries.length === 0) &&
    !hasOnlyBootstrap
  ) {
    const m = t();
    if (hasOutput && visibleRowEntries.length === 0) {
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

  const topIndicator =
    linesAbove > 0 ? t()["agentPane.linesAbove"](linesAbove) : undefined;
  const bottomIndicator =
    linesBelow > 0 ? t()["agentPane.linesBelow"](linesBelow) : undefined;

  // Dim unfocused pane border so the focused pane is always distinguishable.
  const borderCol = isFocused ? color : "gray";

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      borderStyle="single"
      borderColor={borderCol}
      paddingX={1}
      overflow="hidden"
    >
      <Box flexShrink={0}>
        <Text bold color={borderCol}>
          {modelName ? `${label} \u2014 ${modelName}` : label}
          {isActive ? " \u25CF" : ""}
          {isFocused ? " [*]" : ""}
        </Text>
      </Box>
      {showSeparator && (
        <Box flexShrink={0} overflow="hidden" height={1}>
          <Text dimColor>
            {contentWidth > 0 ? "\u2500".repeat(contentWidth) : ""}
          </Text>
        </Box>
      )}
      <Box
        ref={contentRef}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        overflow="hidden"
      >
        {placeholder !== undefined && <Text dimColor>{placeholder}</Text>}
        {(placeholder === undefined || !hasOutput) && (
          <>
            {topIndicator && <Text dimColor>{topIndicator}</Text>}
            {visibleRowEntries.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are derived without stable IDs
              <Text key={i} dimColor={row.isPrompt || row.isDiagnostic}>
                {row.text}
              </Text>
            ))}
            {bottomIndicator && <Text dimColor>{bottomIndicator}</Text>}
          </>
        )}
      </Box>
    </Box>
  );
}
