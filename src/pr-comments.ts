/**
 * PR comment fetching, parsing, posting, and state reconciliation.
 *
 * PR comments are the source of truth for review-loop state.  This
 * module provides utilities to read, parse, and post PR comments, and
 * to reconcile local RunState with the PR-derived state on resume.
 */

import { execFileSync } from "node:child_process";

import type { ReviewSubStep, RunState } from "./run-state.js";

// ---- types ---------------------------------------------------------------

export interface PrComment {
  id?: number;
  body: string;
  user: { login: string };
}

/**
 * Review state derived from PR comments.
 */
export interface PrReviewState {
  /** Max round number found in `[Reviewer Round {n}]` comments. */
  maxReviewerRound: number;
  /** Max round number found in `[Author Round {n}]` comments. */
  maxAuthorRound: number;
  /** Max round number found in `[Review Verdict Round {n}]` comments. */
  maxVerdictRound: number;
  /** Verdict from the highest-numbered verdict comment. */
  latestVerdict: "APPROVED" | "NOT_APPROVED" | undefined;
}

export interface ReconciliationResult {
  warnings: string[];
  sessionsInvalidated: boolean;
}

// ---- comment patterns ----------------------------------------------------

/**
 * Match `[Reviewer Round {n}]` or `**[Reviewer Round {n}]**` at the
 * start of a comment body (allowing leading whitespace/bold markers).
 */
const REVIEWER_ROUND_RE = /^\s*\*{0,2}\[Reviewer Round (\d+)\]/;

/**
 * Match `[Author Round {n}]` or `**[Author Round {n}]**`.
 */
const AUTHOR_ROUND_RE = /^\s*\*{0,2}\[Author Round (\d+)\]/;

/**
 * Match `[Review Verdict Round {n}: APPROVED|NOT_APPROVED]`.
 * This is posted by agentcoop (not agents), so no bold markers.
 */
const VERDICT_ROUND_RE =
  /^\s*\[Review Verdict Round (\d+): (APPROVED|NOT_APPROVED)\]/;

// ---- fetch / post --------------------------------------------------------

/**
 * Fetch all comments on a PR.
 *
 * Throws if the API call fails (e.g. network error, auth failure,
 * rate limit).  Callers must handle the error — silently returning
 * `[]` would make reconciliation skip PR sync without warning.
 */
export function fetchPrComments(
  owner: string,
  repo: string,
  prNumber: number,
): PrComment[] {
  const output = execFileSync(
    "gh",
    [
      "api",
      `repos/${owner}/${repo}/issues/${prNumber}/comments`,
      "--paginate",
      "--slurp",
    ],
    { encoding: "utf-8" },
  );
  // --slurp wraps all pages in an outer array: [[page1...], [page2...]].
  // Flatten to a single array of comments.
  const pages: PrComment[][] = JSON.parse(output);
  return pages.flat();
}

/**
 * Post a comment on a PR.
 */
export function postPrComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): void {
  execFileSync(
    "gh",
    [
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      `${owner}/${repo}`,
      "--body",
      body,
    ],
    { encoding: "utf-8" },
  );
}

/**
 * Edit an existing issue/PR comment by id.
 *
 * The body is sent via stdin as a JSON request payload so that
 * arbitrary multi-line content (including leading `@`, fences, and
 * other characters that confuse `gh api`'s `-f key=value` parsing)
 * is preserved verbatim.
 */
export function patchPrComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): void {
  execFileSync(
    "gh",
    [
      "api",
      "--method",
      "PATCH",
      `/repos/${owner}/${repo}/issues/comments/${commentId}`,
      "--input",
      "-",
    ],
    { encoding: "utf-8", input: JSON.stringify({ body }) },
  );
}

// ---- marker-lookup helper ------------------------------------------------

