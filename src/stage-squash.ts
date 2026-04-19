/**
 * Stage 8 — Squash commits.
 *
 * Three-way verdict: the agent decides whether the branch is best
 * consolidated into one commit (write the suggested message into the
 * PR body and let GitHub's "Squash and merge" apply it at merge
 * time, avoiding an extra CI cycle) or several meaningful commits
 * (rewrite history and force-push as before).
 *
 *   1. Send the squash prompt instructing the agent to choose between
 *      the SUGGESTED_SINGLE and SQUASHED_MULTI paths.
 *   2. Resume the session with a verdict prompt
 *      (SQUASHED_MULTI / SUGGESTED_SINGLE / BLOCKED).
 *   3. Branch on the verdict:
 *        - SQUASHED_MULTI    → poll CI after force-push.
 *        - SUGGESTED_SINGLE  → ask the user how to apply the
 *                              suggestion (agent squash now, or
 *                              GitHub "Squash and merge" later).
 *        - BLOCKED           → existing blocked flow.
 *
 * `requiresArtifact` is true because the squash decision must succeed
 * before the pipeline proceeds to Done.
 */

import type { AgentAdapter } from "./agent.js";
import type { CiRun, GetCiStatusFn } from "./ci.js";
import {
  collectFailureLogs as defaultCollectFailureLogs,
  getCiStatus as defaultGetCiStatus,
} from "./ci.js";
import { type CiPollResult, pollCiAndFix } from "./ci-poll.js";
import { t } from "./i18n/index.js";
import { buildPrSyncInstructions } from "./issue-sync.js";
import type { StageContext, StageDefinition, StageResult } from "./pipeline.js";
import {
  getPrBody as defaultGetPrBody,
  queryPrState as defaultQueryPrState,
  type PrLifecycleState,
} from "./pr.js";
import type { SquashSubStep } from "./run-state.js";
import {
  invokeOrResume,
  mapAgentError,
  sendFollowUp,
  type VerdictContext,
} from "./stage-util.js";
import {
  buildClarificationPrompt,
  parseVerdictKeyword,
} from "./step-parser.js";
import { countBranchCommits as defaultCountBranchCommits } from "./worktree.js";

// ---- public types ------------------------------------------------------------

/** Marker block delimiters used in the PR body for the SUGGESTED_SINGLE path. */
export const SQUASH_SUGGESTION_START_MARKER =
  "<!-- agentcoop:squash-suggestion:start -->";
export const SQUASH_SUGGESTION_END_MARKER =
  "<!-- agentcoop:squash-suggestion:end -->";

export interface SquashSuggestion {
  title: string;
  body: string;
}

export interface SquashStageOptions {
  agent: AgentAdapter;
  issueTitle: string;
  issueBody: string;
  /** The default branch name (e.g. "main"). Used to count commits. */
  defaultBranch: string;
  /** Injected for testability. */
  getCiStatus?: GetCiStatusFn;
  /** Injected for testability. */
  collectFailureLogs?: (owner: string, repo: string, run: CiRun) => string;
  /** Injected for testability. Defaults to `worktree.getHeadSha`. */
  getHeadSha?: (cwd: string) => string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Grace period for empty SHA-filtered runs. Default 60 000. */
  emptyRunsGracePeriodMs?: number;
  /** Max CI fix attempts. Default 3. */
  maxFixAttempts?: number;
  /** Injected for testability. */
  delay?: (ms: number) => Promise<void>;
  /** Injected for testability. Defaults to `worktree.countBranchCommits`. */
  countBranchCommits?: (cwd: string, baseBranch: string) => number;
  /** Injected for testability. Defaults to `pr.getPrBody`. */
  getPrBody?: (
    owner: string,
    repo: string,
    branch: string,
  ) => string | undefined;
  /**
   * Query the PR's lifecycle state (OPEN / CLOSED / MERGED).  Used by
   * {@link guardIfPrMerged} to short-circuit Stage 8 when the user
   * merged the PR on GitHub while the pipeline was waiting on the
   * SUGGESTED_SINGLE choice.  Defaults to `pr.queryPrState`.
   */
  queryPrState?: (
    owner: string,
    repo: string,
    branch: string,
  ) => PrLifecycleState;
  /**
   * Ask the user how to apply a single-commit squash suggestion.
   * Required for the SUGGESTED_SINGLE path; if absent the stage
   * conservatively defaults to "agent".
   */
  chooseSquashApplyMode?: (message: string) => Promise<"agent" | "github">;
  /**
   * Persist the current squash sub-step so resume can re-enter at
   * the correct point.  Optional — when omitted, sub-step transitions
   * are not persisted (used by tests).
   */
  onSquashSubStep?: (subStep: SquashSubStep | undefined) => void;
  /**
   * Restored sub-step from a prior run.  When set, the handler skips
   * earlier sub-steps and re-enters at the saved point.
   *
   * May be a value (snapshot at resume time) or a getter (reads live
   * persisted state on each retry).  The getter form is required for
   * in-process retries after the handler has already transitioned the
   * sub-step — e.g. `ci_poll` failing and triggering a fresh handler
   * invocation.  Without the live read, the retry would see the
   * startup snapshot (`undefined`) and fall into the single-commit
   * skip path instead of resuming CI polling.
   */
  savedSquashSubStep?: SquashSubStep | (() => SquashSubStep | undefined);
  /**
   * Getter for the persisted agent-A session id.  Read on each handler
   * invocation so that in-process retries see the session the stage
   * persisted during a previous iteration.  The pipeline-supplied
   * `ctx.savedAgentASessionId` is one-shot — cleared after the first
   * iteration — so it cannot be relied on for retries alone.
   */
  getSavedAgentSessionId?: () => string | undefined;
}

