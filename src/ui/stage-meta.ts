/** Stage number for the self-check stage. */
export const SELF_CHECK_STAGE = 3;
/** Stage number for the review stage. */
export const REVIEW_STAGE = 7;

/**
 * True for stages that iterate (self-check, review).  Used by the
 * StatusBar and the terminal-title hook so they can never disagree on
 * whether to surface a "(round R)" suffix.
 */
export function shouldShowRound(stageNumber: number): boolean {
  return stageNumber === SELF_CHECK_STAGE || stageNumber === REVIEW_STAGE;
}
