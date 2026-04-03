import { useEffect, useRef, useState } from "react";
import type { PipelineEventEmitter } from "../pipeline-events.js";

export interface AgentLinesResult {
  /** Completed (newline-terminated) lines. */
  lines: string[];
  /** Current unterminated fragment, or empty string if none. */
  pendingLine: string;
}

/** Maximum number of prompt lines shown before truncation. */
const MAX_PROMPT_LINES = 8;

/** Prefix applied to every displayed prompt line. */
export const PROMPT_LINE_PREFIX = "\u25B6 ";

/** Prefix for the prompt separator lines. */
export const PROMPT_SEPARATOR_CHAR = "\u2504";

/**
 * Format a prompt string for display in the agent pane.
 *
 * The prompt is truncated to `MAX_PROMPT_LINES` lines with an
 * indicator showing how many lines were omitted.  Each line is
 * prefixed with `▶ ` so the renderer can apply distinct styling.
 */
export function formatPromptForDisplay(prompt: string): string[] {
  const rawLines = prompt.split("\n");
  const truncated = rawLines.length > MAX_PROMPT_LINES;
  const shown = truncated ? rawLines.slice(0, MAX_PROMPT_LINES) : rawLines;

  const separator = PROMPT_SEPARATOR_CHAR.repeat(36);
  const result = [
    `${separator} Prompt ${separator}`,
    ...shown.map((l) => `${PROMPT_LINE_PREFIX}${l}`),
  ];

  if (truncated) {
    result.push(
      `${PROMPT_LINE_PREFIX}\u2026 (${rawLines.length - MAX_PROMPT_LINES} more lines)`,
    );
  }

  result.push(separator.repeat(2));

  return result;
}

/**
 * Accumulate string chunks emitted on `agent:chunk` for a given agent
 * into a line buffer.  Returns completed lines (capped at `maxLines`)
 * and the current unterminated fragment so the UI can display partial
 * output in real time.
 *
 * Also listens for `agent:prompt` events and injects formatted,
 * truncated prompt lines into the buffer so the user can see what
 * the agent was asked to do.
 */
export function useAgentLines(
  emitter: PipelineEventEmitter,
  agent: "a" | "b",
  maxLines = 500,
): AgentLinesResult {
  const [lines, setLines] = useState<string[]>([]);
  const [pendingLine, setPendingLine] = useState("");
  const bufferRef = useRef("");

  useEffect(() => {
    const handler = (ev: { agent: "a" | "b"; chunk: string }) => {
      if (ev.agent !== agent) return;

      bufferRef.current += ev.chunk;
      const parts = bufferRef.current.split("\n");
      // Last element is the incomplete line (may be empty string).
      bufferRef.current = parts.pop() ?? "";

      // Always update the pending line so partial output is visible.
      setPendingLine(bufferRef.current);

      if (parts.length === 0) return;

      setLines((prev) => {
        const next = [...prev, ...parts];
        return next.length > maxLines ? next.slice(-maxLines) : next;
      });
    };

    emitter.on("agent:chunk", handler);
    return () => {
      emitter.off("agent:chunk", handler);
    };
  }, [emitter, agent, maxLines]);

  // Listen for outgoing prompt events and inject formatted lines.
  useEffect(() => {
    const handler = (ev: { agent: "a" | "b"; prompt: string }) => {
      if (ev.agent !== agent) return;

      const formatted = formatPromptForDisplay(ev.prompt);

      // Flush any pending partial line before injecting prompt lines
      // so the prompt appears on its own visual block.
      if (bufferRef.current) {
        const pending = bufferRef.current;
        bufferRef.current = "";
        setPendingLine("");
        setLines((prev) => {
          const next = [...prev, pending, ...formatted];
          return next.length > maxLines ? next.slice(-maxLines) : next;
        });
      } else {
        setLines((prev) => {
          const next = [...prev, ...formatted];
          return next.length > maxLines ? next.slice(-maxLines) : next;
        });
      }
    };

    emitter.on("agent:prompt", handler);
    return () => {
      emitter.off("agent:prompt", handler);
    };
  }, [emitter, agent, maxLines]);

  return { lines, pendingLine };
}
