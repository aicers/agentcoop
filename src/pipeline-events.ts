import { EventEmitter } from "node:events";
import type { TokenUsage } from "./agent.js";

export interface AgentChunkEvent {
  agent: "a" | "b";
  chunk: string;
}

export interface StageEnterEvent {
  stageNumber: number;
  stageName: string;
  iteration: number;
}

export interface StageExitEvent {
  stageNumber: number;
  outcome: string;
}

export interface StageNameOverrideEvent {
  stageName: string;
}

export interface ReviewPostedEvent {
  round: number;
}

export interface AgentInvokeEvent {
  agent: "a" | "b";
  type: "invoke" | "resume";
  /** Prompt kind so the diagnostic can show orchestrator context. */
  kind?: AgentPromptKind;
  /** Review round (1-based) for review-stage invocations. */
  round?: number;
}

/**
 * Distinguishes the type of prompt sent to an agent without requiring
 * consumers to inspect prompt text.
 *
 * - `"work"` — primary stage prompt
 * - `"review"` — reviewer stage prompt (Agent B reviewing Agent A's work)
 * - `"verdict-followup"` — verdict clarification prompt
 * - `"ci-fix"` — CI failure fix prompt
 * - `"summary"` — unresolved summary request
 */
export type AgentPromptKind =
  | "work"
  | "review"
  | "verdict-followup"
  | "ci-fix"
  | "summary";

export interface AgentPromptEvent {
  agent: "a" | "b";
  prompt: string;
  /** Type of prompt. */
  kind: AgentPromptKind;
}

export interface AgentUsageEvent {
  agent: "a" | "b";
  usage: TokenUsage;
}

/**
 * Emitted whenever the orchestrator parses a verdict keyword from an
 * agent response.
 */
export interface PipelineVerdictEvent {
  /** Which agent produced the response. */
  agent: "a" | "b";
  /** The parsed keyword (e.g. `"COMPLETED"`, `"BLOCKED"`). */
  keyword: string;
  /** The raw text the keyword was extracted from. */
  raw: string;
}

/**
 * Emitted on auto-budget consumption and exhaustion.
 */
export interface PipelineLoopEvent {
  /** 1-based stage number. */
  stageNumber: number;
  /** Human-readable stage name. */
  stageName: string;
  /** Auto-iterations remaining after this advance. */
  remaining: number;
  /** Total auto-budget for the loop. */
  budget: number;
  /** `true` when the auto-budget has been exhausted. */
  exhausted: boolean;
  /** Primary agent for the looping stage (used for pane routing). */
  agent?: "a" | "b";
}

/**
 * Emitted on CI polling start, status change, and completion.
 */
export interface PipelineCiPollEvent {
  /** Phase of the polling lifecycle. */
  action: "start" | "status" | "done";
  /** Commit SHA being polled (when available). */
  sha?: string;
  /** CI verdict (when available). */
  verdict?: string;
}

interface PipelineEventMap {
  "agent:chunk": [AgentChunkEvent];
  "agent:prompt": [AgentPromptEvent];
  "agent:usage": [AgentUsageEvent];
  "stage:enter": [StageEnterEvent];
  "stage:exit": [StageExitEvent];
  "stage:name-override": [StageNameOverrideEvent];
  "review:posted": [ReviewPostedEvent];
  "agent:invoke": [AgentInvokeEvent];
  "pipeline:verdict": [PipelineVerdictEvent];
  "pipeline:loop": [PipelineLoopEvent];
  "pipeline:ci-poll": [PipelineCiPollEvent];
}

export class PipelineEventEmitter extends EventEmitter<PipelineEventMap> {}
