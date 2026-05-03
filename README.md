# AgentCoop

An AI pipeline that takes a GitHub issue and autonomously implements,
reviews, and prepares it for merge. Rather than having a single agent
work longer on a large task, AgentCoop puts multiple agents through
the same quality process that human engineering teams rely on —
self-review, independent code review, and iterative feedback — to
maximize the implementation quality of each issue.

The current implementation uses two agents — one author and one
reviewer. A future version will expand to three agents (one author
and two reviewers).

No single agent session produces perfect code on the first try —
whether the task is a new feature, a bug fix, a refactor, or adding
tests and documentation. Self-check catches what the author missed,
an independent reviewer catches what self-check missed, and the
back-and-forth between them refines what remains. AgentCoop is built
on this premise — quality comes from the process, not from a more
capable model.

Break your project down into well-written issues, each scoped to a
single PR. AgentCoop works through them — implementing, reviewing,
and preparing merge-ready PRs — so the software gets built with
minimal human involvement.

## Terminal UI

```text
┌─ Agent A (author) — Claude Opus 4.7 (1M) / High v2.1.116 ● [*] ─┬─ Agent B (reviewer) — Codex GPT-5.5 / Extra High v0.122.0 ──────┐
│ ↑ 108 more lines                                                │ (idle — active in review stage)                                 │
│                                                                 │                                                                 │
│  (streamed output)                                              │  (streamed output)                                              │
│                                                                 │                                                                 │
├─────────────────────────────────────────────────────────────────┴─────────────────────────────────────────────────────────────────┤
│ A (Claude): 12.3K in / 5.1K out                                 │ B (Codex): 8.7K in / 3.2K out                                   │
├───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ owner/repo#42: Issue title                                                                                        4m 12s (7m 30s) │
│ Base: abc1234  │  Stage 3: Self-check (round 2)  │  Completed: self-check ×1, review ×0  │  Layout: horizontal                    │
│ ●:Active  [*]:Focused  Tab:Switch pane  ↑↓:Scroll  PgUp/Dn:Page scroll  Ctrl+L:Layout  Ctrl+C:Quit                                │
├───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Pipeline running...                                                                                                               │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Agent panes** — Streamed output from each agent in real time.
  The pane header shows the agent role, the CLI name (Claude / Codex),
  the model name with context-window label, the effort level, and the
  installed CLI version (detected at pipeline start). The active
  agent is marked with `●`, the focused pane (for scrolling) with
  `[*]`. When the focused pane is scrolled back, an `↑ N more lines`
  indicator appears at the top; a pane that is not yet active in the
  current stage shows an idle hint such as
  `(idle — active in review stage)`.
- **TokenBar** — Per-agent token usage (input/output, with cached
  token counts when available).
- **StatusBar** — Issue reference with elapsed time (active and
  wall-clock), base commit SHA, current pipeline stage with loop
  count, completed loop counts per loop type, and layout indicator.
  Active time pauses while waiting for user input.
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

AgentCoop runs a 9-stage pipeline with two agents: Agent A (author
— implements the issue) and Agent B (reviewer). Stages 2–9 run
inside the TUI; Stage 1 is orchestrator-managed and runs beforehand.

- **Stage 1 — Bootstrap:** Orchestrator-managed, runs before the TUI
  mounts. Bootstraps the repository (clone or fetch), detects the
  default branch via `gh repo view`, creates the author git worktree
  for this issue, and on resume promotes the starting stage past
  `Create PR` if a PR already exists so `gh pr create` is not
  replayed.
- **Stage 2 — Implement:** Agent A implements the issue in a git worktree
- **Stage 3 — Self-check:** Agent A self-checks against quality criteria
- **Stage 4 — Create PR:** Agent A opens a pull request
- **Stage 5 — CI check:** Wait for CI; on failure the agent receives
  bounded pointers (failing run/job IDs, check-run IDs, the ref) and
  reads the actual failure logs itself with `gh run view --log-failed`.
  If CI passes but check runs report annotations, the agent fetches
  the annotations and any code scanning alerts on demand and either
  fixes or triages them — never inlined into the prompt.
- **Stage 6 — Test plan:** Agent A verifies the PR test plan
- **Stage 7 — Review:** Agent B reviews; Agent A addresses feedback
  (multi-round)
- **Stage 8 — Squash:** Agent A decides whether the branch is best
  presented as several meaningful commits or a single squash.
  - _Multiple commits:_ Agent A rewrites history and force-pushes,
    then CI is re-polled.
  - _Single commit:_ Agent A does **not** force-push. It drafts the
    squash title and body and posts them as a PR comment. AgentCoop
    then asks the user how to apply the squash — _Agent squashes
    now_ (agent applies the drafted message and CI is re-polled) or
    _Apply via GitHub_ (the drafted message is surfaced on the
    Stage 9 merge-confirm screen so the user can paste it into
    GitHub's "Squash and merge" dialog).

  Skipped automatically if the branch already has only one commit.
- **Stage 9 — Done:** Check for merge conflicts, optionally rebase, confirm
  merge with the user, and clean up resources

During the review stage, both agents communicate through PR
comments on GitHub. Since they share the same GitHub account,
comments are prefixed with round-tagged labels so each agent can
identify which comments to read and respond to:

- `[Reviewer Round N]` — Agent B's review comment
- `[Author Round N]` — Agent A's response to feedback
- `[Review Verdict Round N: APPROVED|NOT_APPROVED]` — the
  orchestrator's machine-readable verdict marker (used for state
  reconciliation on resume)
- `[Reviewer Unresolved Round N]` — Agent B's summary of items
  that remain unresolved after the review loop ends

This creates a persistent, auditable review thread directly on
the PR.

At the final stage, the orchestrator checks whether the PR can be
merged cleanly. If merge conflicts are detected, the user can choose
between an **agent rebase** (Agent A rebases the branch onto the
latest default branch, resolves conflicts, verifies locally, and
force-pushes) or **manual resolution**. Agent rebase is limited to
one attempt per run when the agent completes or reports `BLOCKED`;
a bare agent process failure surfaces the error detail and leaves
the attempt budget intact so the user can retry. After any
resolution, CI is re-validated; whenever the post-rebase CI poll
cannot proceed — fix budget exhausted, pending timeout, or an agent
error during findings review or fix — the user is asked whether to
keep trying (timeout resumes polling; agent-error retries the same
step; exhaustion resets the fix counter) before cleanup runs, so
none of those branches can silently end the session.
Once the user confirms the PR has been merged, the orchestrator
stops any running services (e.g., Docker Compose), deletes the author
git worktree, its branch, and the detached reviewer worktree, and
ends the agent sessions.  See
[Done stage details](docs/pipeline.md#stage-9-done) for the full
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
Agent A self-checks its implementation against an 8-point checklist, a
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
`-s danger-full-access` for Codex. There is no
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
each issue gets an author git worktree at
`~/.agentcoop/worktrees/{owner}/{repo}/issue-{number}`, branched
from the latest remote default branch.

During the review stage, Agent B uses a separate detached reviewer
worktree at
`~/.agentcoop/worktrees/{owner}/{repo}/issue-{number}-review`. The
reviewer worktree is refreshed from `origin/{authorBranch}` before
reviewer activity, so Agent B reviews the pushed PR branch without
sharing Agent A's editable checkout.

This design has two advantages:

- **No pollution.** The user's working copy is never touched. All
  agent work happens in isolated worktrees outside the repository,
  so there is no risk of interfering with the user's uncommitted
  changes, IDE state, or other branches. Reviewer-side changes are
  cleaned from the detached reviewer worktree and cannot contaminate
  the author worktree.
- **Parallel safety.** Multiple issues can be worked on
  simultaneously because each gets its own worktree and branch. The
  bare clone serves as a shared, lockfile-protected reference that
  all worktrees branch from.

If a worktree for the same issue already exists, the user is prompted
to reuse it, clean up and recreate, or halt.

## Prerequisites

- Node.js 24.x
- pnpm
- `claude` and/or `codex` CLI installed and authenticated
- `gh` CLI authenticated
- Any external services the agents use (e.g., Figma Desktop MCP)
  must be running and authenticated

### CLI update check

At startup (after the agents for this run are known) AgentCoop runs
`claude --version` / `codex --version` and compares the installed
version against the latest release from the channel-appropriate
source. Claude always uses the npm registry
(`@anthropic-ai/claude-code`). Codex's channel is resolved from the
installed binary's realpath: npm global prefix, Homebrew formula
(`Cellar/codex/`), Homebrew cask (`Caskroom/codex/`), or a standalone
install rooted at `~/.codex/` — specifically `~/.codex/bin/`,
`~/.codex/versions/<ver>/`, or the current
`~/.codex/packages/standalone/releases/` layout. Homebrew matches are
anchored on the `codex` package segment and root-anchored on the
Homebrew prefixes (`/opt/homebrew/`, `/usr/local/`,
`/home/linuxbrew/.linuxbrew/`), so
a custom wrapper formula or cask (e.g. `Cellar/my-codex-wrapper/…`,
`Caskroom/custom-codex/…`) and a copied tree under a non-Homebrew
root (e.g. `/tmp/opt/homebrew/Cellar/codex/…`,
`/Users/me/sandbox/usr/local/Caskroom/codex/…`) are not misclassified
as the official `codex` package. Only the known
subpaths under the running user's home directory are accepted as a
standalone install; an unrecognized subpath inside `~/.codex/` (e.g.
`~/.codex/tools/codex`) or any `.codex` directory outside `$HOME`
(e.g. `/tmp/.codex/…`) is treated as inconclusive and the check is
skipped rather than guessed.
Likewise, a raw `Applications/` path that did not resolve through
`realpath` into a Caskroom directory is treated as inconclusive rather
than guessed as a cask, so a hand-placed `~/Applications/Codex.app/…`
or `/tmp/Applications/codex` never produces a bogus update prompt.

If the installed version is older, AgentCoop prompts to update and
pauses until you press Enter so you can run your package manager in
another tab. On return it re-runs `--version` and either proceeds, or
— if the version is unchanged — offers retry / skip / abort.

Skip the check in CI or offline environments by setting
`skipVersionCheck: true` in `~/.agentcoop/config.json`. The check is
also throttled to once per 24h via the `lastVersionCheckAt`
timestamp. That timestamp only advances after at least one CLI
reached a real installed-vs-latest comparison — a run where every
channel was inconclusive, or where the registry fetch failed, will
re-check on the next start rather than being silently throttled
for 24h. Network failures are logged but never fatal.

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
| `pipelineSettings.ciCheckAutoIterations` | CI check fix-attempt budget | `3` |
| `pipelineSettings.ciCheckTimeoutMinutes` | CI poll timeout | `10` |
| `pipelineSettings.inactivityTimeoutMinutes` | Silence timeout | `20` |
| `pipelineSettings.autoResumeAttempts` | Max auto-resumes | `3` |
| `notifications.bell` | Terminal bell on input wait | `true` |
| `notifications.desktop` | Desktop notification | `false` |
| `customModels.claude` | Extra Claude model entries | _(none)_ |
| `customModels.codex` | Extra Codex/GPT model entries | _(none)_ |
| `lastKnownVersions.claude` | Most recent `claude --version` output | _(first run)_ |
| `lastKnownVersions.codex` | Most recent `codex --version` output | _(first run)_ |
| `skipVersionCheck` | Skip the startup update check | `false` |
| `lastVersionCheckAt` | Epoch ms of the last check (throttle) | _(first run)_ |

Agent presets (CLI, model, context window, effort level) are also
saved per agent slot.

**Custom models**: During agent setup, choose "Enter custom model..."
to register a model not in the default list. You are prompted for a
model identifier (the `--model` CLI argument) and an optional display
name. The entry is saved under `customModels` and appears in the
model picker on subsequent runs. Default models are defined in
`models.json` at the repository root.

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
| Desktop | `notifications.desktop` | `false` | macOS: terminal-aware dispatch (cmux CLI, iTerm2 OSC 9, tmux DCS passthrough, osascript fallback). Linux: `notify-send`. Silently ignored if the command is unavailable or no GUI session exists. |

Both channels can be toggled independently in
`~/.agentcoop/config.json` or through the startup wizard
("Optionally adjust pipeline settings and notifications").
Notification errors are always swallowed — they never block or
break the prompt flow.

## Documentation

- [Pipeline stages and prompt design](docs/pipeline.md) — detailed
  reference for each pipeline stage, exact prompt templates, and the
  design principles behind them.
