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
}

export interface AgentPromptEvent {
  agent: "a" | "b";
  prompt: string;
}

export interface AgentUsageEvent {
  agent: "a" | "b";
  usage: TokenUsage;
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
}

export class PipelineEventEmitter extends EventEmitter<PipelineEventMap> {}