// ---- prompt builders ---------------------------------------------------------

export function buildSquashPrompt(
  ctx: StageContext,
  opts: SquashStageOptions,
): string {
  const lines = [
    `You are squashing commits for the following GitHub issue.`,
    ``,
    `## Repository`,
    `- Owner: ${ctx.owner}`,
    `- Repo: ${ctx.repo}`,
    `- Branch: ${ctx.branch}`,
    `- Worktree: ${ctx.worktreePath}`,
    ``,
    `## Issue #${ctx.issueNumber}: ${opts.issueTitle}`,
    ``,
    opts.issueBody,
    ``,
    `## Instructions`,
    ``,
    `1. ${buildPrSyncInstructions(ctx.issueNumber)}`,
    `2. Decide whether the work on this branch is best presented as`,
    `   **one** commit or as **several** meaningful commits.  Inspect the`,
    `   existing commits' scope, file overlap, and intent.`,
    ``,
    `   - **One commit is appropriate** when all changes belong to a`,
    `     single logical change (typical small fix or feature).`,
    `   - **Multiple commits are appropriate** when the branch contains`,
    `     genuinely independent changes that benefit from separate`,
    `     history (e.g. a refactor preceding a feature).`,
    ``,
    `3. Branch on your decision:`,
    ``,
    `   **If a single commit is appropriate:**`,
    `   - Do NOT rewrite history.  Do NOT force-push.`,
    `   - Draft the commit title and body that should be used when the`,
    `     PR is squash-merged.  The title must not include issue or PR`,
    `     numbers; reference the issue in the body using \`Closes #N\``,
    `     or \`Part of #N\`.`,
    `   - Update the PR body to include a marker-delimited block`,
    `     containing the suggestion.  The block must be idempotent —`,
    `     replace any existing block between the same markers, do not`,
    `     stack duplicates.  Inside the block, wrap the title and body`,
    `     each in their own fenced code block (info string \`text\`) so`,
    `     GitHub renders a one-click copy icon and does not`,
    `     re-interpret Markdown characters inside the commit message.`,
    `     Use exactly these markers and this structure:`,
    ``,
    `     \`\`\`\`text`,
    `     ${SQUASH_SUGGESTION_START_MARKER}`,
    `     ## Suggested squash commit`,
    ``,
    `     **Title**`,
    ``,
    `     \`\`\`text`,
    `     <your title>`,
    `     \`\`\``,
    ``,
    `     **Body**`,
    ``,
    `     \`\`\`text`,
    `     <your body — may include \`Closes #N\` / \`Part of #N\`>`,
    `     \`\`\``,
    `     ${SQUASH_SUGGESTION_END_MARKER}`,
    `     \`\`\`\``,
    ``,
    `     **Choose each fence length dynamically.**  Per CommonMark, a`,
    `     fenced code block closes only on a line containing a run of`,
    `     the same character that is **as long or longer** than the`,
    `     opening fence.  Commit bodies may legitimately contain code`,
    `     samples with their own triple-backtick fences, so a fixed`,
    `     three-backtick outer fence would close early at the first`,
    `     \`\`\`\` line inside the content.  Compute:`,
    ``,
    `       fence_len = max(longest run of backticks in the content, 2) + 1`,
    ``,
    `     (minimum 3).  Calculate the title fence length from the`,
    `     title string and the body fence length from the body string,`,
    `     independently.  Use the same character (backtick) for both`,
    `     the opening and closing line of a given block.`,
    ``,
    `     Worked example — if the body contains a line of triple`,
    `     backticks anywhere (e.g. a README excerpt), open and close`,
    `     the body with **four** backticks; a run of five backticks in`,
    `     the content requires six on the fence; and so on.  The title`,
    `     fence typically stays at three.`,
    ``,
    `     Do not add a blank line between the opening fence and the`,
    `     first line of content, or between the last line of content`,
    `     and the closing fence.  Do not indent the fences.`,
    ``,
    `     Read the current body with`,
    `     \`gh pr view --json body --jq .body\`, replace any prior`,
    `     suggestion block, and write the result back via`,
    `     \`gh pr edit --body "..."\`.`,
    ``,
    `   **If multiple commits are appropriate:**`,
    ...(ctx.baseSha
      ? [
          `   - Review the commits after the base commit \`${ctx.baseSha}\``,
          `     and consolidate them into a few meaningful commits.  Only`,
          `     commits introduced on this branch should be touched — do not`,
          `     include commits from the base branch.  Use`,
          `     \`git reset --soft ${ctx.baseSha}\` followed by \`git commit\`,`,
          `     or an interactive rebase — whichever is simpler.`,
        ]
      : [
          `   - Review all commits on this branch and consolidate them into`,
          `     a few meaningful commits.  Use an interactive rebase or`,
          `     reset-based approach — whichever is simpler.`,
        ]),
    `   - Write clear, concise commit messages that summarise the changes.`,
    `     Do not include issue or PR numbers in the commit title.`,
    `     Instead, reference the issue in the commit body using`,
    `     \`Closes #N\` or \`Part of #N\`.`,
    `   - Force-push the branch (\`git push --force-with-lease\`).`,
  ];

  if (ctx.userInstruction) {
    lines.push(``, `## Additional feedback`, ``, ctx.userInstruction);
  }

  return lines.join("\n");
}