/**
 * Find the most recent PR comment whose body contains `marker`.
 *
 * Returns `{ id, body }` for the latest matching comment (the last one
 * in chronological order returned by `gh`), or `undefined` only when
 * the lookup succeeded and no comment matched.
 *
 * Errors from the underlying `gh api` call (network, auth, rate
 * limit) propagate to the caller — they are NOT swallowed into
 * `undefined`.  Write-side callers like
 * `postOrUpdateSquashSuggestion` must distinguish "no matching
 * comment" from "lookup failed" so a transient failure does not turn
 * an idempotent PATCH into a duplicate POST.  Read-only callers that
 * prefer to silently degrade should wrap this with `try`/`catch`
 * themselves.
 *
 * The id is required by callers that want to PATCH the comment
 * idempotently rather than posting a new one; read-only callers can
 * destructure `.body`.  When the upstream API response omits the id
 * (older fixtures, manual stubs), id is `undefined` and PATCH callers
 * must fall back to POST.
 */
export function findLatestCommentWithMarker(
  owner: string,
  repo: string,
  prNumber: number,
  marker: string,
): { id: number | undefined; body: string } | undefined {
  const comments = fetchPrComments(owner, repo, prNumber);
  let latest: { id: number | undefined; body: string } | undefined;
  for (const c of comments) {
    if (c.body.includes(marker)) latest = { id: c.id, body: c.body };
  }
  return latest;
}

// ---- parsing -------------------------------------------------------------

/**
 * Parse PR comments to extract review-loop state.
 *
 * Uses max round numbers (not occurrence count) since duplicates
 * are possible after crash/resume.
 */
export function parsePrReviewState(comments: PrComment[]): PrReviewState {
  let maxReviewerRound = 0;
  let maxAuthorRound = 0;
  let maxVerdictRound = 0;
  let latestVerdict: "APPROVED" | "NOT_APPROVED" | undefined;

  for (const comment of comments) {
    const reviewerMatch = comment.body.match(REVIEWER_ROUND_RE);
    if (reviewerMatch) {
      const round = Number(reviewerMatch[1]);
      if (round > maxReviewerRound) maxReviewerRound = round;
    }

    const authorMatch = comment.body.match(AUTHOR_ROUND_RE);
    if (authorMatch) {
      const round = Number(authorMatch[1]);
      if (round > maxAuthorRound) maxAuthorRound = round;
    }

    const verdictMatch = comment.body.match(VERDICT_ROUND_RE);
    if (verdictMatch) {
      const round = Number(verdictMatch[1]);
      if (round > maxVerdictRound) {
        maxVerdictRound = round;
        latestVerdict = verdictMatch[2] as "APPROVED" | "NOT_APPROVED";
      }
    }
  }

  return {
    maxReviewerRound,
    maxAuthorRound,
    maxVerdictRound,
    latestVerdict,
  };
}

/**
 * Check whether any comment matches the given pattern.
 */
export function hasComment(comments: PrComment[], pattern: RegExp): boolean {
  return comments.some((c) => pattern.test(c.body));
}

/**
 * Build a regex that matches a specific reviewer round comment.
 */
export function reviewerRoundPattern(round: number): RegExp {
  return new RegExp(`^\\s*\\*{0,2}\\[Reviewer Round ${round}\\]`);
}

/**
 * Build a regex that matches a specific author round comment.
 */
export function authorRoundPattern(round: number): RegExp {
  return new RegExp(`^\\s*\\*{0,2}\\[Author Round ${round}\\]`);
}

// ---- sub-step derivation -------------------------------------------------

/**
 * Derive the review sub-step and verdict for a specific round from
 * PR comments.  This tells the handler where to resume after a crash
 * or interruption.
 *
 * Conservative: when in doubt, choose an earlier sub-step so that
 * incomplete work is re-done rather than skipped.
 */
