# Changelog

This file documents recent notable changes to this project. The format of this
file is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Stage 8 (Squash) no longer asks the agent to author the
  marker-delimited squash-suggestion PR comment.  The agent now
  drafts the title and body inside a `<<<TITLE>>>` / `<<<BODY>>>`
  envelope, and agentcoop builds the marker block (with correct
  fence sizing) and PATCH/POSTs the comment idempotently.  The
  formatter and parser are pinned in lock-step by a round-trip
  unit test.  This eliminates a class of malformed-comment
  failures where a missing end marker or unterminated fence in the
  agent-authored comment would silently flip the stage to
  `blocked` after the verdict cleanly returned `SUGGESTED_SINGLE`.
- `findLatestCommentWithMarker` now returns `{ id, body }` instead
  of just the body so callers that need to PATCH an existing
  comment can do so without a second lookup.  Read-only callers
  destructure `.body`.

## [0.2.0] - 2026-04-29

### Added

- Agent pane headers now include the CLI name and installed CLI
  version next to the model label (e.g.
  `Agent A (author) — Claude Opus 4.6 v1.2.3`). The CLI name
  disambiguates panes when model names are shared or user-configured.
  The version is detected once at pipeline start so it does not flicker
  mid-run, and is threaded through `renderApp` so no adapter changes are
  required.
- Startup now compares the installed `claude` / `codex` CLI against the
  channel-appropriate "latest" version and prompts the user to update
  when a newer release is available. The check runs after the CLIs
  actually used this run are known (fresh and resume branches joined,
  `params` finalized) so it never prompts for a CLI that is not in use.
  Claude's latest is fetched from the npm registry. Codex's latest is
  resolved by matching the installed binary's realpath against known
  layouts (npm global prefix anchored on
  `lib/node_modules/@openai/codex/` so a project-local install at
  `<repo>/node_modules/@openai/codex/...` — reachable via
  `node_modules/.bin/codex` — is treated as inconclusive rather than
  pointed at the npm registry, Homebrew formula `Cellar/codex/`,
  Homebrew cask `Caskroom/codex/`, or a standalone install rooted at
  `~/.codex/` — specifically `~/.codex/bin/`,
  `~/.codex/versions/<ver>/`, or the current
  `~/.codex/packages/standalone/releases/` layout). Homebrew matches
  are anchored on the `codex` package segment and root-anchored on the
  Homebrew prefixes (`/opt/homebrew/`, `/usr/local/`,
  `/home/linuxbrew/.linuxbrew/`),
  so a custom wrapper formula/cask (e.g. `Cellar/my-codex-wrapper/...`,
  `Caskroom/custom-codex/...`) and a copied tree under a non-Homebrew
  root (e.g. `/tmp/opt/homebrew/Cellar/codex/...`,
  `/Users/me/sandbox/usr/local/Caskroom/codex/...`) are not
  misclassified as the official `codex` package. Only the known
  subpaths under the running user's home directory are accepted as a
  standalone install; any other
  layout — including an unrecognized subpath inside `~/.codex/` (e.g.
  `~/.codex/tools/codex`) or a raw `Applications/` path that did not
  resolve through `realpath` into a Caskroom directory — is treated as
  inconclusive and the check is skipped for that CLI rather than
  guessed. When an update is
  chosen, AgentCoop pauses for the user to run their package manager
  and re-runs `--version` on return; if the
  version is unchanged it offers retry / skip (proceed with the current
  version) / abort. The check can be disabled with
  `skipVersionCheck: true` in `~/.agentcoop/config.json` and is
  throttled to once per 24h via `lastVersionCheckAt`. The throttle
  timestamp only advances after at least one CLI reached a real
  installed-vs-latest comparison, so a run where every channel was
  inconclusive or the registry fetch failed still re-checks on the
  next start rather than being silently throttled for 24h. Network
  failures are logged but never fatal. The persistence writes
  `lastKnownVersions` / `lastVersionCheckAt` as a narrow patch into
  the raw JSON rather than round-tripping through the normalized
  `Config` shape, so unknown top-level keys in
  `~/.agentcoop/config.json` (user-added fields, fields from a newer
  AgentCoop version, etc.) are preserved across the update. The patch
  also merges `lastKnownVersions` against the existing nested object
  rather than replacing it, so unknown nested CLI entries (e.g. a
  forward-compatible `gemini` field added by a newer AgentCoop
  version) survive a claude/codex-only check.
