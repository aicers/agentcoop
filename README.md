# AgentCoop

An AI pipeline that takes a GitHub issue and autonomously implements,
reviews, and prepares it for merge. The current implementation uses
two agents — one author and one reviewer. A future version will
expand to three agents (one author and two reviewers).

Break your project down into well-written issues, each scoped to a
single PR. AgentCoop works through them — implementing, reviewing,
and merging — so the software gets built with minimal human
involvement.

## Terminal UI

```text
┌─ Agent A (author) — Claude Opus 4.6 ● [*] ─┬─ Agent B (reviewer) — GPT-5.4 ─┐
│                                            │                                │
│  (streamed output)                         │  (streamed output)             │
│                                            │                                │
├────────────────────────────────────────────┴────────────────────────────────┤
│ A (Claude): 12.3K in / 5.1K out            │ B (Codex): 8.7K in / 3.2K out  │
├─────────────────────────────────────────────────────────────────────────────┤
│ owner/repo#42: Issue title                                                  │
│ Base: abc1234  │  Stage 3: Self-check (round 2)  │  Layout: horizontal      │
│ ●:Active [*]:Focused Tab:Switch pane ↑↓:Scroll Ctrl+L:Layout Ctrl+C:Quit    │
├─────────────────────────────────────────────────────────────────────────────┤
│ Pipeline running...                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Agent panes** — Streamed output from each agent in real time.
  The active agent is marked with `●`, the focused pane (for
  scrolling) with `[*]`.
- **TokenBar** — Per-agent token usage (input/output, with cached
  token counts when available).
- **StatusBar** — Issue reference, base commit SHA, current pipeline
  stage with loop count, and layout indicator.
- **InputArea** — Shows "Pipeline running..." while agents work.
  When user input is needed (BLOCKED, loop budget, step-mode), it
  presents numbered choices or a free-text field.

### Keybindings

| Key | Action |
| --- | ------ |
| Tab | Switch focused pane (for scrolling) |
| Up / Down | Scroll focused pane by one line |
| Page Up / Page Down | Scroll focused pane by one page |
| Ctrl+L | Toggle horizontal / vertical layout |
| Ctrl+C | Graceful cancellation |

The layout automatically adapts to terminal height. When the
terminal is too short, the TUI progressively hides elements in
priority order: TokenBar first, then key hints, then pane
separators. If vertical layout cannot fit both panes, it falls back
to horizontal.

### Execution modes

- **auto** — Stages advance automatically. Loops run up to the
  configured iteration budget (default varies by stage — 5 for
  self-check and review, 3 for CI fix and test plan). When the
  budget is exhausted, the user is asked whether to continue.
  Approval grants another batch.
- **step** — The user confirms before entering each pipeline stage.
  Loops within a stage still run automatically up to the budget,
  same as auto mode.

### Resume

AgentCoop persists run state to
`~/.agentcoop/runs/{owner}/{repo}/{issueNumber}.json`. If
interrupted, re-running the same issue offers to resume from the
last completed stage or start fresh.

## How it works

AgentCoop runs an 8-stage pipeline with two agents: Agent A (author
— implements the issue) and Agent B (reviewer).

1. **Implement** — Agent A implements the issue in a git worktree
2. **Self-check** — Agent A self-checks against quality criteria
3. **Create PR** — Agent A opens a pull request
4. **CI check** — Wait for CI; agent fixes failures automatically
5. **Test plan** — Agent A verifies the PR test plan
6. **Review** — Agent B reviews; Agent A addresses feedback
   (multi-round)
7. **Squash** — Agent A consolidates branch commits into one or a
   few meaningful commits and force-pushes. Skipped if the branch
   already has only one commit or if the existing commits are
   already clean.
8. **Done** — Check for merge conflicts, optionally rebase, confirm
   merge with the user, and clean up resources

During the review stage, both agents communicate through PR
comments on GitHub. Since they share the same GitHub account,
comments are prefixed with round-tagged labels —
`[Reviewer Round N]` and `[Author Round N]` — so each agent can
identify which comments to read and respond to. This creates a
persistent, auditable review thread directly on the PR.

At the final stage, the orchestrator checks whether the PR can be
merged cleanly. If merge conflicts are detected, the user can choose
between an **agent rebase** (Agent A rebases the branch onto the
latest default branch, resolves conflicts, verifies locally, and
force-pushes) or **manual resolution**. Agent rebase is limited to
one attempt per run — if it fails, the user resolves manually. After
any resolution, CI is re-validated before the merge confirmation is
presented. Once the user confirms the PR has been merged, the
orchestrator stops any running services (e.g., Docker Compose),
deletes the git worktree and its branch, and ends the agent sessions.
See [Done stage details](docs/pipeline.md#stage-8-done) for the full
flow.

For detailed stage descriptions, exact prompts, and prompt design
rationale, see [docs/pipeline.md](docs/pipeline.md).

## Design philosophy

### Well-written issues as the contract

AgentCoop treats the GitHub issue as the single source of truth. It
assumes the issue is detailed, unambiguous, and defines the full scope
of work. The pipeline does not attempt to clarify vague requirements
or fill in missing context — it trusts the issue as-is and implements
exactly what it describes.

This is a deliberate choice: writing a clear issue is a prerequisite,
not an afterthought. A well-structured issue with acceptance criteria,
edge cases, and test expectations produces dramatically better results
than a vague one-liner. The quality of the output is bounded by the
quality of the input.

### Maximum code quality, not cost efficiency

The pipeline prioritizes production-quality output over token economy.
Agent A self-checks its implementation against a 7-point checklist, a
separate Agent B performs an independent code review, test plan items
are executed (not just listed), and the PR body is verified against
the implementation multiple times throughout the pipeline.

Each of these steps costs additional API calls. AgentCoop accepts
this trade-off because the goal is to produce code that is ready to
merge with minimal human review — not to minimize the number of
tokens consumed.

### Maximum permissions, zero approval prompts

Agents run with full filesystem and tool access:
`--permission-mode bypassPermissions` for Claude,
`--dangerously-bypass-approvals-and-sandbox` for Codex. There is no
interactive permission prompt flow.

This is necessary, not merely convenient. Agents run in
non-interactive mode with stdin closed — there is no human on the
other end to approve permission requests. A restricted permission
mode would silently skip operations (installing dependencies,
starting services, modifying files outside the worktree), producing
incomplete or broken results without any indication of what was
skipped.

Agents are instructed to start whatever external services the issue
or project requires — Docker Compose, databases, dev servers, message
brokers, browser automation — and run the full test suite against
them. If a port conflict occurs, the agent changes the port rather
than skipping the service. The goal is to exercise the implementation
as completely as possible, not to cut corners for speed.

### Repository-level agent configuration

AgentCoop does not inject `CLAUDE.md`, `AGENTS.md`, custom system
prompts, or skills into agent sessions. These are the repository's
responsibility.

When an agent CLI is launched from the worktree directory, it
automatically picks up whatever configuration the repository
provides — `CLAUDE.md`, `AGENTS.md`, `.claude/skills/`,
`.agents/skills/`, and so on. AgentCoop currently supports Claude
and Codex, and is designed to accommodate additional agent CLIs in
the future. This keeps AgentCoop generic: it orchestrates the
pipeline, while each repository controls its own agent behavior
through the configuration files that each CLI recognizes.

## Repository management

AgentCoop uses **bare clones** and **git worktrees** to isolate each
issue's work from the original repository.

On first run for a repository, AgentCoop creates a bare clone at
`~/.agentcoop/repos/{owner}/{repo}.git`. On subsequent runs it
fetches to keep the bare clone up to date. From this bare clone,
each issue gets its own git worktree at
`~/.agentcoop/worktrees/{owner}/{repo}/issue-{number}`, branched
from the latest remote default branch.

This design has two advantages:

- **No pollution.** The user's working copy is never touched. All
  agent work happens in an isolated worktree outside the repository,
  so there is no risk of interfering with the user's uncommitted
  changes, IDE state, or other branches.
- **Parallel safety.** Multiple issues can be worked on
  simultaneously because each gets its own worktree and branch. The
  bare clone serves as a shared, lockfile-protected reference that
  all worktrees branch from.

If a worktree for the same issue already exists, the user is prompted
to reuse it, clean up and recreate, or halt.

## Prerequisites

- Node.js 24+
- pnpm
- `claude` and/or `codex` CLI installed and authenticated
- `gh` CLI authenticated
- Any external services the agents use (e.g., Figma Desktop MCP)
  must be running and authenticated

## Installation & quick start

```bash
pnpm install
pnpm build
node dist/index.js
```

The interactive wizard walks you through:

1. Select a GitHub owner/organization
2. Select a repository
3. Enter the issue number
4. Choose Agent A and Agent B (CLI, model, context window, effort)
5. Select execution mode (auto / step)
6. Select language (en / ko)
7. Optionally adjust pipeline settings and notifications
8. Confirm the issue and start the pipeline

On subsequent runs, the wizard offers to reuse your previous agent
configuration.

## Configuration

Settings are stored in `~/.agentcoop/config.json`:

| Field | Description | Default |
| ----- | ----------- | ------- |
| `owners` | GitHub orgs/users to select from | _(first run)_ |
| `language` | UI language (`en` or `ko`) | `en` |
| `pipelineSettings.selfCheckAutoIterations` | Self-check budget | `5` |
| `pipelineSettings.reviewAutoRounds` | Review budget | `5` |
| `pipelineSettings.inactivityTimeoutMinutes` | Silence timeout | `20` |
| `pipelineSettings.autoResumeAttempts` | Max auto-resumes | `3` |
| `notifications.bell` | Terminal bell on input wait | `true` |
| `notifications.desktop` | Desktop notification | `false` |

Agent presets (CLI, model, context window, effort level) are also
saved per agent slot.

## Notifications

When the pipeline pauses for user input — a BLOCKED agent, an
exhausted loop budget, step-mode confirmation, merge confirmation,
or any other prompt — AgentCoop can alert the user via terminal
bell and/or desktop notification. This is useful when runs take
minutes or longer and the user has switched to another window.

### Trigger

Notifications fire every time the TUI enters input-wait state.
The notification message matches the prompt text shown in the
InputArea (e.g., "Agent is blocked: push rejected").

### Channels

| Channel | Setting | Default | Behavior |
| ------- | ------- | ------- | -------- |
| Terminal bell | `notifications.bell` | `true` | Emits `BEL` (`\x07`) to stdout. Most terminals flash the tab or play a sound. |
| Desktop | `notifications.desktop` | `false` | macOS: `osascript display notification`. Linux: `notify-send`. Silently ignored if the command is unavailable or no GUI session exists. |

Both channels can be toggled independently in
`~/.agentcoop/config.json` or through the startup wizard
("Optionally adjust pipeline settings and notifications").
Notification errors are always swallowed — they never block or
break the prompt flow.

## Documentation

- [Pipeline stages and prompt design](docs/pipeline.md) — detailed
  reference for each pipeline stage, exact prompt templates, and the
  design principles behind them.
