import { describe, expect, test } from "vitest";
import type { PrComment } from "./pr-comments.js";
import {
  authorRoundPattern,
  deriveReviewSubStep,
  hasComment,
  parsePrReviewState,
  reconcileWithPr,
  reviewerRoundPattern,
} from "./pr-comments.js";
import { RUN_STATE_VERSION, type RunState } from "./run-state.js";

// ---- helpers ---------------------------------------------------------------

function makeComment(body: string): PrComment {
  return { body, user: { login: "bot" } };
}

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    version: RUN_STATE_VERSION,
    owner: "org",
    repo: "repo",
    issueNumber: 42,
    branch: "issue-42",
    worktreePath: "/tmp/wt/issue-42",
    baseSha: undefined,
    prNumber: 10,
    currentStage: 7,
    stageLoopCount: 0,
    reviewRound: 1,
    selfCheckCount: 0,
    reviewCount: 0,
    reviewSubStep: undefined,
    lastVerdict: undefined,
    executionMode: "auto",
    agentA: {
      cli: "claude",
      model: "opus",
      contextWindow: undefined,
      effortLevel: undefined,
      sessionId: "sess-a",
    },
    agentB: {
      cli: "claude",
      model: "sonnet",
      contextWindow: undefined,
      effortLevel: undefined,
      sessionId: "sess-b",
    },
    issueSyncStatus: "skipped",
    issueChanges: [],
    ...overrides,
  };
}

// ---- parsePrReviewState ----------------------------------------------------

describe("parsePrReviewState", () => {
  test("returns zeros for empty comments", () => {
    const state = parsePrReviewState([]);
    expect(state.maxReviewerRound).toBe(0);
    expect(state.maxAuthorRound).toBe(0);
    expect(state.maxVerdictRound).toBe(0);
    expect(state.latestVerdict).toBeUndefined();
  });

  test("extracts max reviewer round", () => {
    const comments = [
      makeComment("**[Reviewer Round 1]** Some review."),
      makeComment("**[Reviewer Round 3]** Another review."),
      makeComment("**[Reviewer Round 2]** Middle review."),
    ];
    const state = parsePrReviewState(comments);
    expect(state.maxReviewerRound).toBe(3);
  });

  test("extracts max author round", () => {
    const comments = [
      makeComment("**[Author Round 1]** Fixes applied."),
      makeComment("**[Author Round 2]** More fixes."),
    ];
    const state = parsePrReviewState(comments);
    expect(state.maxAuthorRound).toBe(2);
  });

  test("extracts verdict with APPROVED", () => {
    const comments = [
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("[Review Verdict Round 2: APPROVED]"),
    ];
    const state = parsePrReviewState(comments);
    expect(state.maxVerdictRound).toBe(2);
    expect(state.latestVerdict).toBe("APPROVED");
  });

  test("extracts verdict with NOT_APPROVED", () => {
    const comments = [makeComment("[Review Verdict Round 1: NOT_APPROVED]")];
    const state = parsePrReviewState(comments);
    expect(state.maxVerdictRound).toBe(1);
    expect(state.latestVerdict).toBe("NOT_APPROVED");
  });

  test("handles mixed comments", () => {
    const comments = [
      makeComment("**[Reviewer Round 1]** Review 1."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix 1."),
      makeComment("**[Reviewer Round 2]** Review 2."),
      makeComment("[Review Verdict Round 2: APPROVED]"),
    ];
    const state = parsePrReviewState(comments);
    expect(state.maxReviewerRound).toBe(2);
    expect(state.maxAuthorRound).toBe(1);
    expect(state.maxVerdictRound).toBe(2);
    expect(state.latestVerdict).toBe("APPROVED");
  });

  test("ignores comments without matching patterns", () => {
    const comments = [
      makeComment("Regular PR comment."),
      makeComment("LGTM!"),
      makeComment("Some discussion about the approach."),
    ];
    const state = parsePrReviewState(comments);
    expect(state.maxReviewerRound).toBe(0);
    expect(state.maxAuthorRound).toBe(0);
    expect(state.maxVerdictRound).toBe(0);
  });

  test("handles bold markdown markers", () => {
    const comments = [
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Author Round 1] Fix."),
    ];
    const state = parsePrReviewState(comments);
    expect(state.maxReviewerRound).toBe(1);
    expect(state.maxAuthorRound).toBe(1);
  });

  test("handles duplicates by taking max round", () => {
    const comments = [
      makeComment("**[Reviewer Round 2]** First attempt."),
      makeComment("**[Reviewer Round 2]** Duplicate after crash."),
    ];
    const state = parsePrReviewState(comments);
    expect(state.maxReviewerRound).toBe(2);
  });
});

