/**
 * Issue and PR description synchronisation.
 *
 * After the self-check stage completes (DONE), the agent compares the
 * actual implementation against the original issue description.  Minor
 * discrepancies (typos, added details) are auto-updated; major ones
 * (scope changes, different approach) are reported as issue comments.
 *
 * PR description updates happen before each push — the agent checks
 * whether the PR body still reflects the code changes and updates it
 * via `gh pr edit` if not.
 */

import { t } from "./i18n/index.js";
import type { StageContext } from "./pipeline.js";

// ---- public types --------------------------------------------------------

export interface IssueChange {
  type: "minor" | "major";
  description: string;
}

export interface IssueSyncParseResult {
  changes: IssueChange[];
  /** True when every non-blank line matched a recognised keyword pattern. */
  valid: boolean;
}

export type IssueSyncStatus = "completed" | "skipped" | "failed";

// ---- issue sync prompt ---------------------------------------------------

export function buildIssueSyncPrompt(
  ctx: StageContext,
  opts: { issueTitle: string; issueBody: string },
): string {
  return [
    `You have completed the self-check.  Now compare the actual`,
    `implementation against the original issue description below.`,
    ``,
    `## Issue #${ctx.issueNumber}: ${opts.issueTitle}`,
    ``,
    opts.issueBody,
    ``,
    `## Instructions`,
    ``,
    `1. Review the implementation in the worktree and compare it against`,
    `   the issue description above.`,
    `2. Determine if there are any discrepancies between what was`,
    `   implemented and what the issue describes.`,
    `3. For **minor discrepancies** (typos, corrected file paths,`,
    `   clarified wording, added details): update the issue description`,
    `   directly using:`,
    `   \`gh issue edit ${ctx.issueNumber} --repo ${ctx.owner}/${ctx.repo} --body-file <(cat <<'ISSUE_BODY'`,
    `   <new body here>`,
    `   ISSUE_BODY`,
    `   )\``,
    `4. For **major discrepancies** (scope change, different approach,`,
    `   modified requirements): leave a comment on the issue using:`,
    `   \`gh issue comment ${ctx.issueNumber} --repo ${ctx.owner}/${ctx.repo} --body "..."\``,
    `   Do NOT modify the issue description for major changes.`,
    `5. If there are no discrepancies, do nothing.`,
  ].join("\n");
}

/**
 * Verdict follow-up prompt for issue sync — asks the agent to report
 * what actions were taken, separate from the work response.
 */
export function buildIssueSyncVerdictPrompt(): string {
  return [
    `Report what issue sync actions you performed.`,
    `Respond with one or more of the following on separate lines:`,
    ``,
    `- ISSUE_NO_CHANGES — if no changes were needed`,
    `- ISSUE_UPDATED: <brief description> — if you updated the issue`,
    `- ISSUE_COMMENTED: <brief description> — if you added a comment`,
    ``,
    `Do not include any other commentary.`,
  ].join("\n");
}

// ---- issue sync response parser ------------------------------------------

/**
 * Parse the agent's issue sync response into a list of changes.
 *
 * Strict parser — every non-blank line must match one of the
 * recognised patterns (case-insensitive, optional leading bullet):
 *   ISSUE_NO_CHANGES
 *   ISSUE_UPDATED: <description>
 *   ISSUE_COMMENTED: <description>
 *
 * Returns `{ valid: false }` when the response contains
 * unrecognised lines or no recognised lines at all, so the caller
 * can trigger a clarification retry.
 */
export function parseIssueSyncResponse(
  responseText: string,
): IssueSyncParseResult {
  const changes: IssueChange[] = [];
  let hasRecognised = false;
  let hasNoChanges = false;

  for (const line of responseText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // Strip optional leading bullet marker (- or *).
    const stripped = trimmed.replace(/^[-*]\s+/, "");

    if (/^ISSUE_NO_CHANGES$/i.test(stripped)) {
      hasRecognised = true;
      hasNoChanges = true;
      continue;
    }

    const updatedMatch = stripped.match(/^ISSUE_UPDATED:\s*(.+)$/i);
    if (updatedMatch) {
      hasRecognised = true;
      changes.push({ type: "minor", description: updatedMatch[1].trim() });
      continue;
    }

    const commentedMatch = stripped.match(/^ISSUE_COMMENTED:\s*(.+)$/i);
    if (commentedMatch) {
      hasRecognised = true;
      changes.push({ type: "major", description: commentedMatch[1].trim() });
      continue;
    }

    // Unrecognised non-blank line — response is malformed.
    return { changes: [], valid: false };
  }

  // ISSUE_NO_CHANGES contradicts ISSUE_UPDATED / ISSUE_COMMENTED.
  if (hasNoChanges && changes.length > 0) {
    return { changes: [], valid: false };
  }

  // At least one keyword must have been found.
  return { changes, valid: hasRecognised };
}

/**
 * Clarification prompt for a malformed issue sync verdict response.
 */
export function buildIssueSyncClarificationPrompt(): string {
  return [
    `Your previous response did not follow the expected format.`,
    `Respond with one or more of the following on separate lines:`,
    ``,
    `- ISSUE_NO_CHANGES — if no changes were needed`,
    `- ISSUE_UPDATED: <brief description> — if you updated the issue`,
    `- ISSUE_COMMENTED: <brief description> — if you added a comment`,
    ``,
    `Do not include any other commentary.`,
  ].join("\n");
}

// ---- PR description sync prompt ------------------------------------------

/**
 * Build additional instructions for PR description synchronisation.
 *
 * Appended to prompts that precede a push so the agent checks and
 * updates the PR description if it has drifted from the code.
 */
export function buildPrSyncInstructions(issueNumber: number): string {
  return [
    `Before pushing, check whether the PR description still accurately`,
    `reflects the current code changes.  Run`,
    `\`gh pr view --json body --jq .body\` to read the current`,
    `description, then compare it against what the branch actually does.`,
    `If the description is outdated or inaccurate, update it using`,
    `\`gh pr edit --body "..."\`.  Keep the issue reference`,
    `(Closes #${issueNumber} or Part of #${issueNumber}) in the body.`,
  ].join("\n");
}

// ---- issue sync summary formatting --------------------------------------

/**
 * Format the issue sync summary lines for CLI output.
 *
 * Always returns at least the header and one detail line.  The
 * {@link status} distinguishes a successful sync (where an empty
 * {@link changes} array means "no discrepancies found") from one that
 * was skipped or that failed.
 */
export function formatIssueSyncSummary(
  issueNumber: number,
  changes: readonly IssueChange[],
  status: IssueSyncStatus = "completed",
): string[] {
  const im = t();
  const lines: string[] = [im["issueSync.summaryHeader"](issueNumber)];

  if (status === "skipped") {
    lines.push(im["issueSync.summarySkipped"]);
  } else if (status === "failed") {
    lines.push(im["issueSync.summaryFailed"]);
  } else if (changes.length === 0) {
    lines.push(im["issueSync.summaryNoChanges"]);
  } else {
    for (const change of changes) {
      if (change.type === "minor") {
        lines.push(im["issueSync.summaryMinor"](change.description));
      } else {
        lines.push(im["issueSync.summaryMajor"](change.description));
      }
    }
  }

  return lines;
}