export function deriveReviewSubStep(
  prState: PrReviewState,
  round: number,
): {
  subStep: ReviewSubStep;
  verdict: "APPROVED" | "NOT_APPROVED" | undefined;
} {
  const hasReview = prState.maxReviewerRound >= round;
  const hasVerdict = prState.maxVerdictRound >= round;
  const hasAuthor = prState.maxAuthorRound >= round;

  if (!hasReview) {
    return { subStep: "review", verdict: undefined };
  }

  if (!hasVerdict) {
    return { subStep: "verdict", verdict: undefined };
  }

  // Verdict exists for this round.  Since round is derived from
  // prMaxRound during reconciliation, latestVerdict is the verdict
  // for this specific round.
  const verdict =
    prState.maxVerdictRound === round ? prState.latestVerdict : undefined;

  if (verdict === "APPROVED") {
    // Conservative: re-enter at unresolved_summary because we cannot
    // determine from PR comments whether unresolved summary or PR
    // finalization completed.
    return { subStep: "unresolved_summary", verdict };
  }

  // NOT_APPROVED (or unknown verdict for this round).
  if (!hasAuthor) {
    return { subStep: "author_fix", verdict };
  }

  // Author responded — the fix work is done.  Resume at CI poll.
  return { subStep: "ci_poll", verdict };
}

// ---- reconciliation ------------------------------------------------------

/**
 * Reconcile local RunState with PR-derived review state.
 *
 * Mutates `runState` in place and returns warnings for any
 * corrections.  When any review-state field changes, saved agent
 * sessions are invalidated (cleared) because they carry stale
 * context.
 */