/**
 * Three-way verdict keywords for the squash stage.  Kept out of the
 * shared `KEYWORD_MAP` / `StepStatus` enum because they are
 * squash-specific; the handler branches on the raw keyword from
 * `parseVerdictKeyword` instead.
 */
export const SQUASH_CHECK_KEYWORDS = [
  "SQUASHED_MULTI",
  "SUGGESTED_SINGLE",
  "BLOCKED",
] as const;

export type SquashVerdict = (typeof SQUASH_CHECK_KEYWORDS)[number];

export function buildSquashCompletionCheckPrompt(): string {
  return [
    `You have finished your squash decision.  Respond with exactly one`,
    `of the following keywords:`,
    ``,
    `- SQUASHED_MULTI — if you rewrote history into multiple meaningful`,
    `  commits and force-pushed`,
    `- SUGGESTED_SINGLE — if a single commit is appropriate and you`,
    `  wrote the suggested title/body into the PR body marker block`,
    `  (no force-push)`,
    `- BLOCKED — if you could not complete either path and need user`,
    `  intervention`,
    ``,
    `Do not include any other commentary — just the keyword.`,
  ].join("\n");
}

/**
 * Follow-up prompt sent on the same session when the user picks
 * "agent squashes now" after a SUGGESTED_SINGLE verdict.  The agent
 * already drafted the message in the PR body, so this just asks it
 * to perform the squash with the same message.
 */
export function buildAgentSquashFollowupPrompt(): string {
  return [
    `The user chose to have you perform the squash now using the title`,
    `and body you wrote into the PR body marker block.`,
    ``,
    `Squash the branch into a single commit using that exact title and`,
    `body, then force-push (\`git push --force-with-lease\`).  You may`,
    `leave the marker block in the PR body — it does not interfere with`,
    `merging.`,
  ].join("\n");
}

// ---- marker block parsing ----------------------------------------------------

/**
 * Extract the title and body from the squash suggestion marker block
 * in `prBody`.  Returns `undefined` when the markers are missing or
 * the block does not contain a parseable title.
 *
 * Accepts two formats:
 *
 * 1. **Fenced** (current, written by the agent) — `**Title**` and
 *    `**Body**` labels each followed by a CommonMark-style fenced code
 *    block.  The fence length is chosen dynamically by the agent so
 *    the block can survive commit bodies that themselves contain
 *    triple-backtick samples; the parser mirrors that rule by
 *    matching any opening fence of three or more backticks and
 *    scanning for a closing line with a run of the same character
 *    that is at least as long.
 * 2. **Legacy** (deprecated) — `**Title:** <title>` / `**Body:**`
 *    plain-text format.  Kept for one release cycle so that PRs
 *    written by older versions still render in the stage 9 inline
 *    preview after upgrade.  Remove once the deprecation window
 *    expires.
 */