- Per-run CLI versions are now recorded into `RunState`
  (`agentA.cliVersion` / `agentB.cliVersion`) and into the run-log
  header under a `version` line for each agent, so postmortem
  reproduction can identify the exact CLI build that produced a run.
  The values survive across resume and are refreshed at resume time so
  a CLI upgrade between runs is captured, not silently discarded. A
  failed re-probe on resume (e.g. `--version` crashed or its output
  could not be parsed) intentionally keeps the previously recorded
  version rather than blanking it, preserving the postmortem record.
- Stage 8 (Squash) now posts the single-commit suggestion as a PR
  comment instead of editing the PR body. The agent looks up any
  prior squash-suggestion comment by its start marker and PATCHes it
  in place so the timeline stays near the "Squash and merge" dropdown
  rather than accumulating duplicates.
- Startup now asks once per run whether a SUGGESTED_SINGLE squash
  verdict should be applied automatically by the agent or interrupt
  the pipeline with the per-run chooser. Asked on both the fresh
  start and resume branches; not persisted to config or RunState.
  Default is "let the agent handle it".
- Stage 1 (Bootstrap) is now surfaced retrospectively in the TUI. At first
  render, the status bar shows `Stage 1: Bootstrap → Stage N: <name>` briefly
  (where `N` is 2 on a fresh run or `startFromStage` on resume) before
  collapsing to the normal single-stage display once the first real
  `stage:enter` fires. Both agent panes prepend a Stage 1 enter divider, the
  buffered bootstrap log lines (repository bootstrap, worktree ready, and
  the conditional uncommitted-preserved / PR-exists-skip messages) as
  timestamped `[HH:MM:SS] Pipeline: …` rows, and a Stage 1 → Stage N
  transition divider. Terminal scrollback still receives the bootstrap
  lines live before the TUI mounts.
- Status bar now wraps the issue reference on line 1 with an OSC 8 terminal
  hyperlink so supporting terminals (iTerm2, WezTerm, Ghostty, Kitty, modern
  VS Code, Windows Terminal, Alacritty, etc.) render it as a clickable link
  pointing at the GitHub issue page. Older terminals render the text
  unchanged.
- Status bar line 2 now includes a `PR: #{n}` segment (between `Base:` and
  `Stage:`) once the pull-request number is known, also wrapped with an
  OSC 8 hyperlink pointing at the PR page.
- Stage 8 (Squash) now offers a single-commit suggestion path: when the agent
  judges that one commit is appropriate, it posts the suggested title and
  body inside a marker-delimited PR comment instead of force-pushing. The
  user can then either let the agent perform the squash (which reruns CI)
  or apply the suggestion via GitHub's "Squash and merge" at merge time
  (which avoids the extra CI cycle).
- Stage 9 (Done) merge-confirm screen now surfaces the suggested squash
  title and PR URL inline when the squash stage finished via the
  squash-suggestion comment path, so the user can copy-paste without opening
  the browser.  The body is represented by a one-line summary (`Suggested
  body: N lines`) rather than being inlined verbatim, since a long body
  otherwise pushed the merge-confirm choice lines off the bottom of the
  terminal viewport with no way to scroll them back into view.  The full
  body remains accessible through the `[b]` clipboard hotkey and the linked
  PR comment.