export function reconcileWithPr(
  runState: RunState,
  prState: PrReviewState,
): ReconciliationResult {
  const warnings: string[] = [];
  let stateChanged = false;

  const prMaxRound = Math.max(
    prState.maxReviewerRound,
    prState.maxAuthorRound,
    prState.maxVerdictRound,
  );

  // 1. Reconcile reviewCount from PR.  reviewCount is a persisted UI
  //    counter, not part of the authoritative review state.  A mismatch
  //    (e.g. the reviewer comment was posted but the process crashed
  //    before run-state.json was updated) should NOT invalidate agent
  //    sessions — only true review-state divergence warrants that.
  if (prState.maxReviewerRound !== runState.reviewCount) {
    warnings.push(
      `PR sync: reviewCount corrected from ${runState.reviewCount} to ${prState.maxReviewerRound}`,
    );
    runState.reviewCount = prState.maxReviewerRound;
  }

  // 2. Demote currentStage if local claims stage 7 completed but
  //    the max round does not have an APPROVED verdict.
  //    A verdict is only trusted when the corresponding reviewer
  //    comment exists — an orphan verdict (e.g. from a partial
  //    failure or stale history) must not keep currentStage past 7.
  const maxRoundApproved =
    prState.maxVerdictRound === prMaxRound &&
    prState.latestVerdict === "APPROVED" &&
    prState.maxReviewerRound >= prMaxRound;
  if (runState.currentStage > 7 && !maxRoundApproved) {
    warnings.push(
      `PR sync: currentStage demoted from ${runState.currentStage} to 7 (stage 7 work incomplete on PR)`,
    );
    runState.currentStage = 7;
    stateChanged = true;
  }

  // 2b. Promote currentStage if local state is behind the PR.
  //     When PR comments show the review loop has started (any
  //     reviewer/author/verdict round > 0) but local currentStage
  //     is still before stage 7, the process must have died after
  //     posting review comments but before updating run-state.json.
  //     Promote to stage 7 so the pipeline resumes in the review
  //     loop rather than re-running earlier stages.
  if (runState.currentStage < 7 && prMaxRound > 0) {
    warnings.push(
      `PR sync: currentStage promoted from ${runState.currentStage} to 7 (PR has review round ${prMaxRound})`,
    );
    runState.currentStage = 7;
    stateChanged = true;
  }

  // 3. Reconcile reviewRound and stageLoopCount.
  //    reviewRound reflects the final review round reached and must be
  //    correct regardless of the current stage.  stageLoopCount, however,
  //    is a generic per-stage loop counter (used by stage 6 for test-plan
  //    iterations, stage 7 for review iterations, etc.).  PR-derived
  //    round data should only drive stageLoopCount when the pipeline will
  //    resume stage 7 — otherwise the current stage's own loop counter
  //    must be left alone.
  const correctReviewRound = prMaxRound;

  if (runState.reviewRound !== correctReviewRound) {
    warnings.push(
      `PR sync: reviewRound corrected from ${runState.reviewRound} to ${correctReviewRound}`,
    );
    runState.reviewRound = correctReviewRound;
    stateChanged = true;
  }
  if (runState.currentStage === 7) {
    const correctStageLoopCount = Math.max(0, prMaxRound - 1);
    if (runState.stageLoopCount !== correctStageLoopCount) {
      warnings.push(
        `PR sync: stageLoopCount corrected from ${runState.stageLoopCount} to ${correctStageLoopCount}`,
      );
      runState.stageLoopCount = correctStageLoopCount;
      stateChanged = true;
    }
  }

  // 4. Reconcile reviewSubStep and lastVerdict.  This detects
  //    verdict and position mismatches even when round numbers
  //    already match.  The check runs regardless of currentStage:
  //    sessions from stage 7 are passed to later stages (e.g.
  //    squash at stage 8), so a verdict/sub-step divergence must
  //    trigger session invalidation even when currentStage > 7.
  //
  //    Exception: when currentStage > 7 and the max round is
  //    APPROVED, local state is authoritative for post-approval
  //    progress.  PR comments cannot encode whether unresolved
  //    summary or PR finalization completed, so deriveReviewSubStep
  //    conservatively returns "unresolved_summary".  Comparing that
  //    against a local "pr_finalization" would be a false mismatch
  //    that needlessly invalidates sessions carried forward to
  //    later stages.
  if (runState.reviewRound > 0) {
    const derived = deriveReviewSubStep(prState, runState.reviewRound);

    // Skip sub-step reconciliation when the pipeline has already
    // advanced past stage 7 with an approved verdict AND local
    // state already acknowledges the approval.  If the local
    // verdict is wrong (e.g. still undefined), the pipeline never
    // actually completed the approved path, so sub-step correction
    // is still needed.
    const skipSubStepReconciliation =
      runState.currentStage > 7 &&
      maxRoundApproved &&
      runState.lastVerdict === "APPROVED";

    if (!skipSubStepReconciliation) {
      if (runState.reviewSubStep !== derived.subStep) {
        warnings.push(
          `PR sync: reviewSubStep corrected from ${runState.reviewSubStep} to ${derived.subStep}`,
        );
        runState.reviewSubStep = derived.subStep;
        stateChanged = true;
      }
    }
    if (runState.lastVerdict !== derived.verdict) {
      warnings.push(
        `PR sync: lastVerdict corrected from ${runState.lastVerdict} to ${derived.verdict}`,
      );
      runState.lastVerdict = derived.verdict;
      stateChanged = true;
    }
  } else {
    // No review rounds on the PR — clear any stale post-verdict fields.
    if (runState.reviewSubStep !== undefined) {
      warnings.push(
        `PR sync: reviewSubStep corrected from ${runState.reviewSubStep} to undefined`,
      );
      runState.reviewSubStep = undefined;
      stateChanged = true;
    }
    if (runState.lastVerdict !== undefined) {
      warnings.push(
        `PR sync: lastVerdict corrected from ${runState.lastVerdict} to undefined`,
      );
      runState.lastVerdict = undefined;
      stateChanged = true;
    }
  }

  // 5. Invalidate agent sessions when any review state diverged.
  if (stateChanged) {
    runState.agentA.sessionId = undefined;
    runState.agentB.sessionId = undefined;
    warnings.push(
      "PR sync: agent sessions invalidated due to state divergence",
    );
  }

  return { warnings, sessionsInvalidated: stateChanged };
}