// ---- hasComment / patterns -------------------------------------------------

describe("hasComment", () => {
  test("finds reviewer round comment", () => {
    const comments = [makeComment("**[Reviewer Round 1]** Review.")];
    expect(hasComment(comments, reviewerRoundPattern(1))).toBe(true);
    expect(hasComment(comments, reviewerRoundPattern(2))).toBe(false);
  });

  test("finds author round comment", () => {
    const comments = [makeComment("**[Author Round 3]** Fix.")];
    expect(hasComment(comments, authorRoundPattern(3))).toBe(true);
    expect(hasComment(comments, authorRoundPattern(1))).toBe(false);
  });

  test("returns false for empty list", () => {
    expect(hasComment([], reviewerRoundPattern(1))).toBe(false);
  });
});

// ---- reconcileWithPr -------------------------------------------------------

describe("reconcileWithPr", () => {
  test("no-op when PR has no review comments and local state is fresh", () => {
    const state = makeRunState({
      reviewRound: 0,
      stageLoopCount: 0,
      reviewCount: 0,
      currentStage: 7,
    });
    const prState = parsePrReviewState([]);
    const result = reconcileWithPr(state, prState);

    expect(result.warnings).toHaveLength(0);
    expect(result.sessionsInvalidated).toBe(false);
    expect(state.agentA.sessionId).toBe("sess-a");
  });

  test("corrects stale stage-7 local state against empty PR history", () => {
    // Local state thinks review round 1 started, but the PR has
    // no review comments — the reviewer comment never made it.
    const state = makeRunState({
      currentStage: 7,
      reviewRound: 1,
      stageLoopCount: 0,
      reviewCount: 1,
      reviewSubStep: "verdict",
      lastVerdict: undefined,
    });
    const prState = parsePrReviewState([]);
    const result = reconcileWithPr(state, prState);

    expect(state.reviewRound).toBe(0);
    expect(state.stageLoopCount).toBe(0);
    expect(state.reviewCount).toBe(0);
    expect(state.reviewSubStep).toBeUndefined();
    expect(result.sessionsInvalidated).toBe(true);
    expect(state.agentA.sessionId).toBeUndefined();
    expect(state.agentB.sessionId).toBeUndefined();
  });

  test("corrects stale stage-8 local state against empty PR history", () => {
    // Local state claims past stage 7, but the PR has no review
    // comments at all — everything must be corrected and demoted.
    const state = makeRunState({
      currentStage: 8,
      reviewRound: 2,
      stageLoopCount: 1,
      reviewCount: 2,
      reviewSubStep: "unresolved_summary",
      lastVerdict: "APPROVED",
    });
    const prState = parsePrReviewState([]);
    const result = reconcileWithPr(state, prState);

    expect(state.currentStage).toBe(7);
    expect(state.reviewRound).toBe(0);
    expect(state.stageLoopCount).toBe(0);
    expect(state.reviewCount).toBe(0);
    expect(state.reviewSubStep).toBeUndefined();
    expect(state.lastVerdict).toBeUndefined();
    expect(result.sessionsInvalidated).toBe(true);
    expect(state.agentA.sessionId).toBeUndefined();
  });

  test("corrects reviewCount from PR", () => {
    const state = makeRunState({ reviewCount: 0, reviewRound: 1 });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(state.reviewCount).toBe(2);
    expect(result.warnings.some((w) => w.includes("reviewCount"))).toBe(true);
  });

  test("corrects reviewRound and stageLoopCount at stage 7", () => {
    const state = makeRunState({
      currentStage: 7,
      reviewRound: 1,
      stageLoopCount: 0,
      reviewCount: 0,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
      makeComment("[Review Verdict Round 2: NOT_APPROVED]"),
      makeComment("**[Author Round 2]** Fix."),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(state.reviewRound).toBe(2);
    expect(state.stageLoopCount).toBe(1);
    expect(result.sessionsInvalidated).toBe(true);
    expect(state.agentA.sessionId).toBeUndefined();
    expect(state.agentB.sessionId).toBeUndefined();
  });

  test("demotes currentStage when PR has no APPROVED verdict", () => {
    const state = makeRunState({
      currentStage: 8,
      reviewRound: 2,
      stageLoopCount: 1,
      reviewCount: 2,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
      makeComment("[Review Verdict Round 2: NOT_APPROVED]"),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(state.currentStage).toBe(7);
    expect(result.sessionsInvalidated).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("currentStage demoted")),
    ).toBe(true);
  });

  test("does not demote when PR has APPROVED verdict for max round", () => {
    const state = makeRunState({
      currentStage: 8,
      reviewRound: 2,
      stageLoopCount: 1,
      reviewCount: 2,
      reviewSubStep: "unresolved_summary",
      lastVerdict: "APPROVED",
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
      makeComment("[Review Verdict Round 2: APPROVED]"),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(state.currentStage).toBe(8);
    expect(result.sessionsInvalidated).toBe(false);
  });

  test("invalidates sessions when past stage 7 with matching counters but divergent verdict", () => {
    // Stage 8 with correct round counters, but local state has
    // wrong verdict — sessions carry stale context and must be
    // invalidated even though currentStage > 7.
    const state = makeRunState({
      currentStage: 8,
      reviewRound: 2,
      stageLoopCount: 1,
      reviewCount: 2,
      reviewSubStep: "verdict",
      lastVerdict: undefined,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
      makeComment("[Review Verdict Round 2: APPROVED]"),
    ]);
    const result = reconcileWithPr(state, prState);

    // No demotion — max round is APPROVED.
    expect(state.currentStage).toBe(8);
    // But sessions must be invalidated due to verdict divergence.
    expect(result.sessionsInvalidated).toBe(true);
    expect(state.agentA.sessionId).toBeUndefined();
    expect(state.agentB.sessionId).toBeUndefined();
    expect(state.reviewSubStep).toBe("unresolved_summary");
    expect(state.lastVerdict).toBe("APPROVED");
  });

  test("demotes when older round is APPROVED but newer round has no verdict", () => {
    // Round 2 is APPROVED, but a Round 3 reviewer comment exists
    // without a verdict — stage 7 is still incomplete.
    const state = makeRunState({
      currentStage: 8,
      reviewRound: 2,
      stageLoopCount: 1,
      reviewCount: 2,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
      makeComment("[Review Verdict Round 2: APPROVED]"),
      makeComment("**[Reviewer Round 3]** Another review."),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(state.currentStage).toBe(7);
    expect(state.reviewRound).toBe(3);
    expect(state.stageLoopCount).toBe(2);
    expect(state.reviewCount).toBe(3);
    expect(result.sessionsInvalidated).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("currentStage demoted")),
    ).toBe(true);
  });

  test("reconciles reviewRound but not stageLoopCount when beyond stage 7", () => {
    // Stage 8 with correct APPROVED verdict for max round, but
    // reviewRound is stale.  stageLoopCount belongs to stage 8 now,
    // so PR sync must not overwrite it with the review-derived value.
    const state = makeRunState({
      currentStage: 8,
      reviewRound: 1,
      stageLoopCount: 0,
      reviewCount: 1,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
      makeComment("[Review Verdict Round 2: APPROVED]"),
    ]);
    const result = reconcileWithPr(state, prState);

    // Should NOT demote — max round (2) is APPROVED.
    expect(state.currentStage).toBe(8);
    // reviewRound corrected, but stageLoopCount left alone (it's stage 8's counter).
    expect(state.reviewRound).toBe(2);
    expect(state.stageLoopCount).toBe(0);
    expect(state.reviewCount).toBe(2);
    expect(result.sessionsInvalidated).toBe(true);
  });

  test("promotes currentStage when local state is behind PR", () => {
    // Regression: stage 7 posts [Reviewer Round 1] but the process
    // dies before run-state.json is updated from stage 6 to stage 7.
    // Reconciliation must promote currentStage to 7 and set
    // stageLoopCount from the PR round so the pipeline resumes in
    // the review loop instead of re-running earlier stages.
    const state = makeRunState({
      currentStage: 6,
      reviewRound: 0,
      stageLoopCount: 3, // stage 6 loop counter
      reviewCount: 0,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(state.currentStage).toBe(7);
    expect(state.reviewRound).toBe(1);
    // stageLoopCount is now stage 7's counter: max(0, 1-1) = 0
    expect(state.stageLoopCount).toBe(0);
    expect(state.reviewCount).toBe(1);
    expect(result.sessionsInvalidated).toBe(true);
    expect(state.agentA.sessionId).toBeUndefined();
    expect(state.agentB.sessionId).toBeUndefined();
    expect(
      result.warnings.some((w) => w.includes("currentStage promoted")),
    ).toBe(true);
  });

  test("promotes currentStage and sets stageLoopCount for multi-round PR", () => {
    // Local state stuck at stage 5 but PR has two review rounds.
    const state = makeRunState({
      currentStage: 5,
      reviewRound: 0,
      stageLoopCount: 1,
      reviewCount: 0,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(state.currentStage).toBe(7);
    expect(state.reviewRound).toBe(2);
    // stageLoopCount derived from PR: max(0, 2-1) = 1
    expect(state.stageLoopCount).toBe(1);
    expect(state.reviewCount).toBe(2);
    expect(result.sessionsInvalidated).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("currentStage promoted")),
    ).toBe(true);
  });

  test("does not overwrite stageLoopCount when resuming before stage 7", () => {
    // Regression: resuming in stage 6 (test plan) with a prNumber set
    // and no review comments yet.  stageLoopCount is the test-plan
    // loop counter and must not be zeroed by PR sync.
    const state = makeRunState({
      currentStage: 6,
      reviewRound: 0,
      stageLoopCount: 3,
      reviewCount: 0,
    });
    const prState = parsePrReviewState([]);
    const result = reconcileWithPr(state, prState);

    expect(state.currentStage).toBe(6);
    expect(state.stageLoopCount).toBe(3);
    expect(state.reviewRound).toBe(0);
    expect(result.sessionsInvalidated).toBe(false);
  });

  test("invalidates sessions when any state diverges", () => {
    const state = makeRunState({
      currentStage: 7,
      reviewRound: 1,
      stageLoopCount: 0,
      reviewCount: 0,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(result.sessionsInvalidated).toBe(true);
    expect(state.agentA.sessionId).toBeUndefined();
    expect(state.agentB.sessionId).toBeUndefined();
  });

  test("invalidates sessions when sub-step diverges despite matching round", () => {
    // Round numbers match (round 2) but local state has no
    // reviewSubStep — the PR shows reviewer round 2 posted without
    // a verdict, so derived sub-step is "verdict".  The mismatch
    // triggers session invalidation.
    const state = makeRunState({
      currentStage: 7,
      reviewRound: 2,
      stageLoopCount: 1,
      reviewCount: 2,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(result.sessionsInvalidated).toBe(true);
    expect(state.agentA.sessionId).toBeUndefined();
    expect(state.agentB.sessionId).toBeUndefined();
    expect(state.reviewSubStep).toBe("verdict");
  });

  test("no session invalidation when all fields match including sub-step", () => {
    const state = makeRunState({
      currentStage: 7,
      reviewRound: 2,
      stageLoopCount: 1,
      reviewCount: 2,
      reviewSubStep: "verdict",
      lastVerdict: undefined,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(result.sessionsInvalidated).toBe(false);
    expect(state.agentA.sessionId).toBe("sess-a");
    expect(state.agentB.sessionId).toBe("sess-b");
  });

  test("no session invalidation when round 2 resumes before verdict and round 1 was NOT_APPROVED", () => {
    // Regression: after onReviewProgress clears lastVerdict on entering
    // a pre-verdict step, a resume in round 2 (before any round-2
    // verdict) must not invalidate sessions just because round 1 ended
    // NOT_APPROVED.  The key invariant is that local lastVerdict is
    // undefined (cleared by the fix), matching the PR-derived verdict
    // for the incomplete round 2.
    const state = makeRunState({
      currentStage: 7,
      reviewRound: 2,
      stageLoopCount: 1,
      reviewCount: 2,
      reviewSubStep: "verdict",
      lastVerdict: undefined,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(result.sessionsInvalidated).toBe(false);
    expect(state.agentA.sessionId).toBe("sess-a");
    expect(state.agentB.sessionId).toBe("sess-b");
    expect(state.lastVerdict).toBeUndefined();
  });

  test("no session invalidation when only reviewCount diverges", () => {
    // Regression: reviewCount is a persisted UI counter, not
    // authoritative review state.  If the reviewer comment was posted
    // but the process crashed before run-state.json updated
    // reviewCount, the mismatch should correct the counter without
    // invalidating agent sessions (round, verdict, and sub-step all
    // match the PR).
    const state = makeRunState({
      currentStage: 7,
      reviewRound: 2,
      stageLoopCount: 1,
      reviewCount: 1, // stale — should become 2
      reviewSubStep: "verdict",
      lastVerdict: undefined,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(state.reviewCount).toBe(2);
    expect(result.sessionsInvalidated).toBe(false);
    expect(state.agentA.sessionId).toBe("sess-a");
    expect(state.agentB.sessionId).toBe("sess-b");
  });

  test("handles APPROVED at stage 7 — re-enters at the approved round", () => {
    const state = makeRunState({
      currentStage: 7,
      reviewRound: 1,
      stageLoopCount: 0,
      reviewCount: 0,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: APPROVED]"),
    ]);
    const result = reconcileWithPr(state, prState);

    // reviewRound stays at 1 (max round is 1, matches local)
    expect(state.reviewRound).toBe(1);
    expect(state.stageLoopCount).toBe(0);
    // reviewCount updated from 0 to 1
    expect(state.reviewCount).toBe(1);
    expect(result.sessionsInvalidated).toBe(true);
    // Sub-step set to unresolved_summary (conservative resume point
    // for APPROVED verdict).
    expect(state.reviewSubStep).toBe("unresolved_summary");
    expect(state.lastVerdict).toBe("APPROVED");
  });

  test("preserves sessions when past stage 7 with approved verdict and pr_finalization sub-step", () => {
    // Regression: after stage 7 completes and advances to stage 8,
    // reviewSubStep remains "pr_finalization".  deriveReviewSubStep
    // returns "unresolved_summary" for an APPROVED round because
    // PR comments cannot encode post-approval progress.  This
    // mismatch must NOT trigger session invalidation — local state
    // is authoritative once stage 7 is complete.
    const state = makeRunState({
      currentStage: 8,
      reviewRound: 2,
      stageLoopCount: 1,
      reviewCount: 2,
      reviewSubStep: "pr_finalization",
      lastVerdict: "APPROVED",
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      makeComment("**[Reviewer Round 2]** Review."),
      makeComment("[Review Verdict Round 2: APPROVED]"),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(state.currentStage).toBe(8);
    expect(state.reviewSubStep).toBe("pr_finalization");
    expect(state.lastVerdict).toBe("APPROVED");
    expect(result.sessionsInvalidated).toBe(false);
    expect(state.agentA.sessionId).toBe("sess-a");
    expect(state.agentB.sessionId).toBe("sess-b");
  });

  test("invalidates sessions when verdict diverges within same round", () => {
    // Local state thinks no verdict yet, but PR shows APPROVED.
    const state = makeRunState({
      currentStage: 7,
      reviewRound: 1,
      stageLoopCount: 0,
      reviewCount: 1,
      reviewSubStep: "verdict",
      lastVerdict: undefined,
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: APPROVED]"),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(result.sessionsInvalidated).toBe(true);
    expect(state.reviewSubStep).toBe("unresolved_summary");
    expect(state.lastVerdict).toBe("APPROVED");
  });

  test("demotes currentStage when verdict exists but reviewer comment is missing", () => {
    // Regression: an orphan verdict (e.g. from a partial failure or
    // stale history) without the corresponding reviewer comment must
    // not keep currentStage past 7.
    const state = makeRunState({
      currentStage: 8,
      reviewRound: 2,
      stageLoopCount: 1,
      reviewCount: 1,
      reviewSubStep: "unresolved_summary",
      lastVerdict: "APPROVED",
    });
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix."),
      // Verdict for round 2 exists but reviewer comment does not.
      makeComment("[Review Verdict Round 2: APPROVED]"),
    ]);
    const result = reconcileWithPr(state, prState);

    expect(state.currentStage).toBe(7);
    expect(result.sessionsInvalidated).toBe(true);
    expect(state.agentA.sessionId).toBeUndefined();
    expect(state.agentB.sessionId).toBeUndefined();
    expect(
      result.warnings.some((w) => w.includes("currentStage demoted")),
    ).toBe(true);
  });
});

// ---- deriveReviewSubStep ---------------------------------------------------

describe("deriveReviewSubStep", () => {
  test("returns review when no reviewer comment for round", () => {
    const prState = parsePrReviewState([]);
    const { subStep, verdict } = deriveReviewSubStep(prState, 1);
    expect(subStep).toBe("review");
    expect(verdict).toBeUndefined();
  });

  test("returns verdict when reviewer comment exists but no verdict", () => {
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
    ]);
    const { subStep, verdict } = deriveReviewSubStep(prState, 1);
    expect(subStep).toBe("verdict");
    expect(verdict).toBeUndefined();
  });

  test("returns unresolved_summary for APPROVED verdict", () => {
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: APPROVED]"),
    ]);
    const { subStep, verdict } = deriveReviewSubStep(prState, 1);
    expect(subStep).toBe("unresolved_summary");
    expect(verdict).toBe("APPROVED");
  });

  test("returns author_fix for NOT_APPROVED without author response", () => {
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
    ]);
    const { subStep, verdict } = deriveReviewSubStep(prState, 1);
    expect(subStep).toBe("author_fix");
    expect(verdict).toBe("NOT_APPROVED");
  });

  test("returns ci_poll when author responded after NOT_APPROVED", () => {
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
      makeComment("[Review Verdict Round 1: NOT_APPROVED]"),
      makeComment("**[Author Round 1]** Fix applied."),
    ]);
    const { subStep, verdict } = deriveReviewSubStep(prState, 1);
    expect(subStep).toBe("ci_poll");
    expect(verdict).toBe("NOT_APPROVED");
  });

  test("returns review when round is ahead of PR state", () => {
    const prState = parsePrReviewState([
      makeComment("**[Reviewer Round 1]** Review."),
    ]);
    const { subStep, verdict } = deriveReviewSubStep(prState, 2);
    expect(subStep).toBe("review");
    expect(verdict).toBeUndefined();
  });
});
