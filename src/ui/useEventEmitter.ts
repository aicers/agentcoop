import { useEffect, useRef, useState } from "react";
import type { BootstrapLogEntry } from "../bootstrap-log.js";
import { t } from "../i18n/index.js";
import type {
  AgentInvokeEvent,
  PipelineCiPollEvent,
  PipelineEventEmitter,
  PipelineLoopEvent,
  PipelineVerdictEvent,
  StageEnterEvent,
  StageExitEvent,
} from "../pipeline-events.js";

/** Return a HH:MM:SS timestamp string for the current time. */
function hhmmss(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/** A structured prompt block stored for size-aware rendering. */
export interface PromptBlock {
  kind: "prompt";
  prompt: string;
  stageName?: string;
}

/** An inline diagnostic line from the pipeline orchestrator. */
export interface DiagnosticBlock {
  kind: "diagnostic";
  /** HH:MM:SS timestamp. */
  timestamp: string;
  /** Human-readable diagnostic message. */
  message: string;
  /** Number of consecutive occurrences (omitted or 1 for the first). */
  count?: number;
  /** Whether this is a global (cross-pane) diagnostic like stage transitions. */
  global?: boolean;
  /**
   * Whether this row was produced from the buffered Stage 1 (Bootstrap)
   * log replay.  Used to suppress the pane's empty-state placeholder
   * while the only contents are Stage 1 rows.
   */
  bootstrap?: boolean;
}

/** A line buffer entry: plain text, a prompt block, or a diagnostic line. */
export type LineEntry = string | PromptBlock | DiagnosticBlock;

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
export interface UseAgentLinesOptions {
  /** Maximum number of buffered completed lines and blocks. */
  maxLines?: number;
  /**
   * Buffered Stage 1 (Bootstrap) log entries.  When provided and
   * non-empty, the hook prepends a Stage 1 enter divider, then each
   * entry as a non-global bootstrap diagnostic, then pre-arms the
   * transition so the next `stage:enter` produces a
   * "Stage 1 \u2192 Stage N" divider naturally.
   */
  bootstrapLog?: readonly BootstrapLogEntry[];
}

export function useAgentLines(
  emitter: PipelineEventEmitter,
  agent: "a" | "b",
  optionsOrMaxLines: UseAgentLinesOptions | number = {},
): AgentLinesResult {
  const options: UseAgentLinesOptions =
    typeof optionsOrMaxLines === "number"
      ? { maxLines: optionsOrMaxLines }
      : optionsOrMaxLines;
  const maxLines = options.maxLines ?? 500;
  const bootstrapLog = options.bootstrapLog;

  // Seed initial lines with the Stage 1 (Bootstrap) timeline so the
  // user sees a complete stage sequence starting from Stage 1.  This
  // is a one-shot initialisation; later re-renders do not re-seed.
  const initialLines = (): LineEntry[] => {
    if (!bootstrapLog || bootstrapLog.length === 0) return [];
    const m = t();
    const bootstrapName = m["stage.bootstrap"];
    const seeded: LineEntry[] = [
      {
        kind: "diagnostic",
        timestamp: bootstrapLog[0].timestamp,
        message: `Stage 1 (${bootstrapName})`,
        global: true,
        bootstrap: true,
      },
      ...bootstrapLog.map<DiagnosticBlock>((entry) => ({
        kind: "diagnostic",
        timestamp: entry.timestamp,
        message: entry.message,
        bootstrap: true,
      })),
    ];
    return seeded;
  };

  const [lines, setLines] = useState<LineEntry[]>(initialLines);
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

  // Helper: push a DiagnosticBlock into the line buffer.
  // Store maxLines in a ref so the callback always sees the latest value
  // without duplicating the function body.
  const maxLinesRef = useRef(maxLines);
  useEffect(() => {
    maxLinesRef.current = maxLines;
  }, [maxLines]);

  const pushDiagnostic = useRef(
    (message: string, global?: boolean, bootstrap?: boolean) => {
      const now = hhmmss();
      const base: DiagnosticBlock = {
        kind: "diagnostic",
        timestamp: now,
        message,
        ...(global ? { global: true } : {}),
        ...(bootstrap ? { bootstrap: true } : {}),
      };
      // Flush any pending partial line before inserting the diagnostic
      // so it appears in the correct chronological position.
      if (bufferRef.current) {
        const pending = bufferRef.current;
        bufferRef.current = "";
        setPendingLine("");
        setLines((prev) => {
          const next: LineEntry[] = [...prev, pending, base];
          return next.length > maxLinesRef.current
            ? next.slice(-maxLinesRef.current)
            : next;
        });
      } else {
        setLines((prev) => {
          // Deduplicate: if the last entry is a diagnostic with the same
          // message and global flag, update it in place with an
          // incremented count and the latest timestamp.
          const last = prev.length > 0 ? prev[prev.length - 1] : undefined;
          if (
            last != null &&
            typeof last !== "string" &&
            last.kind === "diagnostic" &&
            last.message === message &&
            (last.global ?? false) === (global ?? false)
          ) {
            const updated: DiagnosticBlock = {
              ...last,
              timestamp: now,
              count: (last.count ?? 1) + 1,
            };
            const next: LineEntry[] = [...prev.slice(0, -1), updated];
            return next;
          }
          const next: LineEntry[] = [...prev, base];
          return next.length > maxLinesRef.current
            ? next.slice(-maxLinesRef.current)
            : next;
        });
      }
    },
  );

  // --- Diagnostic event subscriptions ---

  // pipeline:verdict → route to the agent that produced the verdict.
  useEffect(() => {
    const handler = (ev: PipelineVerdictEvent) => {
      if (ev.agent !== agent) return;
      pushDiagnostic.current(`Reviewer verdict parsed as "${ev.keyword}"`);
    };
    emitter.on("pipeline:verdict", handler);
    return () => {
      emitter.off("pipeline:verdict", handler);
    };
  }, [emitter, agent]);

  // stage:enter / stage:exit → show combined stage transitions in both panes.
  // Buffer exit events and merge with the following enter to produce a single
  // transition line like "Stage 7 (Review) → Stage 8 (Squash) [outcome: completed]".
  //
  // When bootstrap (Stage 1) ran before the TUI mounted, pre-arm the
  // pending exit with a synthetic "Stage 1 exited" so the first real
  // stage:enter emits a "Stage 1 (Bootstrap) \u2192 Stage N (...)" divider.
  const pendingExitRef = useRef<{
    stageNumber: number;
    stageName: string | undefined;
    outcome: string;
    /** True if this exit was synthesized from the Stage 1 bootstrap replay. */
    bootstrap?: boolean;
  } | null>(
    bootstrapLog && bootstrapLog.length > 0
      ? {
          stageNumber: 1,
          stageName: t()["stage.bootstrap"],
          outcome: "completed",
          bootstrap: true,
        }
      : null,
  );

  useEffect(() => {
    const exitHandler = (ev: StageExitEvent) => {
      pendingExitRef.current = {
        stageNumber: ev.stageNumber,
        stageName: stageNameRef.current,
        outcome: ev.outcome,
      };
    };
    const enterHandler = (ev: StageEnterEvent) => {
      const pending = pendingExitRef.current;
      pendingExitRef.current = null;
      if (pending) {
        const from = pending.stageName
          ? `Stage ${pending.stageNumber} (${pending.stageName})`
          : `Stage ${pending.stageNumber}`;
        pushDiagnostic.current(
          `${from} → Stage ${ev.stageNumber} (${ev.stageName}) [outcome: ${pending.outcome}]`,
          true,
          pending.bootstrap,
        );
      } else {
        pushDiagnostic.current(
          `Entering Stage ${ev.stageNumber} (${ev.stageName})`,
          true,
        );
      }
    };
    emitter.on("stage:exit", exitHandler);
    emitter.on("stage:enter", enterHandler);
    return () => {
      emitter.off("stage:exit", exitHandler);
      emitter.off("stage:enter", enterHandler);
    };
  }, [emitter]);

  // pipeline:loop → route to the looping stage's primary agent pane.
  useEffect(() => {
    const handler = (ev: PipelineLoopEvent) => {
      if (ev.agent !== undefined && ev.agent !== agent) return;
      if (ev.exhausted) {
        pushDiagnostic.current(`${ev.stageName} auto-budget exhausted`);
      } else {
        pushDiagnostic.current(
          `${ev.stageName} auto-budget ${ev.remaining}/${ev.budget} remaining`,
        );
      }
    };
    emitter.on("pipeline:loop", handler);
    return () => {
      emitter.off("pipeline:loop", handler);
    };
  }, [emitter, agent]);

  // pipeline:ci-poll → route to Agent A pane (CI fixes run on A).
  useEffect(() => {
    if (agent !== "a") return;
    const handler = (ev: PipelineCiPollEvent) => {
      if (ev.action === "start") {
        const sha = ev.sha ? ` (SHA: ${ev.sha.slice(0, 7)})` : "";
        pushDiagnostic.current(`CI polling started${sha}`);
      } else if (ev.action === "status") {
        const verdict = ev.verdict ? `: ${ev.verdict}` : "";
        pushDiagnostic.current(`CI poll status${verdict}`);
      } else {
        const verdict = ev.verdict ? `: ${ev.verdict}` : "";
        pushDiagnostic.current(`CI polling done${verdict}`);
      }
    };
    emitter.on("pipeline:ci-poll", handler);
    return () => {
      emitter.off("pipeline:ci-poll", handler);
    };
  }, [emitter, agent]);

  // agent:invoke → route to the target agent's pane.
  useEffect(() => {
    const kindLabels: Record<string, string> = {
      work: "work prompt",
      review: "review prompt",
      "verdict-followup": "verdict follow-up",
      "ci-fix": "CI fix prompt",
      summary: "summary request",
    };
    const handler = (ev: AgentInvokeEvent) => {
      if (ev.agent !== agent) return;
      const label = agent === "a" ? "Agent A" : "Agent B";
      const action = ev.type === "invoke" ? "Invoking" : "Resuming";
      const kindLabel = ev.kind ? (kindLabels[ev.kind] ?? ev.kind) : "";
      const roundSuffix = ev.round != null ? ` (round ${ev.round})` : "";
      const context = kindLabel ? ` with ${kindLabel}${roundSuffix}` : "";
      pushDiagnostic.current(`${action} ${label}${context}`);
    };
    emitter.on("agent:invoke", handler);
    return () => {
      emitter.off("agent:invoke", handler);
    };
  }, [emitter, agent]);

  return { lines, pendingLine };
}
