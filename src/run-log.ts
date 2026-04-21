/**
 * Persistent run log — writes all pipeline events to a log file for
 * post-mortem debugging.
 *
 * Log files live at `~/.agentcoop/logs/<org>-<repo>-#<issue>-<timestamp>.log`.
 */

import {
  createWriteStream,
  mkdirSync,
  openSync,
  type WriteStream,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { PipelineEventEmitter } from "./pipeline-events.js";

// ---- public types --------------------------------------------------------

export interface RunLogAgentMeta {
  cli: string;
  model: string;
  contextWindow?: string;
  effortLevel?: string;
  /** CLI version string captured at pipeline start (e.g. "1.2.3"). */
  cliVersion?: string;
}

export interface RunLogMetadata {
  owner: string;
  repo: string;
  issueNumber: number;
  worktreePath: string;
  executionMode: "auto" | "step";
  agentA: RunLogAgentMeta;
  agentB: RunLogAgentMeta;
  selfCheckAutoIterations: number;
  reviewAutoRounds: number;
  ciCheckAutoIterations: number;
  ciCheckTimeoutMinutes: number;
  inactivityTimeoutMinutes: number;
  autoResumeAttempts: number;
}

// ---- helpers -------------------------------------------------------------

function logsDir(): string {
  return join(homedir(), ".agentcoop", "logs");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatTimestamp(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fileTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/** Build the log file path for a run (without collision suffix). */
export function logFilePath(
  owner: string,
  repo: string,
  issueNumber: number,
  startTime: Date,
  suffix?: number,
): string {
  const base = `${owner}-${repo}-#${issueNumber}-${fileTimestamp(startTime)}`;
  const name = suffix ? `${base}-${suffix}.log` : `${base}.log`;
  return join(logsDir(), name);
}

// ---- writer --------------------------------------------------------------

export interface RunLogWriter {
  /** Absolute path to the log file. */
  path: string;
  /** Flush and close the log file. */
  close(): Promise<void>;
}

/** A no-op writer used when the log file cannot be created. */
function noopWriter(): RunLogWriter {
  return { path: "", close: () => Promise.resolve() };
}

/**
 * Create a run log writer that subscribes to the given emitter and
 * writes all events to a log file.
 *
 * If the log file cannot be created (permissions, full disk, etc.)
 * this returns a no-op writer so the pipeline is not blocked.
 */
export function createRunLog(
  emitter: PipelineEventEmitter,
  meta: RunLogMetadata,
): RunLogWriter {
  const startTime = new Date();

  let fd = -1;
  let filePath = "";
  try {
    mkdirSync(logsDir(), { recursive: true });

    // Use exclusive create ("wx") to avoid silently truncating a log
    // from another run that started in the same second.  Retry with
    // an incrementing suffix on collision.
    const MAX_RETRIES = 10;
    let opened = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      filePath = logFilePath(
        meta.owner,
        meta.repo,
        meta.issueNumber,
        startTime,
        attempt === 0 ? undefined : attempt,
      );
      try {
        fd = openSync(filePath, "wx");
        opened = true;
        break;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "EEXIST"
        ) {
          continue;
        }
        throw err; // non-collision error → let the outer catch handle it
      }
    }
    if (!opened) return noopWriter();
  } catch {
    return noopWriter();
  }

  // Wrap the fd in a buffered write stream so event-listener writes
  // do not block the event loop.
  const stream: WriteStream = createWriteStream("", { fd });

  // Track whether the writer has been disabled due to a write error.
  let disabled = false;
  stream.on("error", () => {
    disabled = true;
  });

  function write(line: string): void {
    if (disabled) return;
    try {
      stream.write(`${line}\n`);
    } catch {
      disabled = true;
    }
  }

  // ---- header block ------------------------------------------------------

  write("=== AgentCoop Run Log ===");
  write(`Start time : ${startTime.toISOString()}`);
  write(`Repository : ${meta.owner}/${meta.repo}`);
  write(`Issue      : #${meta.issueNumber}`);
  write(`Worktree   : ${meta.worktreePath}`);
  write(`Mode       : ${meta.executionMode}`);
  write(`Agent A    : ${meta.agentA.cli} / ${meta.agentA.model}`);
  if (meta.agentA.contextWindow)
    write(`  context  : ${meta.agentA.contextWindow}`);
  if (meta.agentA.effortLevel) write(`  effort   : ${meta.agentA.effortLevel}`);
  if (meta.agentA.cliVersion) write(`  version  : ${meta.agentA.cliVersion}`);
  write(`Agent B    : ${meta.agentB.cli} / ${meta.agentB.model}`);
  if (meta.agentB.contextWindow)
    write(`  context  : ${meta.agentB.contextWindow}`);
  if (meta.agentB.effortLevel) write(`  effort   : ${meta.agentB.effortLevel}`);
  if (meta.agentB.cliVersion) write(`  version  : ${meta.agentB.cliVersion}`);
  write(
    `Auto-budget: self-check=${meta.selfCheckAutoIterations}, review=${meta.reviewAutoRounds}, ci-check=${meta.ciCheckAutoIterations}`,
  );
  write(
    `Timeouts   : inactivity=${meta.inactivityTimeoutMinutes}m, ciCheck=${meta.ciCheckTimeoutMinutes}m, autoResume=${meta.autoResumeAttempts}`,
  );
  write("");

  // ---- event subscriptions -----------------------------------------------

  /** Map stage number → name, populated by stage:enter events. */
  const stageNames = new Map<number, string>();

  /** Most recently entered stage — used to add context to "work" invocations. */
  let currentStageName: string | null = null;

  function ts(): string {
    return `[${formatTimestamp(new Date())}]`;
  }

  emitter.on("agent:chunk", (ev) => {
    const label = ev.agent === "a" ? "Agent A" : "Agent B";
    for (const line of ev.chunk.split("\n")) {
      write(`${ts()} [${label}] ${line}`);
    }
  });

  emitter.on("agent:prompt", (ev) => {
    const label = ev.agent === "a" ? "Agent A" : "Agent B";
    write(`${ts()} [${label}:prompt] --- prompt start (${ev.kind}) ---`);
    for (const line of ev.prompt.split("\n")) {
      write(`${ts()} [${label}:prompt] ${line}`);
    }
    write(`${ts()} [${label}:prompt] --- prompt end ---`);
  });

  emitter.on("agent:invoke", (ev) => {
    const label = ev.agent === "a" ? "Agent A" : "Agent B";
    let suffix = "";
    if (ev.kind === "work" && currentStageName) {
      suffix = ` (work: ${currentStageName})`;
    } else if (ev.kind) {
      suffix = ` (${ev.kind})`;
    }
    write(`${ts()} [Pipeline] Invoking ${label}${suffix}`);
  });

  emitter.on("stage:enter", (ev) => {
    currentStageName = ev.stageName;
    stageNames.set(ev.stageNumber, ev.stageName);
    write(
      `${ts()} [Pipeline] Stage ${ev.stageNumber} (${ev.stageName}) → enter (iteration ${ev.iteration})`,
    );
  });

  emitter.on("stage:name-override", (ev) => {
    currentStageName = ev.stageName;
    write(`${ts()} [Pipeline] Stage name override → ${ev.stageName}`);
  });

  emitter.on("stage:exit", (ev) => {
    const name = stageNames.get(ev.stageNumber);
    const label = name
      ? `Stage ${ev.stageNumber} (${name})`
      : `Stage ${ev.stageNumber}`;
    write(`${ts()} [Pipeline] ${label} → exit (${ev.outcome})`);
  });

  emitter.on("pipeline:verdict", (ev) => {
    const label = ev.agent === "a" ? "Agent A" : "Agent B";
    write(`${ts()} [Pipeline] ${label} verdict parsed as "${ev.keyword}"`);
  });

  emitter.on("pipeline:loop", (ev) => {
    if (ev.exhausted) {
      write(
        `${ts()} [Pipeline] Auto-budget exhausted for stage ${ev.stageNumber} (${ev.stageName})`,
      );
    } else {
      write(
        `${ts()} [Pipeline] Auto-budget ${ev.remaining} remaining for stage ${ev.stageNumber} (${ev.stageName})`,
      );
    }
  });

  emitter.on("pipeline:ci-poll", (ev) => {
    if (ev.action === "start") {
      write(
        `${ts()} [Pipeline] CI polling started (SHA: ${ev.sha ?? "unknown"})`,
      );
    } else if (ev.action === "status") {
      write(`${ts()} [Pipeline] CI polling status: ${ev.verdict ?? "pending"}`);
    } else {
      write(
        `${ts()} [Pipeline] CI polling done (verdict: ${ev.verdict ?? "unknown"})`,
      );
    }
  });

  // ---- close -------------------------------------------------------------

  return {
    path: filePath,
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (disabled || stream.destroyed) {
          if (!stream.destroyed) stream.destroy();
          resolve();
          return;
        }
        write("");
        write(`${ts()} [Pipeline] Log closed`);
        disabled = true;
        stream.once("error", () => resolve());
        stream.end(() => resolve());
      });
    },
  };
}
