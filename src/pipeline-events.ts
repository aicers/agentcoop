import { EventEmitter } from "node:events";

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

export interface AgentInvokeEvent {
  agent: "a" | "b";
  type: "invoke" | "resume";
}

export interface AgentPromptEvent {
  agent: "a" | "b";
  prompt: string;
}

interface PipelineEventMap {
  "agent:chunk": [AgentChunkEvent];
  "agent:prompt": [AgentPromptEvent];
  "stage:enter": [StageEnterEvent];
  "stage:exit": [StageExitEvent];
  "agent:invoke": [AgentInvokeEvent];
}

export class PipelineEventEmitter extends EventEmitter<PipelineEventMap> {}
