import type { UserAction, UserPrompt } from "../pipeline.js";
import type { InputRequest } from "./InputArea.js";

/**
 * Callback that the TUI uses to show a prompt and later resolve it.
 * `setRequest` renders the prompt in the InputArea.  The returned
 * promise resolves when the user submits a response.
 */
export type PromptDispatch = (request: InputRequest) => Promise<string>;

/**
 * `UserPrompt` implementation backed by the ink TUI InputArea.
 *
 * Each method builds an `InputRequest`, dispatches it to the UI, and
 * awaits the user's response.
 */
export function createTuiUserPrompt(dispatch: PromptDispatch): UserPrompt {
  return {
    async confirmContinueLoop(
      stageName: string,
      iteration: number,
      message: string,
    ): Promise<boolean> {
      const response = await dispatch({
        message:
          `${message}\n\n` +
          `Stage "${stageName}" has run ${iteration} iteration(s). Continue?`,
        choices: [
          { label: "Yes, continue", value: "yes" },
          { label: "No, stop", value: "no" },
        ],
      });
      return response === "yes";
    },

    async confirmNextStage(stageName: string): Promise<boolean> {
      const response = await dispatch({
        message: `Ready to enter stage "${stageName}". Proceed?`,
        choices: [
          { label: "Yes", value: "yes" },
          { label: "Skip", value: "no" },
        ],
      });
      return response === "yes";
    },

    async handleBlocked(
      message: string,
      allowProceed: boolean,
    ): Promise<{ action: UserAction; instruction?: string }> {
      const choices: { label: string; value: string }[] = [];
      if (allowProceed) {
        choices.push({ label: "Proceed anyway", value: "proceed" });
      }
      choices.push(
        { label: "Give instruction", value: "instruct" },
        { label: "Halt", value: "halt" },
      );

      const action = await dispatch({
        message: `BLOCKED: ${message}`,
        choices,
      });

      if (action === "instruct") {
        const instruction = await dispatch({
          message: "Enter your instruction:",
        });
        return { action: "instruct", instruction };
      }

      return { action: action as UserAction };
    },

    async handleError(
      message: string,
    ): Promise<{ action: Extract<UserAction, "retry" | "skip" | "abort"> }> {
      const action = await dispatch({
        message: `ERROR: ${message}`,
        choices: [
          { label: "Retry", value: "retry" },
          { label: "Skip", value: "skip" },
          { label: "Abort", value: "abort" },
        ],
      });
      return { action: action as "retry" | "skip" | "abort" };
    },

    async handleAmbiguous(
      message: string,
    ): Promise<{ action: UserAction; instruction?: string }> {
      const action = await dispatch({
        message: `Ambiguous agent response:\n${message}`,
        choices: [
          { label: "Proceed", value: "proceed" },
          { label: "Give instruction", value: "instruct" },
          { label: "Halt", value: "halt" },
        ],
      });

      if (action === "instruct") {
        const instruction = await dispatch({
          message: "Enter your instruction:",
        });
        return { action: "instruct", instruction };
      }

      return { action: action as UserAction };
    },

    async confirmMerge(message: string): Promise<boolean> {
      const response = await dispatch({
        message,
        choices: [
          { label: "Yes, merged", value: "yes" },
          { label: "No, keep worktree", value: "no" },
        ],
      });
      return response === "yes";
    },

    async reportCompletion(message: string): Promise<void> {
      await dispatch({
        message,
        choices: [{ label: "OK", value: "ok" }],
      });
    },
  };
}
