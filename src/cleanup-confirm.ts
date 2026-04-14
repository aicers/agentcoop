import { confirm } from "@inquirer/prompts";

/**
 * Shared state for tracking Ctrl+C presses during the cleanup phase.
 * Both the process-level SIGINT handler and prompt-level ExitPromptError
 * handler increment the same counter so that the "two strikes" logic
 * works regardless of *where* the signal is caught.
 */
export interface CleanupInterruptState {
  count: number;
}

/**
 * SIGINT-resilient wrapper around `@inquirer/prompts` `confirm()`.
 *
 * `@inquirer/core` intercepts Ctrl+C on its own readline interface and
 * rejects with `ExitPromptError` — the process-level SIGINT handler
 * never fires while a prompt is active.  This wrapper catches that
 * error and applies the same two-strike policy:
 *
 * - **1st interrupt** → print a warning, re-ask the same prompt
 * - **2nd interrupt** → force-exit with `process.exit(1)`
 */
export async function resilientConfirm(
  options: Parameters<typeof confirm>[0],
  state: CleanupInterruptState,
  warningMessage: string,
): Promise<boolean> {
  for (;;) {
    try {
      return await confirm(options);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "ExitPromptError") {
        state.count++;
        if (state.count >= 2) {
          process.exit(1);
        }
        console.log(`\n${warningMessage}`);
        continue;
      }
      throw error;
    }
  }
}
