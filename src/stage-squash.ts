/**
 * Stage 8 — Squash commits.
 *
 * Three-way verdict: the agent decides whether the branch is best
 * consolidated into one commit (post the suggested message as a PR
 * comment and let GitHub's "Squash and merge" apply it at merge
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
  findPrNumber as defaultFindPrNumber,
  queryPrState as defaultQueryPrState,
  type PrLifecycleState,
} from "./pr.js";
import {
  findLatestCommentWithMarker as defaultFindLatestCommentWithMarker,
  patchPrComment as defaultPatchPrComment,
  postPrComment as defaultPostPrComment,
} from "./pr-comments.js";
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

/**
 * Marker block delimiters used inside the squash-suggestion PR
 * comment.  The start marker also doubles as the lookup key for
 * finding the previous comment to update idempotently.
 */
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
  /**
   * Look up the squash-suggestion PR comment body containing `marker`.
   * Injected for testability.  Returns just the body — the read-side
   * never needs the comment id, so this stays string-returning even
   * after the underlying `findLatestCommentWithMarker` was widened to
   * `{ id, body }`.  The default adapts the widened helper.
   */
  findSuggestionCommentBody?: (
    owner: string,
    repo: string,
    prNumber: number,
    marker: string,
  ) => string | undefined;
  /**
   * Post or update the squash-suggestion PR comment idempotently.
   * Single entry point for the write side: the implementation looks
   * up any existing comment with the start marker and either PATCHes
   * it or POSTs a new one.  Injected for testability — the default
   * shells out to `gh` via {@link postOrUpdateSquashSuggestion}.
   */
  postSuggestionComment?: (
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ) => void;
  /**
   * Resolve the PR number for the current branch.  Injected for
   * testability.  Defaults to `pr.findPrNumber`.
   */
  findPrNumber?: (
    owner: string,
    repo: string,
    branch: string,
  ) => number | undefined;
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
   * Per-run policy for how a SUGGESTED_SINGLE verdict should be
   * applied.  When `"auto"` the handler skips
   * {@link chooseSquashApplyMode} and proceeds as if the user picked
   * `"agent"`; when `"ask"` the user is prompted every time.
   * Collected by the startup flow (see `src/startup.ts`) and
   * threaded in via the pipeline boot code.  Defaults to `"ask"` so
   * missing wiring falls back to today's behaviour.
   */
  squashApplyPolicy?: "auto" | "ask";
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
    `   - Do NOT post or edit any PR comment yourself — agentcoop will`,
    `     author the squash-suggestion comment from your reply below.`,
    `   - Draft the commit title and body that should be used when the`,
    `     PR is squash-merged.  The title must not include issue or PR`,
    `     numbers; reference the issue in the body using \`Closes #N\``,
    `     or \`Part of #N\`.`,
    `   - Reply with the title and body wrapped in this exact envelope`,
    `     (no fences, no surrounding code blocks, no extra commentary`,
    `     between the tags):`,
    ``,
    `     \`\`\`text`,
    `     <<<TITLE>>>`,
    `     <your title on a single line>`,
    `     <<</TITLE>>>`,
    ``,
    `     <<<BODY>>>`,
    `     <your body, multi-line allowed,`,
    `     may include \`Closes #N\` / \`Part of #N\`>`,
    `     <<</BODY>>>`,
    `     \`\`\``,
    ``,
    `     Both envelopes are required.  Do not nest fenced code blocks`,
    `     around the envelope.  agentcoop parses the text between the`,
    `     tags verbatim — leading and trailing blank lines are stripped,`,
    `     internal blank lines are preserved.`,
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
    `  drafted the suggested title and body in the <<<TITLE>>>/`,
    `  <<<BODY>>> envelope (no force-push)`,
    `- BLOCKED — if you could not complete either path and need user`,
    `  intervention`,
    ``,
    `Do not include any other commentary — just the keyword.`,
  ].join("\n");
}

/**
 * Follow-up prompt sent on the same session when the user picks
 * "agent squashes now" after a SUGGESTED_SINGLE verdict.  The agent
 * already drafted the title and body (either as a `<<<TITLE>>>` /
 * `<<<BODY>>>` envelope on the new path, or as a marker-delimited PR
 * comment on the legacy fallback path), so this just asks it to
 * perform the squash with the same message.
 */
