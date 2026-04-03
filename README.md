# AgentCoop

A multi-agent pipeline that takes a GitHub issue and autonomously implements, reviews, and merges the fix using two AI agents.

```
┌ Agent A (implementer) — claude-sonnet ─┬─ Agent B (reviewer) — claude-sonnet ┐
│                                        │                                     │
│ I'll start by reading the issue and    │ (waiting for output)                │
│ exploring the repository structure.    │                                     │
│                                        │                                     │
│ ╌╌╌╌╌╌╌╌╌ Prompt ╌╌╌╌╌╌╌╌╌           │                                     │
│ ▶ Implement the following GitHub       │                                     │
│ ▶ issue in a new git branch…           │                                     │
│ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌            │                                     │
│                                        │                                     │
├────────────────────────────────────────┴─────────────────────────────────────┤
│ owner/repo#42  |  Stage 1: Implement  |  Round: 1 (in progress)            │
├─────────────────────────────────────────────────────────────────────────────┤
│ Pipeline running...                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## How it works

AgentCoop drives an 8-stage pipeline with two agents — Agent A (implementer) and Agent B (reviewer):

1. **Implement** — Agent A implements the issue in an isolated git worktree
2. **Self-check** — Agent A reviews its own work against quality criteria
3. **Create PR** — Agent A opens a pull request
4. **CI check** — Wait for CI; the agent fixes failures automatically
5. **Test plan** — Agent A verifies the PR test plan
6. **Review** — Agent B reviews the PR; Agent A addresses feedback (multi-round)
7. **Squash** — Agent A squashes commits and verifies CI
8. **Done** — Merge the PR and clean up

Each stage loops automatically within a configurable iteration budget before asking for user input.

## Prerequisites

- [Node.js](https://nodejs.org/) 24.x
- [pnpm](https://pnpm.io/)
- [`claude`](https://docs.anthropic.com/en/docs/claude-code) and/or [`codex`](https://github.com/openai/codex) CLI installed
- [`gh`](https://cli.github.com/) CLI installed and authenticated (`gh auth login`)

## Installation & quick start

```bash
pnpm install
pnpm build
node dist/index.js
```

The interactive prompts walk you through:

1. Select a GitHub owner and repository
2. Pick an issue number
3. Choose agents and models for Agent A and Agent B
4. Select an execution mode (auto or step)

AgentCoop clones the repository, creates a worktree, and starts the pipeline.

## Configuration

Settings are stored in `~/.agentcoop/config.json`. Key options:

| Key | Description | Default |
|-----|-------------|---------|
| `owners` | Saved GitHub owner names | `[]` |
| `cloneBaseDir` | Base directory for cloned repos | `~/projects` |
| `language` | UI language (`en` or `ko`) | `en` |
| `pipelineSettings.selfCheckAutoIterations` | Auto-iterations for self-check | `3` |
| `pipelineSettings.reviewAutoRounds` | Auto-rounds for review | `3` |
| `pipelineSettings.inactivityTimeoutMinutes` | Agent inactivity timeout | `20` |
| `pipelineSettings.autoResumeAttempts` | Auto-resume attempts on agent crash | `3` |

Agent presets (`agentA`, `agentB`) save the last-used CLI, model, context window, and effort level so you don't have to re-enter them each run.

## Execution modes

- **auto** — Stages advance automatically within the configured iteration budget. Best for straightforward issues.
- **step** — Each stage waits for user confirmation before proceeding. Useful when you want to review progress at every step.

## Resume

AgentCoop persists run state per issue in `~/.agentcoop/runs/`. If a run is interrupted, re-running the same issue offers to resume from the last completed stage — including restoring agent sessions, PR number, and review round.
