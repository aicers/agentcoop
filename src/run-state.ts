/**
 * Run state persistence — save/load/delete pipeline state so the
 * pipeline can be resumed after interruption.
 *
 * State files live at `~/.agentcoop/runs/{owner}/{repo}/{issue_number}.json`.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---- public types --------------------------------------------------------

export interface AgentState {
  cli: string;
  model: string;
  sessionId: string | undefined;
}

/**
 * Bump this when the stage order or semantics change so that
 * {@link loadRunState} can migrate persisted files written by
 * earlier versions.
 *
 * History:
 *  1 — original order (stages 7=squash, 8=review)
 *  2 — swapped stages 7↔8 (7=review, 8=squash)
 */
export const RUN_STATE_VERSION = 2;

export interface RunState {
  version: number;
  owner: string;
  repo: string;
  issueNumber: number;
  branch: string;
  worktreePath: string;
  prNumber: number | undefined;
  currentStage: number;
  stageLoopCount: number;
  reviewRound: number;
  executionMode: "auto" | "step";
  claudePermissionMode: "auto" | "bypass";
  agentA: AgentState;
  agentB: AgentState;
}

// ---- path helpers --------------------------------------------------------

export function runStatePath(
  owner: string,
  repo: string,
  issueNumber: number,
): string {
  return join(
    homedir(),
    ".agentcoop",
    "runs",
    owner,
    repo,
    `${issueNumber}.json`,
  );
}

// ---- save / load / delete ------------------------------------------------

export function saveRunState(state: RunState): void {
  const path = runStatePath(state.owner, state.repo, state.issueNumber);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

function isValidAgentState(v: unknown): v is AgentState {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.cli === "string" &&
    typeof r.model === "string" &&
    (r.sessionId === undefined ||
      r.sessionId === null ||
      typeof r.sessionId === "string")
  );
}

/** Accept both versioned (v2+) and legacy (no version field) states. */
function isValidRunState(
  v: unknown,
): v is RunState | Omit<RunState, "version"> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    // version is optional for legacy files
    (r.version === undefined || typeof r.version === "number") &&
    typeof r.owner === "string" &&
    typeof r.repo === "string" &&
    typeof r.issueNumber === "number" &&
    typeof r.branch === "string" &&
    typeof r.worktreePath === "string" &&
    (r.prNumber === undefined ||
      r.prNumber === null ||
      typeof r.prNumber === "number") &&
    typeof r.currentStage === "number" &&
    typeof r.stageLoopCount === "number" &&
    typeof r.reviewRound === "number" &&
    (r.executionMode === "auto" || r.executionMode === "step") &&
    (r.claudePermissionMode === "auto" ||
      r.claudePermissionMode === "bypass") &&
    isValidAgentState(r.agentA) &&
    isValidAgentState(r.agentB)
  );
}

/**
 * Migrate a legacy (v1 / unversioned) run-state to the current version.
 *
 * v1 → v2: stages 7 (squash) and 8 (review) were swapped.  If
 * `currentStage` is one of those two, remap it so the run resumes
 * into the correct handler.
 */
function migrateRunState(state: RunState): RunState {
  if (state.version >= RUN_STATE_VERSION) return state;

  const migrated = { ...state };

  // v1 → v2: swap stages 7 ↔ 8
  if (migrated.currentStage === 7) {
    migrated.currentStage = 8;
  } else if (migrated.currentStage === 8) {
    migrated.currentStage = 7;
  }

  migrated.version = RUN_STATE_VERSION;
  return migrated;
}

export function loadRunState(
  owner: string,
  repo: string,
  issueNumber: number,
): RunState | undefined {
  const path = runStatePath(owner, repo, issueNumber);
  if (!existsSync(path)) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }

  if (!isValidRunState(raw)) return undefined;

  // Normalise null → undefined for optional fields and backfill version.
  const normalised: RunState = {
    ...raw,
    version: ((raw as Record<string, unknown>).version as number) ?? 1,
    prNumber: raw.prNumber ?? undefined,
    agentA: {
      ...raw.agentA,
      sessionId: raw.agentA.sessionId ?? undefined,
    },
    agentB: {
      ...raw.agentB,
      sessionId: raw.agentB.sessionId ?? undefined,
    },
  };

  return migrateRunState(normalised);
}

export function deleteRunState(
  owner: string,
  repo: string,
  issueNumber: number,
): void {
  const path = runStatePath(owner, repo, issueNumber);
  rmSync(path, { force: true });
}
