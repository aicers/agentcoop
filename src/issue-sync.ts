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
    ``,
    `## Response format`,
    ``,
    `End your response with one of the following:`,
    ``,
    `- If no changes were needed:`,
    `  \`ISSUE_NO_CHANGES\``,
    `- If you updated the issue (minor):`,
    `  \`ISSUE_UPDATED: <brief description of what changed>\``,
    `- If you added a comment (major):`,
    `  \`ISSUE_COMMENTED: <brief description of the discrepancy>\``,
    ``,
    `You may include both ISSUE_UPDATED and ISSUE_COMMENTED if there`,
    `were both minor and major discrepancies.`,
  ].join("\n");
}

// ---- issue sync response parser ------------------------------------------

/**
 * Parse the agent's issue sync response into a list of changes.
 *
 * Recognised line formats (case-insensitive):
 *   ISSUE_NO_CHANGES
 *   ISSUE_UPDATED: <description>
 *   ISSUE_COMMENTED: <description>
 */
export function parseIssueSyncResponse(responseText: string): IssueChange[] {
  const changes: IssueChange[] = [];

  for (const line of responseText.split("\n")) {
    const trimmed = line.trim();

    const updatedMatch = trimmed.match(/^ISSUE_UPDATED:\s*(.+)$/i);
    if (updatedMatch) {
      changes.push({ type: "minor", description: updatedMatch[1].trim() });
      continue;
    }

    const commentedMatch = trimmed.match(/^ISSUE_COMMENTED:\s*(.+)$/i);
    if (commentedMatch) {
      changes.push({ type: "major", description: commentedMatch[1].trim() });
    }
  }

  return changes;
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
