import type { DoneStageOptions, UserPrompt } from "./pipeline.js";

/**
 * Minimal subset of {@link UserPrompt} that the Done stage
 * prompt-options factory relies on.  Matches the structural shape of
 * the `tuiPrompt` reference held in `src/index.ts`, which is itself
 * populated by a subset of TuiUserPrompt's methods at mount time.
 */
export type DoneStageTuiPrompt = Pick<
  UserPrompt,
  | "confirmMerge"
  | "handleConflict"
  | "handleUnknownMergeable"
  | "waitForManualResolve"
>;

/**
 * Build the `prompt` options object for {@link createDoneStageHandler}
 * from a late-bound `tuiPrompt` getter.  Each field is an inline
 * wrapper that reads the current `tuiPrompt` via the getter at
 * invocation time, delegating to it when present and otherwise
 * returning a safe default for non-TUI environments.
 *
 * The getter indirection is required because `src/index.ts` assembles
 * `createDoneStageHandler` before the ink <App> mounts and supplies
 * the prompt via `onPromptReady`.  Passing a live value here would
 * snapshot `undefined` and permanently route every Stage 9 callback
 * to the non-TUI fallback, even after the prompt is assigned.
 *
 * Regression for #272: the `confirmMerge` wrapper previously dropped
 * the `hotkeys` argument, leaking `{{hk:...}}` sentinels to the TUI.
 */
export function createDonePromptOptions(
  getTuiPrompt: () => DoneStageTuiPrompt | undefined,
): DoneStageOptions["prompt"] {
  return {
    confirmMerge: async (msg, hotkeys) => {
      const tuiPrompt = getTuiPrompt();
      if (tuiPrompt) return tuiPrompt.confirmMerge(msg, hotkeys);
      return "merged";
    },
    handleConflict: async (msg) => {
      const tuiPrompt = getTuiPrompt();
      if (tuiPrompt) return tuiPrompt.handleConflict(msg);
      return "manual";
    },
    handleUnknownMergeable: async (msg) => {
      const tuiPrompt = getTuiPrompt();
      if (tuiPrompt) return tuiPrompt.handleUnknownMergeable(msg);
      return "exit";
    },
    waitForManualResolve: async (msg) => {
      const tuiPrompt = getTuiPrompt();
      if (tuiPrompt) return tuiPrompt.waitForManualResolve(msg);
    },
  };
}
