import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import type {
  PipelineEventEmitter,
  PrResolvedEvent,
  StageEnterEvent,
  StageNameOverrideEvent,
} from "../pipeline-events.js";
import { stageDisplayName } from "./StatusBar.js";
import { shouldShowRound } from "./stage-meta.js";

export interface FormatTerminalTitleInput {
  owner: string;
  repo: string;
  issueNumber: number;
  prNumber?: number;
  stageLabel?: string;
}

/**
 * Build the human-readable title shown in the terminal tab.  Returns
 * `<owner>/<repo>#<issue>[ (#<pr>)][ <stageLabel>]` with no trailing
 * whitespace.  Has no knowledge of stage numbering or the round
 * predicate; the caller passes the already-composed `stageLabel`.
 */
export function formatTerminalTitle({
  owner,
  repo,
  issueNumber,
  prNumber,
  stageLabel,
}: FormatTerminalTitleInput): string {
  let title = `${owner}/${repo}#${issueNumber}`;
  if (prNumber !== undefined) {
    title += ` (#${prNumber})`;
  }
  if (stageLabel) {
    title += ` ${stageLabel}`;
  }
  return title;
}

export interface EncodeTerminalTitleEnv {
  TERM?: string;
  TMUX?: string;
  CMUX_WORKSPACE_ID?: string;
  CMUX_SURFACE_ID?: string;
}

/**
 * Strip control characters (`\x00`–`\x1f` and `\x7f`) from `title` so
 * a hostile or malformed input cannot terminate the OSC/DCS wrapper
 * prematurely.  Replaced with a single space and trimmed.
 */
function sanitizeTitle(title: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — strip control bytes from title
  return title.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
}

/**
 * Encode `title` as the escape-sequence bytes appropriate for the
 * given terminal environment.  TTY gating is the caller's
 * responsibility — this function unconditionally returns the encoded
 * bytes for a recognized environment.  Returns the OSC 0 form by
 * default.
 */
export function encodeTerminalTitle(
  title: string,
  env: EncodeTerminalTitleEnv,
): string {
  const safe = sanitizeTitle(title);
  const ESC = "\x1b";
  const BEL = "\x07";
  const ST = `${ESC}\\`;

  const insideTmux =
    (typeof env.TMUX === "string" && env.TMUX.length > 0) ||
    (typeof env.TERM === "string" && env.TERM.startsWith("tmux"));
  if (insideTmux) {
    // DCS passthrough so the outer terminal tab title also updates,
    // plus the screen/tmux window-name sequence so the tmux status
    // line itself reflects the run.  Both written together in one
    // string so the caller emits them in a single write().
    const passthrough = `${ESC}Ptmux;${ESC}${ESC}]0;${safe}${BEL}${ST}`;
    const windowName = `${ESC}k${safe}${ST}`;
    return `${passthrough}${windowName}`;
  }

  const insideScreen =
    typeof env.TERM === "string" && env.TERM.startsWith("screen");
  if (insideScreen) {
    return `${ESC}k${safe}${ST}`;
  }

  // Default (including cmux, which renders via Ghostty and accepts
  // OSC 0 passthrough).
  return `${ESC}]0;${safe}${BEL}`;
}

export interface UseTerminalTitleArgs {
  emitter: PipelineEventEmitter;
  owner: string;
  repo: string;
  issueNumber: number;
  /** Seeds the title with a known PR number on resume. */
  initialPrNumber?: number;
  /**
   * First stage that will actually execute in this run.  Drives the
   * "Stage 1: Bootstrap → Stage N: <name>" transitional label shown
   * before the first real `stage:enter` arrives.  Mirrors the value
   * passed to `<StatusBar>`.
   */
  firstExecutingStage?: number;
}

/**
 * Subscribe to the pipeline events that affect the terminal tab title
 * and write an OSC/DCS update via `process.stdout.write` whenever the
 * composed title changes.  Complete no-op when stdout is not a TTY:
 * no formatting, no encoding, no write.
 */
export function useTerminalTitle({
  emitter,
  owner,
  repo,
  issueNumber,
  initialPrNumber,
  firstExecutingStage,
}: UseTerminalTitleArgs): void {
  const [stage, setStage] = useState<StageEnterEvent | null>(null);
  const [prNumber, setPrNumber] = useState<number | undefined>(initialPrNumber);

  useEffect(() => {
    const onEnter = (ev: StageEnterEvent) => setStage(ev);
    const onOverride = (ev: StageNameOverrideEvent) => {
      setStage((prev) => (prev ? { ...prev, stageName: ev.stageName } : prev));
    };
    const onPrResolved = (ev: PrResolvedEvent) => setPrNumber(ev.prNumber);
    emitter.on("stage:enter", onEnter);
    emitter.on("stage:name-override", onOverride);
    emitter.on("pr:resolved", onPrResolved);
    return () => {
      emitter.off("stage:enter", onEnter);
      emitter.off("stage:name-override", onOverride);
      emitter.off("pr:resolved", onPrResolved);
    };
  }, [emitter]);

  const lastTitleRef = useRef<string | null>(null);

  useEffect(() => {
    if (process.stdout.isTTY !== true) return;

    const stageLabel = composeStageLabel(stage, firstExecutingStage);
    const title = formatTerminalTitle({
      owner,
      repo,
      issueNumber,
      prNumber,
      stageLabel,
    });
    if (title === lastTitleRef.current) return;
    lastTitleRef.current = title;

    const encoded = encodeTerminalTitle(title, {
      TERM: process.env.TERM,
      TMUX: process.env.TMUX,
      CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
      CMUX_SURFACE_ID: process.env.CMUX_SURFACE_ID,
    });
    if (encoded.length > 0) {
      process.stdout.write(encoded);
    }
  }, [owner, repo, issueNumber, prNumber, stage, firstExecutingStage]);
}

/**
 * Compose the stage label segment of the title from the current
 * `stage:enter` event and the `firstExecutingStage` fallback used
 * before the first real event arrives.  Mirrors `StatusBar`.
 */
function composeStageLabel(
  stage: StageEnterEvent | null,
  firstExecutingStage: number | undefined,
): string | undefined {
  const m = t();
  if (stage) {
    const round = stage.iteration + 1;
    return shouldShowRound(stage.stageNumber)
      ? m["statusBar.stageRound"](stage.stageNumber, stage.stageName, round)
      : m["statusBar.stage"](stage.stageNumber, stage.stageName);
  }
  if (firstExecutingStage !== undefined) {
    const bootstrapName = m["stage.bootstrap"];
    const nextName =
      stageDisplayName(firstExecutingStage, m) ??
      `Stage ${firstExecutingStage}`;
    return m["statusBar.bootstrapTransition"](
      1,
      bootstrapName,
      firstExecutingStage,
      nextName,
    );
  }
  return undefined;
}
