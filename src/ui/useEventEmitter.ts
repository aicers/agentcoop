import { useEffect, useRef, useState } from "react";
import type { PipelineEventEmitter } from "../pipeline-events.js";

export interface AgentLinesResult {
  /** Completed (newline-terminated) lines. */
  lines: string[];
  /** Current unterminated fragment, or empty string if none. */
  pendingLine: string;
}

/**
 * Accumulate string chunks emitted on `agent:chunk` for a given agent
 * into a line buffer.  Returns completed lines (capped at `maxLines`)
 * and the current unterminated fragment so the UI can display partial
 * output in real time.
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

  return { lines, pendingLine };
}
