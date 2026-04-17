# Changelog

This file documents recent notable changes to this project. The format of this
file is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-18

First public release.

### Added

- **Pipeline** — 8-stage pipeline (stages 2–9) orchestrating two AI agents
  (author and reviewer) through implementation, self-check, PR creation, CI
  fix, test plan verification, code review, commit squash, and merge
  preparation.
- **Agent adapters** — Support for Claude and Codex as agent CLIs, each
  running in non-interactive mode with full filesystem and tool access.
- **Terminal UI** — Split-pane Ink-based TUI with real-time streamed agent
  output, token usage bar, status bar (elapsed time, stage, base commit),
  and horizontal/vertical layout toggle.
- **Run state persistence** — Pipeline state is saved to
  `~/.agentcoop/runs/{owner}/{repo}/{issueNumber}.json` so interrupted runs
  can resume from the last completed stage.
- **Repository isolation** — Bare clone at
  `~/.agentcoop/repos/{owner}/{repo}.git` with per-issue git worktrees at
  `~/.agentcoop/worktrees/{owner}/{repo}/issue-{number}`.
- **CI integration** — Waits for GitHub Actions and check runs; agent fixes
  failures automatically; CodeQL findings are triaged via the code scanning
  API.
- **Review loop** — Author and reviewer communicate through labelled PR
  comments (`[Reviewer Round N]`, `[Author Round N]`, `[Review Verdict Round
  N]`); state is reconciled from PR comments on resume.
- **Configurable pipeline settings** — Loop budgets, CI timeout, inactivity
  timeout, and agent defaults are persisted in `~/.agentcoop/config.json`.
- **Custom model support** — Models are loaded from `models.json`; users can
  add, edit, and remove custom model entries through the startup wizard.
- **i18n** — UI strings available in English and Korean.
- **Notifications** — Desktop and terminal-bell notifications on macOS when
  user input is required.
- **Run log** — Persistent JSONL run log written alongside run state for
  post-mortem inspection.
- **Inline diagnostics** — Pipeline diagnostic events are displayed directly
  in the agent panes.
- **Step mode** — Optional step-by-step execution where the user confirms
  before each pipeline stage.

[Unreleased]: https://github.com/aicers/agentcoop/compare/0.1.0...main
[0.1.0]: https://github.com/aicers/agentcoop/tree/0.1.0
