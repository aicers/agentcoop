# Changelog

This file documents recent notable changes to this project. The format of this
file is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Status bar now wraps the issue reference on line 1 with an OSC 8 terminal
  hyperlink so supporting terminals (iTerm2, WezTerm, Ghostty, Kitty, modern
  VS Code, Windows Terminal, Alacritty, etc.) render it as a clickable link
  pointing at the GitHub issue page. Older terminals render the text
  unchanged.
- Status bar line 2 now includes a `PR: #{n}` segment (between `Base:` and
  `Stage:`) once the pull-request number is known, also wrapped with an
  OSC 8 hyperlink pointing at the PR page.
- Stage 8 (Squash) now offers a single-commit suggestion path: when the agent
  judges that one commit is appropriate, it writes the suggested title and
  body into a marker-delimited block in the PR body instead of force-pushing.
  The user can then either let the agent perform the squash (which reruns CI)
  or apply the suggestion via GitHub's "Squash and merge" at merge time
  (which avoids the extra CI cycle).
- Stage 9 (Done) merge-confirm screen now prints the suggested squash title,
  body, and PR URL inline when the squash stage finished via the
  PR-body suggestion path, so the user can copy-paste without opening the
  browser.

### Changed

- Stage 8 verdict keywords are now `SQUASHED_MULTI` / `SUGGESTED_SINGLE` /
  `BLOCKED` (previously `COMPLETED` / `BLOCKED`).  When the verdict is
  ambiguous after a clarification retry, the handler runs a deterministic
  fallback chain — commit-count decrease, then PR-body marker presence,
  then BLOCKED.
- `RunState` now persists a `squashSubStep` field tracking progress through
  the squash stage's substates so resume can re-enter at the correct point.
  `RUN_STATE_VERSION` bumped from 2 to 3 (the new field defaults to
  `undefined` for older state files; no destructive migration).
- Stage 9 merge-confirm screen now includes a conditional one-line tip
  (`pipeline.mergeConfirmSquashTip`) when a squash suggestion is live in
  the PR body.

### Fixed

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
- Stage 8 now validates the squash suggestion block strictly before
  accepting `SUGGESTED_SINGLE` / `applied_in_pr_body`.  A bare start
  marker or a block missing `**Title:**` / the end marker is treated
  as malformed and fails closed (or re-runs planning on resume)
  instead of completing with `squash.messageAppended` and leaving
  Stage 9 unable to render the inline preview.
- Stage 8 now persists the verdict turn's session id before
  transitioning to `awaiting_user_choice`.  Adapters can surface a
  new session id on follow-up turns, so the verdict session is not
  guaranteed to match the planning session that was persisted
  earlier.  Without this, a resume where the user picks "agent
  squashes now" could re-send the follow-up on the older planning
  session rather than the exact conversation that drafted the
  PR-body suggestion.

## [0.1.0] - 2026-04-18

### Added

- Initial public release of AgentCoop.

[0.1.0]: https://github.com/aicers/agentcoop/tree/0.1.0