export function buildAgentSquashFollowupPrompt(): string {
  return [
    `The user chose to have you perform the squash now using the title`,
    `and body you drafted earlier in this conversation (either via the`,
    `<<<TITLE>>> / <<<BODY>>> envelope or via the squash-suggestion PR`,
    `comment).`,
    ``,
    `Squash the branch into a single commit using that exact title and`,
    `body, then force-push (\`git push --force-with-lease\`).  You may`,
    `leave the squash-suggestion PR comment in place — it does not`,
    `interfere with merging.`,
  ].join("\n");
}

// ---- marker block parsing ----------------------------------------------------

/**
 * Extract the title and body from the squash-suggestion marker block
 * in `source` (a PR comment body).  Returns `undefined` when the
 * markers are missing or the block does not contain a parseable
 * title.
 *
 * The block uses `**Title**` and `**Body**` labels each followed by a
 * CommonMark-style fenced code block.  The fence length is chosen
 * dynamically by the agent so the block can survive commit bodies
 * that themselves contain triple-backtick samples; the parser
 * mirrors that rule by matching any opening fence of three or more
 * backticks and scanning for a closing line with a run of the same
 * character that is at least as long.
 */
export function parseSquashSuggestionBlock(
  source: string | undefined,
): SquashSuggestion | undefined {
  if (!source) return undefined;
  const startIdx = source.indexOf(SQUASH_SUGGESTION_START_MARKER);
  const endIdx = source.indexOf(SQUASH_SUGGESTION_END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return undefined;

  const inner = source.slice(
    startIdx + SQUASH_SUGGESTION_START_MARKER.length,
    endIdx,
  );

  return parseFencedSuggestion(inner);
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
 * True when `source` (a PR comment body) contains a fully parseable
 * squash suggestion block (start + end markers AND a `**Title**`
 * label followed by a well-formed fenced block that
 * `parseSquashSuggestionBlock` can extract).
 *
 * Used as a defense-in-depth assertion immediately after Stage 8
 * authored the comment itself, and as the gate when the handler
 * resumes from `awaiting_user_choice` against a comment it did not
 * just write.  Stage 9 reads the same block via
 * `parseSquashSuggestionBlock` to render the inline preview, so a
 * malformed block must not be allowed to flow into
 * `applied_via_github`.
 */
function hasValidSuggestionBlock(source: string | undefined): boolean {
  return parseSquashSuggestionBlock(source) !== undefined;
}

// ---- canonical comment formatter --------------------------------------------

/**
 * Longest run of backtick characters in `s`.  Used to size CommonMark
 * fences so a body that itself contains triple-backtick code samples
 * does not close the outer fence early.
 */
function longestBacktickRun(s: string): number {
  let max = 0;
  let current = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x60 /* ` */) {
      current++;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

/**
 * Build the canonical squash-suggestion PR comment body for
 * `suggestion`.  The output is:
 *
 * - Wrapped in {@link SQUASH_SUGGESTION_START_MARKER} /
 *   {@link SQUASH_SUGGESTION_END_MARKER}.
 * - Title and body each appear under their `**Title**` / `**Body**`
 *   label inside a CommonMark fenced code block.
 * - Each fence is sized via `max(longest backtick run, 2) + 1`,
 *   computed independently for title and body, so commit content
 *   containing triple-backtick samples does not close the outer
 *   block early.
 *
 * The result round-trips through {@link parseSquashSuggestionBlock}.
 */
export function buildSquashSuggestionComment(
  suggestion: SquashSuggestion,
): string {
  const titleFenceLen = Math.max(longestBacktickRun(suggestion.title), 2) + 1;
  const bodyFenceLen = Math.max(longestBacktickRun(suggestion.body), 2) + 1;
  const titleFence = "`".repeat(titleFenceLen);
  const bodyFence = "`".repeat(bodyFenceLen);
  return [
    SQUASH_SUGGESTION_START_MARKER,
    "## Suggested squash commit",
    "",
    "**Title**",
    "",
    `${titleFence}text`,
    suggestion.title,
    titleFence,
    "",
    "**Body**",
    "",
    `${bodyFence}text`,
    suggestion.body,
    bodyFence,
    SQUASH_SUGGESTION_END_MARKER,
  ].join("\n");
}

// ---- envelope parser --------------------------------------------------------

/** Result of parsing the `<<<TITLE>>>` / `<<<BODY>>>` agent envelope. */
export type SquashEnvelopeResult =
  | { kind: "missing" }
  | { kind: "malformed"; reason: string }
  | { kind: "ok"; suggestion: SquashSuggestion };

const ENVELOPE_TITLE_OPEN = "<<<TITLE>>>";
const ENVELOPE_TITLE_CLOSE = "<<</TITLE>>>";
const ENVELOPE_BODY_OPEN = "<<<BODY>>>";
const ENVELOPE_BODY_CLOSE = "<<</BODY>>>";

/**
 * Parse the agent's `<<<TITLE>>>...<<</TITLE>>> / <<<BODY>>>...<<</BODY>>>`
 * envelope from a free-form response.
 *
 * Returns:
 *   - `{ kind: "missing" }` when none of the four envelope tags are
 *     present.  The caller should fall through to the verdict flow:
 *     envelope absence on its own is not a SUGGESTED_SINGLE signal.
 *   - `{ kind: "malformed", reason }` when at least one tag is present
 *     but the envelope is unparseable (missing close tag, empty title,
 *     etc.).  The caller should funnel into the blocked path with the
 *     reason surfaced for diagnostics.
 *   - `{ kind: "ok", suggestion }` on a well-formed envelope.
 */
export function parseSquashEnvelope(text: string): SquashEnvelopeResult {
  const titleOpen = text.indexOf(ENVELOPE_TITLE_OPEN);
  const titleClose = text.indexOf(ENVELOPE_TITLE_CLOSE);
  const bodyOpen = text.indexOf(ENVELOPE_BODY_OPEN);
  const bodyClose = text.indexOf(ENVELOPE_BODY_CLOSE);

  const anyTag =
    titleOpen !== -1 ||
    titleClose !== -1 ||
    bodyOpen !== -1 ||
    bodyClose !== -1;
  if (!anyTag) return { kind: "missing" };

  if (titleOpen === -1) {
    return { kind: "malformed", reason: "missing <<<TITLE>>> open tag" };
  }
  if (titleClose === -1) {
    return { kind: "malformed", reason: "missing <<</TITLE>>> close tag" };
  }
  if (titleClose < titleOpen) {
    return {
      kind: "malformed",
      reason: "<<</TITLE>>> appears before <<<TITLE>>>",
    };
  }
  if (bodyOpen === -1) {
    return { kind: "malformed", reason: "missing <<<BODY>>> open tag" };
  }
  if (bodyClose === -1) {
    return { kind: "malformed", reason: "missing <<</BODY>>> close tag" };
  }
  if (bodyClose < bodyOpen) {
    return {
      kind: "malformed",
      reason: "<<</BODY>>> appears before <<<BODY>>>",
    };
  }

  const title = text
    .slice(titleOpen + ENVELOPE_TITLE_OPEN.length, titleClose)
    .replace(/^\n+|\n+$/g, "")
    .trim();
  const body = text
    .slice(bodyOpen + ENVELOPE_BODY_OPEN.length, bodyClose)
    .replace(/^\n+|\n+$/g, "");

  if (title === "") {
    return { kind: "malformed", reason: "title envelope is empty" };
  }
  if (body === "") {
    return { kind: "malformed", reason: "body envelope is empty" };
  }
  return { kind: "ok", suggestion: { title, body } };
}

// ---- post-or-update helper --------------------------------------------------

/**
 * Dependencies for {@link postOrUpdateSquashSuggestion}.  Exposed so
 * unit tests can substitute stub gh adapters without monkey-patching
 * the module-level imports.
 */
export interface PostOrUpdateSquashSuggestionDeps {
  findLatest?: (
    owner: string,
    repo: string,
    prNumber: number,
    marker: string,
  ) => { id: number | undefined; body: string } | undefined;
  patch?: (owner: string, repo: string, id: number, body: string) => void;
  post?: (owner: string, repo: string, prNumber: number, body: string) => void;
}

/**
 * Idempotent write entry point for the squash-suggestion PR comment.
 *
 * Looks up any existing comment whose body contains
 * {@link SQUASH_SUGGESTION_START_MARKER}.  When a prior comment
 * exists and exposes its id, edit it via PATCH so the PR timeline
 * does not accumulate duplicate suggestion comments.  Otherwise,
 * post a fresh comment.
 *
 * If the prior-comment lookup returns a body without an id (older
 * fixtures, manual stubs), this falls back to POST — the caller will
 * end up with two comments on the PR but the most recent one wins
 * for display purposes.  The default lookup always populates id from
 * the GitHub API response.
 */
export function postOrUpdateSquashSuggestion(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  deps: PostOrUpdateSquashSuggestionDeps = {},
): void {
  const findLatest = deps.findLatest ?? defaultFindLatestCommentWithMarker;
  const patch = deps.patch ?? defaultPatchPrComment;
  const post = deps.post ?? defaultPostPrComment;

  const existing = findLatest(
    owner,
    repo,
    prNumber,
    SQUASH_SUGGESTION_START_MARKER,
  );
  if (existing && existing.id !== undefined) {
    patch(owner, repo, existing.id, body);
    return;
  }
  post(owner, repo, prNumber, body);
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
      const findSuggestionCommentBody =
        opts.findSuggestionCommentBody ??
        ((owner, repo, prNumber, marker) =>
          defaultFindLatestCommentWithMarker(owner, repo, prNumber, marker)
            ?.body);
      const findPrNumber = opts.findPrNumber ?? defaultFindPrNumber;
      const postSuggestionComment =
        opts.postSuggestionComment ?? postOrUpdateSquashSuggestion;

      /**
       * Resolve and fetch the squash-suggestion comment body for the
       * current branch's PR.  Returns `undefined` when the PR cannot
       * be resolved or when no matching comment exists.
       */
      const readSuggestionCommentBody = (): string | undefined => {
        const prNumber = findPrNumber(ctx.owner, ctx.repo, ctx.branch);
        if (prNumber === undefined) return undefined;
        return findSuggestionCommentBody(
          ctx.owner,
          ctx.repo,
          prNumber,
          SQUASH_SUGGESTION_START_MARKER,
        );
      };

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

      if (saved === "applied_via_github") {
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
        // Check the PR lifecycle BEFORE reading the suggestion
        // comment: `findPrNumber` uses `gh pr list` which only
        // returns open PRs, so once the user merges on GitHub the
        // comment lookup fails and we would otherwise fall through
        // to a fresh planning run instead of short-circuiting to
        // `squash.alreadyMerged`.
        const merged = guardIfPrMerged(ctx, opts);
        if (merged) return merged;
        const commentBody = readSuggestionCommentBody();
        if (hasValidSuggestionBlock(commentBody)) {
          return askUserAndApply(ctx, opts, undefined);
        }
        // Suggestion comment missing or malformed — fall back to a
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

      const verdictCtx: VerdictContext | undefined = ctx.events
        ? { events: ctx.events, agent: "a" }
        : undefined;

      // ---- envelope-driven SUGGESTED_SINGLE shortcut ----------------------
      //
      // The agent now hands back a `<<<TITLE>>>...<<</TITLE>>>` /
      // `<<<BODY>>>...<<</BODY>>>` envelope when it judges a single
      // commit appropriate, and agentcoop authors the marker-delimited
      // PR comment from those fields.  This replaces the prior
      // contract where the agent posted the comment itself and the
      // verdict turn carried "I posted it" semantics.
      //
      // Envelope absence is NOT a SUGGESTED_SINGLE signal — the
      // agent could be in the SQUASHED_MULTI branch, or BLOCKED, or
      // simply ambiguous.  Only an `ok` envelope short-circuits to
      // the user-choice flow; everything else falls through to the
      // existing verdict / clarification chain so SQUASHED_MULTI and
      // BLOCKED keep their behaviour.
      const envelope = parseSquashEnvelope(squashResult.responseText);
      if (envelope.kind === "malformed") {
        opts.onSquashSubStep?.(undefined);
        return {
          outcome: "blocked",
          message: `${squashResult.responseText}\n\n---\n\nSquash-suggestion envelope malformed: ${envelope.reason}.  The agent appears to have taken the SUGGESTED_SINGLE branch but the <<<TITLE>>> / <<<BODY>>> envelope could not be parsed.`,
        };
      }
      if (envelope.kind === "ok") {
        const prNumber = findPrNumber(ctx.owner, ctx.repo, ctx.branch);
        if (prNumber === undefined) {
          // No open PR — likely a concurrent merge or a missing PR.
          // The merged guard would have short-circuited if the PR is
          // merged; otherwise this is genuinely blocked because the
          // suggestion cannot be persisted anywhere.
          const merged = guardIfPrMerged(ctx, opts);
          if (merged) return merged;
          opts.onSquashSubStep?.(undefined);
          return {
            outcome: "blocked",
            message: `${squashResult.responseText}\n\n---\n\nSquash-suggestion envelope parsed but no open PR was found for branch ${ctx.branch}; cannot post the suggestion comment.`,
          };
        }
        const commentBody = buildSquashSuggestionComment(envelope.suggestion);
        // Defense-in-depth: confirm the comment we just authored is
        // round-trip parseable before publishing it.  The formatter is
        // unit-tested for this property; the assertion guards against
        // a future regression sneaking a malformed block into Stage 9.
        if (!hasValidSuggestionBlock(commentBody)) {
          throw new Error(
            "buildSquashSuggestionComment produced an unparseable block — formatter / parser are out of sync",
          );
        }
        postSuggestionComment(ctx.owner, ctx.repo, prNumber, commentBody);
        verdictCtx?.events.emit("pipeline:verdict", {
          agent: verdictCtx.agent,
          keyword: "SUGGESTED_SINGLE",
          raw: squashResult.responseText,
        });
        return askUserAndApply(ctx, opts, squashResult.sessionId);
      }

      // ---- verdict --------------------------------------------------------
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
      // exact conversation that drafted the squash-suggestion comment.
      if (verdictSessionId) {
        ctx.onSessionId?.("a", verdictSessionId);
      }

      // ---- post-clarification deterministic fallback chain -----------------
      // Order matters: a completed force-push is the hard-to-undo side
      // effect, so detect it first.  Only then check the suggestion
      // comment, because an earlier run may have left a stale comment
      // on the PR that would otherwise be misclassified.  The block
      // must be fully parseable (markers + `**Title**` label) — a malformed
      // block is treated as missing because Stage 9 cannot render a
      // preview from it.
      if (verdict === undefined) {
        const postCount = countCommits(ctx.worktreePath, opts.defaultBranch);
        if (postCount < initialCount) {
          verdict = "SQUASHED_MULTI";
        } else {
          // Check the PR lifecycle BEFORE the comment lookup:
          // `findPrNumber` uses `gh pr list` (open PRs only), so a
          // concurrent merge between the clarification turn and this
          // fallback would make the lookup return `undefined` and flip
          // the verdict to `BLOCKED` instead of taking the existing
          // merged short-circuit.
          const merged = guardIfPrMerged(ctx, opts);
          if (merged) return merged;
          const commentBody = readSuggestionCommentBody();
          if (hasValidSuggestionBlock(commentBody)) {
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
        // Check the PR lifecycle BEFORE reading the suggestion
        // comment: a concurrent merge on GitHub would make the
        // `findPrNumber` lookup (which uses `gh pr list`, open PRs
        // only) return `undefined`, and the verdict would flip to
        // `BLOCKED` instead of taking the existing merged
        // short-circuit.
        const merged = guardIfPrMerged(ctx, opts);
        if (merged) return merged;
        // Verify the PR comment holds a fully parseable suggestion
        // block before asking the user.  A bare start marker or a
        // block missing the `**Title**` label / the end marker would
        // let the stage complete with `applied_via_github` but leave
        // Stage 9 unable to render the inline preview, so fail closed
        // instead.
        const commentBody = readSuggestionCommentBody();
        if (!hasValidSuggestionBlock(commentBody)) {
          opts.onSquashSubStep?.(undefined);
          return {
            outcome: "blocked",
            message: `${squashResult.responseText}\n\n---\n\n${verdictResponseText}`,
          };
        }
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

  // The startup policy decides whether to interrupt the pipeline
  // with a per-run prompt or proceed silently with "agent".  Default
  // policy is "ask" so missing wiring keeps today's behaviour.
  const policy = opts.squashApplyPolicy ?? "ask";
  const choice: "agent" | "github" =
    policy === "auto"
      ? "agent"
      : opts.chooseSquashApplyMode
        ? await opts.chooseSquashApplyMode(t()["squash.singleChoicePrompt"])
        : "agent";

  if (choice === "github") {
    opts.onSquashSubStep?.("applied_via_github");
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
