/**
 * Bootstrap-phase log buffer.
 *
 * Bootstrap (Stage 1) runs synchronously before the ink TUI mounts, so the
 * lines describing it are printed to stdout/stderr directly.  To also
 * surface those lines inside the TUI panes once mounted, we capture each
 * emitted message here with a timestamp.  The buffered entries are
 * replayed into both agent panes on mount by `useAgentLines`.
 */

export interface BootstrapLogEntry {
  /** HH:MM:SS timestamp, captured when the line was emitted. */
  timestamp: string;
  /** The message text, without a trailing newline. */
  message: string;
}

export interface BootstrapLog {
  /** All buffered entries in emission order. */
  readonly entries: readonly BootstrapLogEntry[];
  /** Print `line` to stdout and record it in the buffer. */
  log(line: string): void;
  /** Print `line` to stderr and record it in the buffer. */
  warn(line: string): void;
}

function hhmmss(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Create a fresh bootstrap log buffer.  Each call to `log` / `warn` both
 * prints to the terminal (so scrollback still shows the bootstrap lines
 * live) and appends a timestamped entry to the buffer.
 */
export function createBootstrapLog(): BootstrapLog {
  const entries: BootstrapLogEntry[] = [];

  function record(message: string): void {
    entries.push({ timestamp: hhmmss(), message });
  }

  return {
    get entries(): readonly BootstrapLogEntry[] {
      return entries;
    },
    log(line: string): void {
      console.log(line);
      record(line);
    },
    warn(line: string): void {
      console.warn(line);
      record(line);
    },
  };
}