export function parseSquashSuggestionBlock(
  prBody: string | undefined,
): SquashSuggestion | undefined {
  if (!prBody) return undefined;
  const startIdx = prBody.indexOf(SQUASH_SUGGESTION_START_MARKER);
  const endIdx = prBody.indexOf(SQUASH_SUGGESTION_END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return undefined;

  const inner = prBody.slice(
    startIdx + SQUASH_SUGGESTION_START_MARKER.length,
    endIdx,
  );

  // Decide format by whichever top-level title label appears *first*
  // in the block, not merely by whether a fenced-intent shape exists
  // anywhere.  A legacy body may legitimately contain a standalone
  // `**Title**` line followed by a fenced code sample as part of its
  // own prose, so scanning the whole block for a fenced shape would
  // misroute valid legacy blocks.  The first recognized top-level
  // label wins: `**Title:** <content>` → legacy, `**Title**` + fence
  // → fenced.  Once classified as fenced, a malformed fenced block
  // must fail to `undefined` rather than silently fall through to
  // legacy parsing (which would otherwise pick up `**Title:**` /
  // `**Body:**` strings that appeared as prose inside an unterminated
  // fence).
  const format = detectFormat(inner);
  if (format === "fenced") return parseFencedSuggestion(inner);
  if (format === "legacy") return parseLegacySuggestion(inner);
  return undefined;
}

/**
 * Classify the block by the first top-level title label it contains.
 * Returns `"legacy"` if a `**Title:** <content>` line appears before
 * any fenced-intent shape, `"fenced"` if a `**Title**` label line
 * followed (after optional blank lines) by an opening code fence
 * appears first, or `undefined` when neither shape is present.
 */
function detectFormat(inner: string): "fenced" | "legacy" | undefined {
  const lines = inner.split("\n");
  const legacyTitleRe = /^\s*\*\*Title:\*\*\s+\S/;
  const fencedTitleRe = labelLineRe("Title");
  const openFenceRe = /^\s*`{3,}[^`]*$/;
  for (let i = 0; i < lines.length; i++) {
    if (legacyTitleRe.test(lines[i])) return "legacy";
    if (fencedTitleRe.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && openFenceRe.test(lines[j])) return "fenced";
    }
  }
  return undefined;
}

/** Label-line regex for the fenced format (`**Title**` / `**Body**`). */
function labelLineRe(label: "Title" | "Body"): RegExp {
  return new RegExp(`^\\s*\\*\\*${label}\\*\\*\\s*$`);
}

/**
 * Parse the fenced format.  Returns `undefined` when either label is
 * missing, when the fenced block that should follow the label is
 * malformed (missing opening fence, unterminated), or when the
 * blocks appear in the wrong order.
 */
function parseFencedSuggestion(inner: string): SquashSuggestion | undefined {
  const lines = inner.split("\n");

  const titleLabelIdx = findLabelLine(lines, 0, "Title");
  if (titleLabelIdx === -1) return undefined;

  const titleBlock = readFencedBlock(lines, titleLabelIdx + 1);
  if (!titleBlock) return undefined;

  const bodyLabelIdx = findLabelLine(lines, titleBlock.endIdx + 1, "Body");
  if (bodyLabelIdx === -1) return undefined;

  const bodyBlock = readFencedBlock(lines, bodyLabelIdx + 1);
  if (!bodyBlock) return undefined;

  return {
    title: titleBlock.content.replace(/^\n+|\n+$/g, "").trim(),
    body: bodyBlock.content.replace(/^\n+|\n+$/g, ""),
  };
}