- Stage 9 (Done) merge-confirm screen now renders `[t] copy` / `[b] copy`
  hotkey hints next to the suggested squash title and the body summary
  when the terminal can write to the system clipboard.  Pressing `t` copies
  the title and `b` copies the body (each independently, so the values line
  up with GitHub's separate "Squash and merge" title / body fields).  A
  small clipboard utility detects the environment and returns an ordered
  candidate list (`pbcopy` / `wl-copy` / `xclip` on local sessions, OSC 52
  first on SSH sessions, OSC 52 as fallback everywhere stdout is a TTY),
  and the writer tries candidates in order until one succeeds.  When no
  candidate is reachable, the hints are not rendered at all — the user
  falls back to opening the PR comment, rather than seeing a hint that
  silently does nothing.  Per-hotkey status (`copy` / `copied` / `copy
  failed`) is reflected in the label; `copied` auto-reverts after ~1s,
  `copy failed` persists until the next re-render.
- Stage 9's merge-confirm prompt now caps the height of the InputArea so
  even an unexpectedly long prompt cannot push the choice / input lines
  past the bottom of the terminal viewport.  When the message would
  overflow, the tail is replaced with a single `…(truncated)` marker so
  the choice lines stay visible.  Pathologically long suggested squash
  titles (>120 characters or containing embedded newlines) are also
  ellipsized at the assembly stage.  Each rendered prompt line — message
  rows and choice rows alike — is rendered with `wrap="truncate-end"` so
  a long single-line title or hint cannot wrap to multiple terminal rows
  on a narrow terminal, which would otherwise break the row budget.

### Changed

- Stage 8's squash suggestion comment now emits the title and body inside
  separate fenced code blocks (info string `text`) instead of bold-labeled
  plain Markdown (`**Title:** …` / `**Body:** …`).  GitHub renders a
  one-click copy icon on fenced blocks and does not reinterpret Markdown
  characters inside, so the user can paste the suggestion verbatim into the
  "Squash and merge" dialog.  The agent chooses each fence length
  dynamically per the CommonMark rule
  (`max(longest backtick run in content, 2) + 1`, minimum 3) so commit
  bodies containing their own triple-backtick samples survive unchanged.
- Stage 8 verdict keywords are now `SQUASHED_MULTI` / `SUGGESTED_SINGLE` /
  `BLOCKED` (previously `COMPLETED` / `BLOCKED`).  When the verdict is
  ambiguous after a clarification retry, the handler runs a deterministic
  fallback chain — commit-count decrease, then suggestion-comment marker
  presence, then BLOCKED.
- `RunState` now persists a `squashSubStep` field tracking progress through
  the squash stage's substates so resume can re-enter at the correct point.
  `RUN_STATE_VERSION` bumped from 2 to 3 (the new field defaults to
  `undefined` for older state files; no destructive migration).
- Stage 9 merge-confirm screen now includes a conditional one-line tip
  (`pipeline.mergeConfirmSquashTip`) when a squash suggestion comment is
  live on the PR.

### Fixed

- Stage 9's `check_conflicts` recheck no longer blocks on a press-enter
  prompt when GitHub reports `MERGEABLE`.  The "no conflicts" result is
  now folded into the redrawn merge-confirm screen as a one-shot notice
  and the inner loop returns to `confirmMerge` immediately.
  `waitForManualResolve` stays reserved for the cases where the user
  actually has manual work to do (post-rebase / already-attempted
  CONFLICTING).
- Stage 9 no longer silently ends the session when the post-rebase CI fix
  loop exhausts its attempt budget.  `pollCiAndFix` now accepts an
  opt-in `confirmRetry` callback that Stage 9 wires to the TUI; when the
  budget is spent the user is asked whether to keep trying, and the
  cleanup path only runs after an explicit decline.  Stages 7 and 8 are
  unchanged — they already route CI failures through the engine's
  `dispatchError` prompt and must not double-ask.
- Stage 9's `confirmRetry` prompt now also surfaces on CI pending-timeout
  and findings-review / fix agent errors, not just on fix-budget
  exhaustion.  Previously these three branches in `pollCiAndFix`
  returned `passed: false` directly and the Done stage advanced to the
  cleanup ("Delete local worktree?") prompt without giving the user a
  chance to keep waiting or retry.  The callback signature is now a
  discriminated `ConfirmRetryInfo` union (`exhausted` / `timeout` /
  `agent_error`) so each reason carries its own metadata; on confirm,
  timeout resumes polling, agent errors retry the same step with the
  pre-incremented counter undone so a permanent failure cannot
  prematurely exhaust the budget, and exhaustion resets the fix
  counter (existing behavior).  Stages 7 and 8 still do not pass
  `confirmRetry`, so their `dispatchError` flow is unaffected.
- Stage 9's rebase handler now distinguishes an agent process failure
  from a BLOCKED verdict.  `RebaseResult` is a discriminated union
  (`completed` / `blocked` / `error`), and both Stage 9 call sites
  surface the agent's own message instead of the old generic
  "resolve manually" notice.  Agent errors no longer consume the
  single-attempt rebase budget, so the user can retry after dealing
  with the underlying error.  The `check_conflicts` sub-path used to
  silently `break` back to the merge-confirm screen on any rebase
  failure; it now surfaces BLOCKED / error messages and, on CI
  failure, terminates the stage via `onNotMerged` like the top-level
  `afterResolution` path instead of misusing `waitForManualResolve`
  to announce a CI pass.
- AgentCoop-managed Codex runs now pin `approval_policy=never`
  explicitly instead of inheriting the user's local Codex approval
  setting. Fresh `codex exec` runs keep using
  `-s danger-full-access`, while `codex exec resume` now prefers
  `--json` for structured parsing and streaming on newer CLIs and
  falls back to the legacy plain-text parser only when the installed
  CLI explicitly rejects JSON resume.
- Resuming Stage 8 from the `squashing` substate no longer re-sends the
  full planning prompt.  The handler now checks whether the squash
  already landed (commit count collapsed to 1) and jumps straight to
  the CI poll, or re-sends only the follow-up squash prompt on the
  saved session — avoiding a spurious second force-push / CI cycle
  that defeated the purpose of this feature.
- `RunState` migration from v2 to v3 no longer re-applies the v1 → v2
  stage 7 / 8 swap, which would have remapped existing v2 runs
  persisted at stage 7 or 8 to the wrong handler on upgrade.  The
  swap is now guarded on the source version actually being v1 /
  unversioned.
- Stage 8 no longer silently routes a user's "agent squashes now"
  choice to the "apply via GitHub" completion when no agent session
  is available.  It fails closed with a clear message so the user is
  not misled about what happened.
- Stage 8 in-process retries now read the live persisted squash
  sub-step and agent session id on each handler invocation instead
  of the startup snapshot.  Previously, a transient `ci_poll`
  failure followed by a retry could observe `squashSubStep ===
  undefined` and, with the branch already collapsed to a single
  commit, fall into the single-commit skip path — turning a
  recoverable CI failure into a false successful completion.
- Stage 8's deterministic fallback chain (commit-count /
  marker-presence) now emits the `pipeline:verdict` event for the
  derived verdict.  Previously the event was only emitted when the
  agent response parsed into a concrete keyword, so the fallback
  branch silently skipped telemetry.
- Stage 8 now validates the squash suggestion comment strictly before
  accepting `SUGGESTED_SINGLE` / `applied_via_github`.  A bare start
  marker or a comment missing the `**Title**` label / the end marker
  is treated as malformed and fails closed (or re-runs planning on
  resume) instead of completing with `squash.messageAppended` and
  leaving Stage 9 unable to render the inline preview.
- Stage 8 now persists the verdict turn's session id before
  transitioning to `awaiting_user_choice`.  Adapters can surface a
  new session id on follow-up turns, so the verdict session is not
  guaranteed to match the planning session that was persisted
  earlier.  Without this, a resume where the user picks "agent
  squashes now" could re-send the follow-up on the older planning
  session rather than the exact conversation that drafted the
  squash-suggestion comment.

## [0.1.0] - 2026-04-18

### Added

- Initial public release of AgentCoop.

[Unreleased]: https://github.com/aicers/agentcoop/compare/0.2.0...HEAD
[0.2.0]: https://github.com/aicers/agentcoop/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/aicers/agentcoop/tree/0.1.0
