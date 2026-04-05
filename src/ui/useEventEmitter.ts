import { useEffect, useRef, useState } from "react";
import type { PipelineEventEmitter } from "../pipeline-events.js";

/** A structured prompt block stored for size-aware rendering. */
export interface PromptBlock {
  kind: "prompt";
  prompt: string;
  stageName?: string;
}

/** A line buffer entry: either a plain text line or a deferred prompt block. */
export type LineEntry = string | PromptBlock;

export interface AgentLinesResult {
  /** Completed (newline-terminated) lines and prompt blocks. */
  lines: LineEntry[];
  /** Current unterminated fragment, or empty string if none. */
  pendingLine: string;
}

/** Prefix applied to every displayed prompt line. */
export const PROMPT_LINE_PREFIX = "\u25B6 ";

/** Prefix for the prompt separator lines. */
export const PROMPT_SEPARATOR_CHAR = "\u2504";

/**
 * Accumulate string chunks emitted on `agent:chunk` for a given agent
 * into a line buffer.  Returns completed lines (capped at `maxLines`)
 * and the current unterminated fragment so the UI can display partial
 * output in real time.
 *
 * Also listens for `agent:prompt` events and stores structured
 * `PromptBlock` entries so the pane can render them size-aware.
 */
export function useAgentLines(
  emitter: PipelineEventEmitter,
  agent: "a" | "b",
  maxLines = 500,
): AgentLinesResult {
  const [lines, setLines] = useState<LineEntry[]>([]);
  const [pendingLine, setPendingLine] = useState("");
  const bufferRef = useRef("");
  const stageNameRef = useRef<string | undefined>(undefined);

  // Track the current stage name so prompt headers can include it.
  useEffect(() => {
    const handler = (ev: { stageName: string }) => {
      stageNameRef.current = ev.stageName;
    };

    emitter.on("stage:enter", handler);
    return () => {
      emitter.off("stage:enter", handler);
    };
  }, [emitter]);

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

  // Listen for outgoing prompt events and store structured blocks
  // so the pane can render them size-aware at display time.
  useEffect(() => {
    const handler = (ev: { agent: "a" | "b"; prompt: string }) => {
      if (ev.agent !== agent) return;

      const block: PromptBlock = {
        kind: "prompt",
        prompt: ev.prompt,
        stageName: stageNameRef.current,
      };

      // Flush any pending partial line before injecting the prompt
      // block so it appears on its own visual block.
      if (bufferRef.current) {
        const pending = bufferRef.current;
        bufferRef.current = "";
        setPendingLine("");
        setLines((prev) => {
          const next: LineEntry[] = [...prev, pending, block];
          return next.length > maxLines ? next.slice(-maxLines) : next;
        });
      } else {
        setLines((prev) => {
          const next: LineEntry[] = [...prev, block];
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
