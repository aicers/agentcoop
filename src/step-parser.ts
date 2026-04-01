/**
 * Parse agent responses for step completion status keywords.
 *
 * The orchestrator needs to understand whether an agent considers a step
 * finished, blocked, or still in progress.  Agents are instructed to end
 * their responses with one of the recognised keywords, but in practice
 * the keyword may appear anywhere in the final paragraph.
 */

// ---- public types --------------------------------------------------------

export type StepStatus =
  | "completed"
  | "fixed"
  | "approved"
  | "not_approved"
  | "blocked"
  | "ambiguous";

export interface ParsedStep {
  status: StepStatus;
  /** The raw keyword that was matched, if any. */
  keyword: string | undefined;
}

// ---- keyword map ---------------------------------------------------------

const KEYWORD_MAP: ReadonlyMap<string, StepStatus> = new Map([
  ["COMPLETED", "completed"],
  ["DONE", "fixed"],
  ["FIXED", "fixed"],
  ["APPROVED", "approved"],
  ["NOT_APPROVED", "not_approved"],
  ["BLOCKED", "blocked"],
]);

// ---- public API ----------------------------------------------------------

/**
 * Scan `text` for the **last** occurrence of a recognised status keyword.
 *
 * Returns `{ status, keyword }` when a keyword is found, or
 * `{ status: "ambiguous", keyword: undefined }` when no keyword is present.
 */
export function parseStepStatus(text: string): ParsedStep {
  // We want the *last* match, so scan all occurrences.
  const upper = text.toUpperCase();
  let lastIndex = -1;
  let lastKeyword: string | undefined;

  for (const keyword of KEYWORD_MAP.keys()) {
    // Use a simple search; we check word-boundary manually below.
    let start = 0;
    while (true) {
      const idx = upper.indexOf(keyword, start);
      if (idx === -1) break;

      // Word-boundary check: character before and after must be non-word.
      const before = idx > 0 ? upper[idx - 1] : " ";
      const after =
        idx + keyword.length < upper.length ? upper[idx + keyword.length] : " ";

      if (/\W/.test(before) && /\W/.test(after)) {
        if (idx > lastIndex) {
          lastIndex = idx;
          lastKeyword = keyword;
        }
      }
      start = idx + 1;
    }
  }

  if (lastKeyword === undefined) {
    return { status: "ambiguous", keyword: undefined };
  }

  return {
    status: KEYWORD_MAP.get(lastKeyword) as StepStatus,
    keyword: lastKeyword,
  };
}

/**
 * Build a single-shot clarification prompt to send back to the agent when
 * the previous response was ambiguous.
 */
export function buildClarificationPrompt(_originalResponse: string): string {
  return [
    "Your previous response did not end with a clear status keyword.",
    "Please reply with exactly one of the following keywords to indicate",
    "the current status: COMPLETED, FIXED, DONE, APPROVED, NOT_APPROVED,",
    "or BLOCKED.",
    "",
    "Do not include any other commentary — just the keyword.",
  ].join("\n");
}
