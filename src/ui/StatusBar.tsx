import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import stringWidth from "string-width";
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
  /** Title of the GitHub issue, shown after the issue reference. */
  issueTitle?: string;
  /** Full SHA of the base commit; displayed abbreviated in the bar. */
  baseSha?: string;
  /** Current pane layout direction. */
  layout?: "row" | "column";
  /** Whether to show the keyboard hints line. Defaults to true. */
  showKeyHints?: boolean;
  /** Content width budget for the info line (terminal width minus border and padding). */
  contentWidth?: number;
}

// ---- Segment fitting helpers -------------------------------------------------

/** A segment of the info line with styling and drop priority. */
interface InfoSegment {
  text: string;
  bold?: boolean;
  color?: string;
  /** 0 = required (never dropped); higher values are dropped sooner. */
  dropPriority: number;
}

const SEP = "  |  ";
const SEP_LEN = 5;

/** Compute the total display width of segments joined by separators. */
function segmentsWidth(segs: InfoSegment[]): number {
  let width = 0;
  for (let i = 0; i < segs.length; i++) {
    if (i > 0) width += SEP_LEN;
    width += stringWidth(segs[i].text);
  }
  return width;
}

/**
 * Truncate text with ellipsis if it exceeds maxWidth terminal columns.
 * Uses display width (not string length) so CJK/wide characters are
 * measured correctly.
 */
export function truncateWithEllipsis(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth <= 1) return "\u2026";
  const target = maxWidth - 1; // reserve 1 column for ellipsis
  let result = "";
  let currentWidth = 0;
  for (const char of text) {
    const w = stringWidth(char);
    if (currentWidth + w > target) break;
    result += char;
    currentWidth += w;
  }
  return `${result}\u2026`;
}

/**
 * Fit segments within a width budget by progressively dropping optional
 * segments (highest dropPriority first) and truncating required ones as
 * a last resort.
 */
export function fitInfoSegments(
  segments: InfoSegment[],
  maxWidth: number,
): InfoSegment[] {
  let display = [...segments];

  // Drop optional segments (highest dropPriority first) until they fit.
  while (segmentsWidth(display) > maxWidth) {
    let dropIdx = -1;
    let dropPrio = 0;
    for (let i = 0; i < display.length; i++) {
      if (display[i].dropPriority > dropPrio) {
        dropPrio = display[i].dropPriority;
        dropIdx = i;
      }
    }
    if (dropIdx === -1) break;
    display = display.filter((_, i) => i !== dropIdx);
  }

  // Truncation as last resort for required segments.
  if (segmentsWidth(display) > maxWidth && display.length > 0) {
    const seps = Math.max(0, display.length - 1) * SEP_LEN;
    const available = maxWidth - seps;

    if (available < display.length) {
      // Ultra-narrow: separator(s) alone consume too much of the budget.
      // Merge all remaining segments into a single truncated string.
      const merged = display.map((s) => s.text).join(" ");
      display = [
        { ...display[0], text: truncateWithEllipsis(merged, maxWidth) },
      ];
    } else {
      const each = Math.floor(available / display.length);
      const remainder = available - each * display.length;
      display = display.map((seg, i) => ({
        ...seg,
        text: truncateWithEllipsis(seg.text, each + (i < remainder ? 1 : 0)),
      }));
    }
  }

  return display;
}

// ---- Component ---------------------------------------------------------------

export function StatusBar({
  emitter,
  owner,
  repo,
  issueNumber,
  issueTitle,
  baseSha,
  layout,
  showKeyHints = true,
  contentWidth,
}: StatusBarProps) {
  const [stage, setStage] = useState<StageEnterEvent | null>(null);
  const [lastOutcome, setLastOutcome] = useState<string | null>(null);
  const [selfCheckCount, setSelfCheckCount] = useState(0);
  const [reviewCount, setReviewCount] = useState(0);

  useEffect(() => {
    const onEnter = (ev: StageEnterEvent) => {
      setStage(ev);
      setLastOutcome(null);
    };
    const onExit = (ev: StageExitEvent) => {
      setLastOutcome(ev.outcome);
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
      ? m["statusBar.stageRound"](stage.stageNumber, stage.stageName, round)
      : m["statusBar.stage"](stage.stageNumber, stage.stageName)
    : m["statusBar.initialising"];

  const outcomeKey = lastOutcome
    ? (`outcome.${lastOutcome}` as keyof typeof m)
    : undefined;
  const outcomeLabel =
    outcomeKey && outcomeKey in m ? (m[outcomeKey] as string) : lastOutcome;
  const outcomeText = outcomeLabel ? m["statusBar.last"](outcomeLabel) : "";

  const issueRef = `${owner}/${repo}#${issueNumber}`;
  const baseText = baseSha ? m["statusBar.base"](baseSha.slice(0, 7)) : "";
  const layoutText = layout
    ? m["statusBar.layout"](
        layout === "row"
          ? m["statusBar.layoutHorizontal"]
          : m["statusBar.layoutVertical"],
      )
    : "";
  const completedText =
    selfCheckCount > 0 || reviewCount > 0
      ? m["statusBar.completed"](selfCheckCount, reviewCount)
      : "";

  // Line 1: Issue reference + title (independent of other segments).
  const issueLineText = issueTitle ? `${issueRef}: ${issueTitle}` : issueRef;
  const issueLine =
    contentWidth !== undefined
      ? truncateWithEllipsis(issueLineText, contentWidth)
      : issueLineText;

  // Line 2: Pipeline status segments with drop priorities.
  // Priority 0 = required (never dropped); higher = dropped sooner.
  // Drop order: layout (4) → completed (3) → outcome (2) → base (1).
  const pipelineSegments: InfoSegment[] = [];
  if (baseText) {
    pipelineSegments.push({ text: baseText, dropPriority: 1 });
  }
  pipelineSegments.push({ text: stageText, bold: true, dropPriority: 0 });
  if (outcomeText) {
    pipelineSegments.push({ text: outcomeText, dropPriority: 2 });
  }
  if (completedText) {
    pipelineSegments.push({ text: completedText, dropPriority: 3 });
  }
  if (layoutText) {
    pipelineSegments.push({ text: layoutText, dropPriority: 4 });
  }

  const pipelineDisplay =
    contentWidth !== undefined
      ? fitInfoSegments(pipelineSegments, contentWidth)
      : pipelineSegments;

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
      flexShrink={0}
      height={contentWidth !== undefined ? (showKeyHints ? 5 : 4) : undefined}
      overflow="hidden"
    >
      <Text bold color="cyan">
        {issueLine}
      </Text>
      <Box>
        {pipelineDisplay.map((seg, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable render-local array
          <Text key={i} bold={seg.bold} color={seg.color}>
            {i > 0 ? SEP : ""}
            {seg.text}
          </Text>
        ))}
      </Box>
      {showKeyHints && (
        <Text dimColor>
          {contentWidth !== undefined
            ? truncateWithEllipsis(m["statusBar.keyHints"], contentWidth)
            : m["statusBar.keyHints"]}
        </Text>
      )}
    </Box>
  );
}