function findLabelLine(
  lines: string[],
  start: number,
  label: "Title" | "Body",
): number {
  const re = labelLineRe(label);
  for (let i = start; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

/**
 * Read a CommonMark-style fenced code block starting at or after
 * `start`.  Skips blank lines before the opening fence, records the
 * fence length, then scans for the first line that is a closing
 * fence — a run of backticks of length `>=` the opening, optionally
 * with surrounding whitespace, and no info string.
 *
 * Returns `{ content, endIdx }` where `endIdx` is the line index of
 * the closing fence.  Returns `undefined` when no opening fence is
 * found or the block is not terminated.
 */
function readFencedBlock(
  lines: string[],
  start: number,
): { content: string; endIdx: number } | undefined {
  let i = start;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return undefined;

  // Opening fence: 3+ backticks, optional info string (no backticks).
  const openMatch = lines[i].match(/^\s*(`{3,})([^`]*)$/);
  if (!openMatch) return undefined;
  const fenceLen = openMatch[1].length;

  const contentStart = i + 1;
  for (let j = contentStart; j < lines.length; j++) {
    // Closing fence: run of backticks of length >= opening, nothing
    // else on the line besides whitespace.
    const closeMatch = lines[j].match(/^\s*(`{3,})\s*$/);
    if (closeMatch && closeMatch[1].length >= fenceLen) {
      return {
        content: lines.slice(contentStart, j).join("\n"),
        endIdx: j,
      };
    }
  }
  return undefined;
}

/**
 * Parse the deprecated legacy format (`**Title:** <title>` /
 * `**Body:**` plain text).  Maintained for one release cycle after
 * the switch to fenced blocks so PRs written by older agent runs
 * still render correctly in the stage 9 inline preview.
 *
 * Both labels must appear on their own top-level lines in order —
 * `**Title:** <content>` with content on the same line, then a
 * later line that is exactly `**Body:**`.  A whole-block
 * `match()` / `indexOf()` approach would happily pick up stray
 * `**Title:**` / `**Body:**` strings that appeared mid-prose and
 * accept malformed blocks (e.g. missing the body label), weakening
 * the Stage 8 strict gate in `hasValidSuggestionBlock`.
 */
function parseLegacySuggestion(inner: string): SquashSuggestion | undefined {
  const lines = inner.split("\n");
  const titleLineRe = /^\s*\*\*Title:\*\*\s+(.+?)\s*$/;
  const bodyLabelRe = /^\s*\*\*Body:\*\*\s*$/;

  let titleIdx = -1;
  let title = "";
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(titleLineRe);
    if (m) {
      titleIdx = i;
      title = m[1].trim();
      break;
    }
  }
  if (titleIdx === -1) return undefined;

  let bodyIdx = -1;
  for (let i = titleIdx + 1; i < lines.length; i++) {
    if (bodyLabelRe.test(lines[i])) {
      bodyIdx = i;
      break;
    }
  }
  if (bodyIdx === -1) return undefined;

  const body = lines
    .slice(bodyIdx + 1)
    .join("\n")
    .trim();

  return { title, body };
}

/**
 * True when `prBody` contains a fully parseable squash suggestion
 * block (start + end markers AND a `**Title:**` line that
 * `parseSquashSuggestionBlock` can extract).
 *
 * Stage 8 must use this strict check rather than a marker-presence
 * check because Stage 9 reads the same block via
 * `parseSquashSuggestionBlock` to render the inline preview.  If
 * Stage 8 accepted a malformed block (e.g. only the start marker, or
 * a block missing `**Title:**`/the end marker), the SUGGESTED_SINGLE
 * path could complete with `applied_in_pr_body` while leaving Stage 9
 * with nothing to show.
 */
function hasValidSuggestionBlock(prBody: string | undefined): boolean {
  return parseSquashSuggestionBlock(prBody) !== undefined;
}

// ---- handler -----------------------------------------------------------------

interface VerdictHandle {
  verdict: SquashVerdict | undefined;
  responseText: string;
  sessionId: string | undefined;
}

/**
 * Run the verdict prompt + one clarification retry.  Returns the
 * resolved verdict (or `undefined` when both attempts were ambiguous)
 * along with the latest response text and session id.
 */
async function resolveVerdict(
  agent: AgentAdapter,
  squashSessionId: string | undefined,
  ctx: StageContext,
  verdictCtx: VerdictContext | undefined,
  worktreePath: string,
): Promise<VerdictHandle | StageResult> {
  const checkPrompt = buildSquashCompletionCheckPrompt();
  ctx.promptSinks?.a?.(checkPrompt, "verdict-followup", { resume: true });
  let checkResult = await sendFollowUp(
    agent,
    squashSessionId,
    checkPrompt,
    worktreePath,
    ctx.streamSinks?.a,
    undefined,
    ctx.usageSinks?.a,
  );

  if (checkResult.status === "error") {
    return mapAgentError(checkResult, "during squash completion check");
  }

  let verdict = parseVerdictKeyword(
    checkResult.responseText,
    SQUASH_CHECK_KEYWORDS,
  ).keyword as SquashVerdict | undefined;

  if (verdict !== undefined) {
    verdictCtx?.events.emit("pipeline:verdict", {
      agent: verdictCtx.agent,
      keyword: verdict,
      raw: checkResult.responseText,
    });
    return {
      verdict,
      responseText: checkResult.responseText,
      sessionId: checkResult.sessionId ?? squashSessionId,
    };
  }

  // Single clarification retry.
  const clarifyPrompt = buildClarificationPrompt(
    checkResult.responseText,
    SQUASH_CHECK_KEYWORDS,
  );
  ctx.promptSinks?.a?.(clarifyPrompt, "verdict-followup", { resume: true });
  const retryResult = await sendFollowUp(
    agent,
    checkResult.sessionId ?? squashSessionId,
    clarifyPrompt,
    worktreePath,
    ctx.streamSinks?.a,
    undefined,
    ctx.usageSinks?.a,
  );

  if (retryResult.status === "error") {
    return mapAgentError(retryResult, "during squash completion clarification");
  }

  checkResult = retryResult;
  verdict = parseVerdictKeyword(checkResult.responseText, SQUASH_CHECK_KEYWORDS)
    .keyword as SquashVerdict | undefined;

  if (verdict !== undefined) {
    verdictCtx?.events.emit("pipeline:verdict", {
      agent: verdictCtx.agent,
      keyword: verdict,
      raw: checkResult.responseText,
    });
  }

  return {
    verdict,
    responseText: checkResult.responseText,
    sessionId: checkResult.sessionId ?? squashSessionId,
  };
}

/**
 * Short-circuit Stage 8 when the PR has already been merged on
 * GitHub.  Returns a completed {@link StageResult} (and clears the
 * squash sub-step so a resume does not re-enter the dead choice),
 * or `undefined` when the caller should proceed.
 *
 * Unlike Stage 9, Stage 8 does not own the worktree lifecycle, so
 * cleanup stays in the Done stage — this guard only aborts the
 * squash decision / follow-up and lets Stage 9 handle cleanup.
 */
function guardIfPrMerged(
  ctx: StageContext,
  opts: SquashStageOptions,
): StageResult | undefined {
  const query = opts.queryPrState ?? defaultQueryPrState;
  const state = query(ctx.owner, ctx.repo, ctx.branch);
  if (state !== "MERGED") return undefined;
  opts.onSquashSubStep?.(undefined);
  return {
    outcome: "completed",
    message: t()["squash.alreadyMerged"],
  };
}

export function createSquashStageHandler(
  opts: SquashStageOptions,
): StageDefinition {
  return {
    name: t()["stage.squash"],
    number: 8,
    primaryAgent: "a",
    requiresArtifact: true,
    handler: async (ctx: StageContext): Promise<StageResult> => {
      const countCommits = opts.countBranchCommits ?? defaultCountBranchCommits;
      const getPrBody = opts.getPrBody ?? defaultGetPrBody;

      // Read the persisted agent-A session id (live) with a fallback
      // to the one-shot pipeline value, so in-process retries can
      // resume the same conversation.
      const resolveSavedSessionId = (): string | undefined =>
        opts.getSavedAgentSessionId?.() ?? ctx.savedAgentASessionId;

      // ---- resume routing -------------------------------------------------
      //
      // Handle known post-planning substates FIRST so that the
      // single-commit skip check below cannot mask a completed squash
      // (where the branch now has only one commit because the agent
      // already force-pushed).
      //
      // Resolve the saved sub-step through the getter (if supplied)
      // so in-process retries see the live persisted value instead of
      // a startup snapshot.
      const saved =
        typeof opts.savedSquashSubStep === "function"
          ? opts.savedSquashSubStep()
          : opts.savedSquashSubStep;

      if (saved === "applied_in_pr_body") {
        // Stage already finished via the SUGGESTED_SINGLE / github path.
        return {
          outcome: "completed",
          message: t()["squash.messageAppended"],
        };
      }

      if (saved === "ci_poll") {
        return runCiPollAndFinish(ctx, opts);
      }

      if (saved === "squashing") {
        // The user picked "agent squashes now" and the follow-up
        // prompt was sent, but we were interrupted before
        // transitioning to `ci_poll`.  Falling through to a fresh
        // planning run would re-send the entire decision prompt and
        // potentially trigger another force-push / CI cycle — the
        // exact waste this feature is meant to avoid.
        //
        // Re-check the PR lifecycle before deciding between
        // "resume follow-up" and "go poll CI": if the user merged
        // the PR on GitHub between the interruption and the resume,
        // both paths would waste work on a closed branch.
        const merged = guardIfPrMerged(ctx, opts);
        if (merged) return merged;

        // Detect a completed squash deterministically (commit count
        // collapsed to 1) and jump to CI polling.  Otherwise, reuse
        // the saved session to re-send just the follow-up squash
        // prompt so the agent continues the same conversation.
        const resumeCount = countCommits(ctx.worktreePath, opts.defaultBranch);
        if (resumeCount <= 1) {
          return runCiPollAndFinish(ctx, opts);
        }

        const sessionId = resolveSavedSessionId();
        if (sessionId !== undefined) {
          const followupPrompt = buildAgentSquashFollowupPrompt();
          ctx.promptSinks?.a?.(followupPrompt, "work", { resume: true });
          const followup = await sendFollowUp(
            opts.agent,
            sessionId,
            followupPrompt,
            ctx.worktreePath,
            ctx.streamSinks?.a,
            undefined,
            ctx.usageSinks?.a,
          );

          if (followup.sessionId) {
            ctx.onSessionId?.("a", followup.sessionId);
          }

          if (followup.status === "error") {
            return mapAgentError(
              followup,
              "during resumed agent squash follow-up",
            );
          }

          return runCiPollAndFinish(ctx, opts);
        }
        // No session available — fall through to a fresh planning run
        // as a last resort.  This should be rare: the session id is
        // persisted alongside `squashSubStep`.
      }

      if (saved === "awaiting_user_choice") {
        const prBody = getPrBody(ctx.owner, ctx.repo, ctx.branch);
        if (hasValidSuggestionBlock(prBody)) {
          const merged = guardIfPrMerged(ctx, opts);
          if (merged) return merged;
          return askUserAndApply(ctx, opts, undefined);
        }
        // Suggestion block missing or malformed — fall back to a
        // fresh planning run rather than re-presenting a choice that
        // the user could not act on.
      }

      // Skip squash when the branch has only one commit.
      const initialCount = countCommits(ctx.worktreePath, opts.defaultBranch);
      if (initialCount <= 1) {
        opts.onSquashSubStep?.(undefined);
        return {
          outcome: "completed",
          message: t()["squash.singleCommitSkip"],
        };
      }

      // ---- planning: send the squash work prompt --------------------------
      opts.onSquashSubStep?.("planning");

      const prompt = buildSquashPrompt(ctx, opts);
      ctx.promptSinks?.a?.(prompt, "work");
      const squashResult = await invokeOrResume(
        opts.agent,
        resolveSavedSessionId(),
        prompt,
        ctx.worktreePath,
        ctx.streamSinks?.a,
        undefined,
        ctx.usageSinks?.a,
      );

      if (squashResult.sessionId) {
        ctx.onSessionId?.("a", squashResult.sessionId);
      }

      if (squashResult.status === "error") {
        return mapAgentError(squashResult, "during squash");
      }

      // ---- verdict --------------------------------------------------------
      const verdictCtx: VerdictContext | undefined = ctx.events
        ? { events: ctx.events, agent: "a" }
        : undefined;

      const handle = await resolveVerdict(
        opts.agent,
        squashResult.sessionId,
        ctx,
        verdictCtx,
        ctx.worktreePath,
      );

      if ("outcome" in handle) {
        // Agent error inside resolveVerdict — already a StageResult.
        return handle;
      }

      let verdict: SquashVerdict | undefined = handle.verdict;
      const verdictResponseText = handle.responseText;
      const verdictSessionId = handle.sessionId;

      // Persist the latest session id from the verdict turn before
      // potentially entering `awaiting_user_choice`.  Adapters may
      // surface a new session id on follow-up turns (see
      // `src/claude-adapter.ts`), so the verdict session can differ
      // from the planning session that was persisted earlier at
      // `squashResult.sessionId`.  Without this, a resume from
      // `awaiting_user_choice` that routes the user's "agent" choice
      // back to the older planning session would not continue the
      // exact conversation that drafted the PR-body suggestion.
      if (verdictSessionId) {
        ctx.onSessionId?.("a", verdictSessionId);
      }

      // ---- post-clarification deterministic fallback chain -----------------
      // Order matters: a completed force-push is the hard-to-undo side
      // effect, so detect it first.  Only then check the suggestion
      // block, because an earlier run may have left a stale block in
      // the PR body that would otherwise be misclassified.  The block
      // must be fully parseable (markers + `**Title:**`) — a malformed
      // block is treated as missing because Stage 9 cannot render a
      // preview from it.
      if (verdict === undefined) {
        const postCount = countCommits(ctx.worktreePath, opts.defaultBranch);
        if (postCount < initialCount) {
          verdict = "SQUASHED_MULTI";
        } else {
          const prBody = getPrBody(ctx.owner, ctx.repo, ctx.branch);
          if (hasValidSuggestionBlock(prBody)) {
            verdict = "SUGGESTED_SINGLE";
          } else {
            verdict = "BLOCKED";
          }
        }
        // The verdict was derived deterministically rather than parsed
        // from the agent response, but telemetry consumers still need
        // the `pipeline:verdict` event so the stage outcome is
        // attributable.  The raw text is the last clarification
        // response — the best signal we have for "what the agent said
        // before we overrode it".
        verdictCtx?.events.emit("pipeline:verdict", {
          agent: verdictCtx.agent,
          keyword: verdict,
          raw: verdictResponseText,
        });
      }

      // Branch on the resolved verdict.
      if (verdict === "BLOCKED") {
        opts.onSquashSubStep?.(undefined);
        return {
          outcome: "blocked",
          message: `${squashResult.responseText}\n\n---\n\n${verdictResponseText}`,
        };
      }

      if (verdict === "SUGGESTED_SINGLE") {
        // Verify the PR body holds a fully parseable suggestion block
        // before asking the user.  A bare start marker or a block
        // missing `**Title:**`/the end marker would let the stage
        // complete with `applied_in_pr_body` but leave Stage 9 unable
        // to render the inline preview, so fail closed instead.
        const prBody = getPrBody(ctx.owner, ctx.repo, ctx.branch);
        if (!hasValidSuggestionBlock(prBody)) {
          opts.onSquashSubStep?.(undefined);
          return {
            outcome: "blocked",
            message: `${squashResult.responseText}\n\n---\n\n${verdictResponseText}`,
          };
        }
        const merged = guardIfPrMerged(ctx, opts);
        if (merged) return merged;
        return askUserAndApply(ctx, opts, verdictSessionId);
      }

      // SQUASHED_MULTI — proceed with the existing CI poll path.
      return runCiPollAndFinish(ctx, opts);
    },
  };
}

/**
 * Present the user with the SUGGESTED_SINGLE choice and dispatch.
 * `verdictSessionId` is the session that just produced the verdict;
 * it is needed when the user picks "agent" so the follow-up prompt
 * is sent on the same conversation.
 */
async function askUserAndApply(
  ctx: StageContext,
  opts: SquashStageOptions,
  verdictSessionId: string | undefined,
): Promise<StageResult> {
  opts.onSquashSubStep?.("awaiting_user_choice");

  const choice = opts.chooseSquashApplyMode
    ? await opts.chooseSquashApplyMode(t()["squash.singleChoicePrompt"])
    : "agent";

  if (choice === "github") {
    opts.onSquashSubStep?.("applied_in_pr_body");
    return {
      outcome: "completed",
      message: t()["squash.messageAppended"],
    };
  }

  // User picked "agent" — guard the narrow race where the PR was
  // merged on GitHub after the first query but before the user
  // clicked "Agent squashes now".  The destructive follow-up
  // (force-push on a closed branch) would waste CI cycles and
  // potentially resurrect a deleted branch.
  const merged = guardIfPrMerged(ctx, opts);
  if (merged) return merged;

  // User picked "agent" — send the follow-up squash prompt and run CI.
  opts.onSquashSubStep?.("squashing");

  const sessionId =
    verdictSessionId ??
    opts.getSavedAgentSessionId?.() ??
    ctx.savedAgentASessionId;
  if (sessionId === undefined) {
    // Without a session we cannot ask the agent to continue.  The
    // user explicitly chose "agent", so silently completing as if
    // they had picked "github" would misrepresent what happened.
    // Fail closed and let the user retry or switch paths.  This
    // should be rare: both invoke and verdict normally produce
    // session IDs that get persisted alongside `squashSubStep`.
    opts.onSquashSubStep?.(undefined);
    return {
      outcome: "blocked",
      message: t()["squash.agentChoiceMissingSession"],
    };
  }

  const followupPrompt = buildAgentSquashFollowupPrompt();
  ctx.promptSinks?.a?.(followupPrompt, "work", { resume: true });
  const followup = await sendFollowUp(
    opts.agent,
    sessionId,
    followupPrompt,
    ctx.worktreePath,
    ctx.streamSinks?.a,
    undefined,
    ctx.usageSinks?.a,
  );

  if (followup.sessionId) {
    ctx.onSessionId?.("a", followup.sessionId);
  }

  if (followup.status === "error") {
    return mapAgentError(followup, "during agent squash follow-up");
  }

  return runCiPollAndFinish(ctx, opts);
}

/**
 * Poll CI after a force-push and return the final stage result.
 */
async function runCiPollAndFinish(
  ctx: StageContext,
  opts: SquashStageOptions,
): Promise<StageResult> {
  opts.onSquashSubStep?.("ci_poll");

  const ciResult: CiPollResult = await pollCiAndFix({
    ctx,
    agent: opts.agent,
    issueTitle: opts.issueTitle,
    issueBody: opts.issueBody,
    getCiStatus: opts.getCiStatus ?? defaultGetCiStatus,
    collectFailureLogs: opts.collectFailureLogs ?? defaultCollectFailureLogs,
    getHeadSha: opts.getHeadSha,
    emptyRunsGracePeriodMs: opts.emptyRunsGracePeriodMs,
    pollIntervalMs: opts.pollIntervalMs,
    pollTimeoutMs: opts.pollTimeoutMs,
    maxFixAttempts: opts.maxFixAttempts,
    delay: opts.delay,
  });

  if (!ciResult.passed) {
    return { outcome: "error", message: ciResult.message };
  }

  opts.onSquashSubStep?.(undefined);
  return {
    outcome: "completed",
    message: t()["squash.completed"],
  };
}
