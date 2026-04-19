import { t } from "../i18n/index.js";
import type { UserAction, UserPrompt } from "../pipeline.js";
import type { InputHotkey, InputRequest } from "./InputArea.js";

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
      const m = t();
      const response = await dispatch({
        message: `${message}\n\n${m["prompt.continueLoop"](stageName, iteration)}`,
        choices: [
          { label: m["prompt.yesContinue"], value: "yes" },
          { label: m["prompt.noStop"], value: "no" },
        ],
      });
      return response === "yes";
    },

    async confirmNextStage(stageName: string): Promise<boolean> {
      const m = t();
      const response = await dispatch({
        message: m["prompt.nextStage"](stageName),
        choices: [
          { label: m["prompt.yes"], value: "yes" },
          { label: m["prompt.skip"], value: "no" },
        ],
      });
      return response === "yes";
    },

    async handleBlocked(
      message: string,
      allowProceed: boolean,
    ): Promise<{ action: UserAction; instruction?: string }> {
      const m = t();
      const choices: { label: string; value: string }[] = [];
      if (allowProceed) {
        choices.push({ label: m["prompt.proceedAnyway"], value: "proceed" });
      }
      choices.push(
        { label: m["prompt.giveInstruction"], value: "instruct" },
        { label: m["prompt.halt"], value: "halt" },
      );

      const action = await dispatch({
        message: m["prompt.blocked"](message),
        choices,
      });

      if (action === "instruct") {
        const instruction = await dispatch({
          message: m["prompt.enterInstruction"],
        });
        return { action: "instruct", instruction };
      }

      return { action: action as UserAction };
    },

    async handleError(
      message: string,
    ): Promise<{ action: Extract<UserAction, "retry" | "skip" | "abort"> }> {
      const m = t();
      const action = await dispatch({
        message: m["prompt.error"](message),
        choices: [
          { label: m["prompt.retry"], value: "retry" },
          { label: m["prompt.skip"], value: "skip" },
          { label: m["prompt.abort"], value: "abort" },
        ],
      });
      return { action: action as "retry" | "skip" | "abort" };
    },

    async handleAmbiguous(
      message: string,
    ): Promise<{ action: UserAction; instruction?: string }> {
      const m = t();
      const action = await dispatch({
        message: m["prompt.ambiguous"](message),
        choices: [
          { label: m["prompt.proceed"], value: "proceed" },
          { label: m["prompt.giveInstruction"], value: "instruct" },
          { label: m["prompt.halt"], value: "halt" },
        ],
      });

      if (action === "instruct") {
        const instruction = await dispatch({
          message: m["prompt.enterInstruction"],
        });
        return { action: "instruct", instruction };
      }

      return { action: action as UserAction };
    },

    async confirmMerge(
      message: string,
      hotkeys?: InputHotkey[],
    ): Promise<"merged" | "check_conflicts" | "exit"> {
      const m = t();
      const response = await dispatch({
        message,
        choices: [
          { label: m["prompt.yesMerged"], value: "merged" },
          {
            label: m["prompt.checkConflictsRebase"],
            value: "check_conflicts",
          },
          { label: m["prompt.noExit"], value: "exit" },
        ],
        hotkeys,
      });
      return response as "merged" | "check_conflicts" | "exit";
    },

    async handleConflict(message: string): Promise<"agent_rebase" | "manual"> {
      const m = t();
      const response = await dispatch({
        message,
        choices: [
          { label: m["prompt.agentRebase"], value: "agent_rebase" },
          { label: m["prompt.manualResolve"], value: "manual" },
        ],
      });
      return response as "agent_rebase" | "manual";
    },

    async handleUnknownMergeable(message: string): Promise<"recheck" | "exit"> {
      const m = t();
      const response = await dispatch({
        message,
        choices: [
          { label: m["prompt.recheck"], value: "recheck" },
          { label: m["prompt.exit"], value: "exit" },
        ],
      });
      return response as "recheck" | "exit";
    },

    async waitForManualResolve(message: string): Promise<void> {
      await dispatch({ message });
    },

    async confirmCleanup(message: string): Promise<boolean> {
      const m = t();
      const response = await dispatch({
        message,
        choices: [
          { label: m["prompt.yesCleanup"], value: "yes" },
          { label: m["prompt.noSkipCleanup"], value: "no" },
        ],
      });
      return response === "yes";
    },

    async chooseSquashApplyMode(message: string): Promise<"agent" | "github"> {
      const m = t();
      const response = await dispatch({
        message,
        choices: [
          { label: m["squash.singleChoiceAgent"], value: "agent" },
          { label: m["squash.singleChoiceGithub"], value: "github" },
        ],
      });
      return response === "agent" ? "agent" : "github";
    },
  };
}
