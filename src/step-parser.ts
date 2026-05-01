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
 * Strictly parse a verdict response for exactly one valid keyword.
 *
 * Unlike `parseStepStatus` (which scans free-form text for the *last*
 * keyword), this function requires the response to be essentially just
 * the keyword — optionally surrounded by whitespace and punctuation.
 *
 * Returns `{ keyword }` when exactly one valid keyword is found and no
 * other valid keyword appears in the text.  Returns `{ keyword: undefined }`
 * when the response is ambiguous: no keyword, multiple valid keywords,
 * or significant extra commentary.
 */
export function parseVerdictKeyword(
  text: string,
  validKeywords: readonly string[],
): { keyword: string | undefined } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { keyword: undefined };

  const upper = trimmed.toUpperCase();

  // Fast path: exact match (most well-behaved agents).
  for (const kw of validKeywords) {
    if (upper === kw.toUpperCase()) return { keyword: kw };
  }

  // Count how many distinct valid keywords appear as whole words.
  const found: string[] = [];
  for (const kw of validKeywords) {
    const kwUpper = kw.toUpperCase();
    const pattern = new RegExp(`(?<![\\w])${escapeRegExp(kwUpper)}(?![\\w])`);
    if (pattern.test(upper)) {
      found.push(kw);
    }
  }

  if (found.length !== 1) {
    // Zero keywords or multiple keywords → ambiguous.
    return { keyword: undefined };
  }

  // Exactly one keyword found — verify there is no significant extra text.
  // Strip the keyword and all non-alphanumeric characters; if anything
  // substantive remains, treat as extra commentary.
  const kwUpper = found[0].toUpperCase();
  const stripped = upper
    .replace(new RegExp(`(?<![\\w])${escapeRegExp(kwUpper)}(?![\\w])`), "")
    .replace(/[^A-Z0-9]/g, "");

  if (stripped.length > 0) {
    // Extra words remain → ambiguous.
    return { keyword: undefined };
  }

  return { keyword: found[0] };
}

/** Escape special regex characters in a string. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a single-shot clarification prompt to send back to the agent when
 * the previous response was ambiguous.
 *
 * When `validKeywords` is provided, only those keywords are listed.
 * Otherwise the prompt falls back to listing all recognised keywords.
 */
export function buildClarificationPrompt(
  _originalResponse: string,
  validKeywords?: readonly string[],
): string {
  const keywords = validKeywords?.length
    ? validKeywords.join(", ")
    : "COMPLETED, FIXED, DONE, APPROVED, NOT_APPROVED, BLOCKED";
  return `Reply with exactly one keyword (no commentary): ${keywords}.`;
}
