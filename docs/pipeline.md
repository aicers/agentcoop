# Pipeline stages and prompt design

This document describes each pipeline stage in detail, including
the exact prompt templates sent to agents, completion contracts,
and loop behavior. For a high-level overview of AgentCoop, see
the [README](../README.md).

## Table of contents

- [Pipeline overview](#pipeline-overview)
- [Prompt design principles](#prompt-design-principles)
  - [Self-contained context](#self-contained-context-with-resume-form-compaction)
  - [Two-step verdict pattern](#two-step-verdict-pattern)
  - [No confirmation requests](#no-confirmation-requests)
  - [Service-aware instructions](#service-aware-instructions)
  - [PR body as living documentation](#pr-body-as-living-documentation)
  - [Issue-implementation reconciliation](#issue-implementation-reconciliation)
  - [Additional feedback injection](#additional-feedback-injection)
  - [Ambiguous response clarification](#ambiguous-response-clarification)
- [Stage reference](#stage-reference)
  - [Stage 1: Bootstrap](#stage-1-bootstrap)
  - [Stage 2: Implement](#stage-2-implement)
  - [Stage 3: Self-check loop](#stage-3-self-check-loop)
  - [Stage 4: Create PR](#stage-4-create-pr)
  - [Stage 5: CI check loop](#stage-5-ci-check-loop)
  - [Stage 6: Test plan verification loop](#stage-6-test-plan-verification-loop)
  - [Stage 7: Review loop](#stage-7-review-loop)
  - [Stage 8: Squash commits](#stage-8-squash-commits)
  - [Stage 9: Done](#stage-9-done)
- [Orchestrator-managed operations](#orchestrator-managed-operations)

## Pipeline overview

```text
Bootstrap -> Implement -> Self-check -> Create PR -> CI check
  (orch)       (A)        (A, loop)       (A)       (A, loop)

  -> Test plan -> Review -> Squash -> Done
     (A, loop)  (B<->A, loop) (A)    (user)
```

Stage 1 (Bootstrap) is orchestrator-managed and runs before the TUI
mounts; see [Stage 1: Bootstrap](#stage-1-bootstrap) below.

Agent A is the author (implements the issue). Agent B is the
reviewer. The orchestrator manages transitions, CI polling, and
user interaction.

## Prompt design principles

### Self-contained context (with resume-form compaction)

Every stage's first work prompt includes the complete issue body
plus whatever repository details that stage actually needs, so the
agent never has to search for context. To avoid retransmitting the
same header and issue body on every stage transition, the
orchestrator keeps each agent's CLI session alive across stages
and sends a compact **resume-form** prompt when a saved session id
is available:

- **Fresh form** — the full prompt with the issue body, the
  stage's required repository details (see the `Owner` / `Repo` /
  `Branch` rule below), and stage instructions. Sent on the very
  first stage entry (cold start) and as a fallback when the resume
  helper has to fall back to a fresh `invoke` because the saved
  session expired.
- **Resume form** — drops the issue body and any repo header,
  keeping only stage-specific instructions and a one-line
  `issue #N` reference. Sent whenever a saved session id is
  available.

`invokeOrResume` accepts an optional `fallbackPrompt` parameter
(via an options object) so the call site can supply both forms.
When the resume succeeds, the compact prompt is sent; if the
resume falls back to a fresh invoke, the helper sends
`fallbackPrompt` instead and emits a second prompt-sink event so
diagnostic streams reflect the prompt actually sent.

The shared `pollCiAndFix` helper (used by Stage 5, the post-review
CI fix in Stage 7, and the post-squash CI fix in Stage 8) is also
threaded through `invokeOrResume`. It reads the current Agent A
session id from `StageContext` (or, when the caller has just
obtained a newer session id in the same handler invocation, from
the optional `initialAgentASessionId` option — Stage 7 hands in
the author-fix/completion-check session id, Stage 8 hands in the
verdict / clarification / agent-squash follow-up session id),
sends the compact `buildCiFindingsResumePrompt` /
`buildCiFixResumePrompt` on the live session, and falls back to
the fresh `buildCiFindingsPrompt` / `buildCiFixPrompt` only when
the helper has to fresh-invoke. Across multiple iterations of the
fix loop, the helper tracks the latest session id locally so each
turn resumes the most recent session.

The `Worktree:` line is no longer included in any stage prompt:
the agent's working directory is already set to the worktree, so
the line was informational noise. `Owner` / `Repo` / `Branch` are
retained only where they are interpolated into command examples
or API URLs (e.g. the CodeQL dismiss block in Stage 5); elsewhere
the agent uses `gh` against the current repo and `gh` auto-detects
the repo from the cwd's git remote.

### Two-step verdict pattern

Every stage that needs to determine an outcome follows a consistent
two-step pattern:

1. **Work step** — the agent performs its task and responds freely.
   This response is **not** parsed for keywords.
2. **Verdict follow-up** — a dedicated follow-up prompt asks for
   **only** the verdict keyword.  The keyword is parsed from this
   constrained response.

Each verdict call site declares its valid keywords and passes them
to a strict verdict parser (`parseVerdictKeyword`).  The parser
requires the response to be essentially just the keyword — it
rejects responses with extra commentary, multiple valid keywords,
or out-of-scope keywords.  When the parser rejects a response, a
single clarification retry is attempted listing only the valid
keywords for that substep.

The canonical verdict prompt template (compact, two lines):

```text
Reply with exactly one keyword (no commentary):
KEYWORD_A if <when to use>,
KEYWORD_B if <when to use>.
```

#### Keyword contracts per substep

| Substep | Valid keywords | Proceed | Loop/Retry |
| ------- | -------------- | ------- | ---------- |
| Implementation check | `COMPLETED` / `BLOCKED` | `COMPLETED` | `BLOCKED` → user chooses |
| Self-check verdict | `FIXED` / `DONE` | `DONE` | `FIXED` → repeat |
| Test plan verdict | `FIXED` / `DONE` | `DONE` | `FIXED` → repeat |
| PR creation check | `COMPLETED` / `BLOCKED` | `COMPLETED` | `BLOCKED` → user chooses |
| CI findings review | _(no verdict keyword)_ | SHA unchanged | SHA changed → re-poll CI |
| Squash check | `SQUASHED_MULTI` / `SUGGESTED_SINGLE` / `BLOCKED` | `SQUASHED_MULTI` (CI poll), `SUGGESTED_SINGLE` (user choice) | `BLOCKED` → user chooses |
| Reviewer verdict | `APPROVED` / `NOT_APPROVED` | `APPROVED` | `NOT_APPROVED` → repeat |
| Author completion | `COMPLETED` / `BLOCKED` | `COMPLETED` | `BLOCKED` → user chooses |
| Unresolved summary | `NONE` / `COMPLETED` | either | — |
| PR finalization | `PR_FINALIZED` | `PR_FINALIZED` | missing → clarification → PR body consistency check → blocked |
| Issue sync | `ISSUE_NO_CHANGES` / `ISSUE_UPDATED` / `ISSUE_COMMENTED` | any | clarification retry; best-effort |
| Rebase verdict | `COMPLETED` / `BLOCKED` | `COMPLETED` | `BLOCKED` → manual |

### No confirmation requests

Prompts instruct agents to proceed directly without asking "Shall
I continue?" or "Is this approach okay?". There is no human on
the other end — agents run non-interactively with stdin closed.
Genuine blockers are reported via the `BLOCKED` keyword and routed
to the user by the orchestrator.

### Service-aware instructions

Prompts explicitly tell agents to start external services
(databases, dev servers, message brokers) using whatever tools
the project provides (Docker Compose, setup scripts, etc.) rather
than skip tests that depend on them. This prevents the common
failure mode where agents report "all tests pass" after silently
skipping integration tests. If a port conflict occurs, the agent
is told to change the port rather than skip the service.

### PR body as living documentation

Multiple stages — CI fix, review response, squash, and PR
finalization — include instructions to verify and update the PR
description before pushing. The PR body is treated as a living
document that must accurately reflect the current state of the
implementation at all times, not just at creation time.

The standard PR sync instructions appear in stages 5 through 8:

> Before pushing, check whether the PR description still
> accurately reflects the current code changes. Run
> `gh pr view --json body --jq .body` to read the current
> description, then compare it against what the branch actually
> does. If the description is outdated or inaccurate, update it
> using `gh pr edit --body "..."`. Keep the issue reference
> (Closes #N or Part of #N) in the body.

The squash stage extends this contract with a marker-delimited
**squash suggestion block**.  When a single commit is the right
shape for the branch, the agent drafts the proposed title and body
inside a `<<<TITLE>>>` / `<<<BODY>>>` envelope in its reply, and
agentcoop authors the marker-delimited PR comment
(`<!-- agentcoop:squash-suggestion:start -->` …
`<!-- agentcoop:squash-suggestion:end -->`) from those fields
deterministically — fence sizing, marker placement, and idempotent
PATCH/POST bookkeeping are all owned by the code, not the agent.
Re-runs PATCH any prior squash-suggestion comment rather than
appending a new one so the timeline stays close to the "Squash and
merge" dropdown.  The Stage 9 merge-confirm screen reads this block
back so the user can apply the message via GitHub's "Squash and
merge" without opening the browser.

### Issue-implementation reconciliation

After self-check completes, an issue sync step compares the actual
implementation against the original issue description and either
updates the issue (minor discrepancies like typos or clarified
wording) or leaves a comment (major discrepancies like scope
changes). This keeps the issue in sync with what was actually
built, so the issue remains a reliable reference after the PR is
merged.

### Additional feedback injection

Several stage prompts can include a `## Additional feedback`
section appended to the base prompt. This section is populated
through three specific orchestrator paths — it is not injected
at arbitrary times.

1. **`not_approved` outcome** — When a loop stage (e.g., review)
   returns `NOT_APPROVED`, the handler's message becomes the next
   iteration's feedback. This is agent-originated: for example,
   Agent B's review comments are forwarded to Agent A as
   `## Additional feedback` in the next author-fix prompt. The
   user is not involved.

2. **`blocked` → user selects Instruct** — When a stage returns
   `BLOCKED`, the orchestrator presents the user with three
   options: Proceed, Instruct, or Halt. If the user chooses
   **Instruct** and types a message, that text is injected as
   `## Additional feedback` on the next iteration.

3. **`needs_clarification` outcome** — When the orchestrator
   cannot parse a clear keyword from the agent's response, it
   first auto-retries with a
   [clarification prompt](#ambiguous-response-clarification).
   If the second attempt also fails, the user is asked via the
   same Instruct mechanism as path 2 above.

### Ambiguous response clarification

When a verdict follow-up does not contain a recognized keyword, the
orchestrator sends a **substep-scoped** clarification prompt listing
only the keywords valid for that specific substep.  This is used in
two contexts:

- **Within-stage session resume** (all stages with verdict
  follow-ups) — the orchestrator resumes the existing agent
  session with the scoped clarification prompt.  If the retry
  also returns an ambiguous response, the stage uses a
  **conservative fallback** instead of bubbling
  `needs_clarification` to the pipeline engine (which would
  re-run side-effectful work steps or route the clarification
  to the wrong agent in multi-agent stages).  The fallback
  depends on the substep's keyword contract:
  - _FIXED / DONE_ loops (self-check, test-plan): `not_approved`
    — the pipeline loops the stage again.
  - _COMPLETED / BLOCKED_ substeps (implement, author
    completion, create-pr, squash): `blocked` — the user is
    asked how to proceed.
- **Pipeline loop injection** — used only when the ambiguous
  verdict comes from the agent that receives `userInstruction`
  on the next iteration (e.g. the reviewer verdict in the
  review stage).  `StageResult.validVerdicts` carries the
  keyword set from the stage handler to the pipeline engine.

When `validVerdicts` is provided, the clarification prompt is a
single line listing only the in-scope keywords:

```text
Reply with exactly one keyword (no commentary): KEYWORD_A, KEYWORD_B.
```

When no `validVerdicts` are set (legacy fallback), all six keywords
are listed:

```text
Reply with exactly one keyword (no commentary): COMPLETED, FIXED, DONE, APPROVED, NOT_APPROVED, BLOCKED.
```

## Stage reference

### Stage 1: Bootstrap

**Agent:** none (orchestrator-managed)\
**Purpose:** Prepare the repository, default branch, and author
worktree so later stages can run against a known-good local checkout.

Stage 1 runs synchronously before the ink TUI mounts.  It performs:

- **Repository bootstrap:** If the repository is not cloned under
  `cloneBaseDir/{owner}/{repo}`, clone it. If already cloned, fetch
  the latest remote state. If a worktree for the same branch already
  exists, prompt the user to reuse, clean up, or halt.
- **Default branch detection:** Query via
  `gh repo view {owner}/{repo} --json defaultBranchRef` instead of
  assuming `main`.
- **Author worktree creation:** Create a git worktree from the latest
  remote default branch at
  `~/.agentcoop/worktrees/{owner}/{repo}/issue-{number}`, outside the
  repository to avoid pollution.
- **Reviewer worktree path:** Record the deterministic detached
  reviewer worktree path at
  `~/.agentcoop/worktrees/{owner}/{repo}/issue-{number}-review`.
  The reviewer worktree is created or refreshed later, immediately
  before Agent B reviewer activity.
- **Resume pre-flight:** On resume, if `startFromStage === 4` and a PR
  already exists, promote the starting stage to 5 (CI check) so the
  side-effectful `gh pr create` is not replayed.

Because Stage 1 completes before the TUI mounts, it is surfaced
retrospectively.  The `StatusBar` shows `Stage 1: Bootstrap
\u2192 Stage N: <name>` briefly on first render, and both agent panes
prepend a Stage 1 enter divider, the buffered bootstrap log lines, and
a Stage 1 \u2192 Stage N transition divider before live output begins.

### Stage 2: Implement

**Agent:** A\
**Purpose:** Implement the changes described in the GitHub issue.

**Prompt:**

```text
You are implementing a solution for the following GitHub issue.

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}

## Issue #{number}: {title}

{issue_body}

## Instructions

Implement the changes required to resolve this issue.  The current
working directory is a worktree freshly based on the latest
remote default branch, so you are working on top of the most recent
upstream state.  Make sure the code compiles and any existing tests
still pass.

If the project uses external services (databases, message brokers,
dev servers, etc.), start them using whatever tools the project
provides (Docker Compose, `pnpm dev`, setup scripts, etc.) and run
the full test suite against them.  If a port conflict occurs, change
the port rather than skipping the service.
```

A `## Additional feedback` section may be appended to this
prompt through any of the
[injection paths](#additional-feedback-injection) described
above.

**Completion check:**

```text
Reply with exactly one keyword (no commentary):
COMPLETED if the implementation is finished and working,
BLOCKED if you cannot proceed and need user intervention.
```

**Outcome handling:**

- `COMPLETED` -> proceed to self-check.
- `BLOCKED` -> show Agent A's response to the user. Options:
  **Proceed** (continue as-is), **Instruct** (provide feedback),
  **Halt** (stop pipeline).

---

### Stage 3: Self-check loop

**Agent:** A\
**Purpose:** Review the implementation against quality criteria.
Fix issues iteratively until the agent is satisfied.

**Self-check prompt:**

```text
You are reviewing the implementation for the following GitHub issue.

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}

## Issue #{number}: {title}

{issue_body}

## Self-check

Review the current implementation against all 8 items below.  For each
item, briefly note whether it passes or needs attention.

1. **Correctness** — Does the implementation fully address the issue?
2. **Tests** — Are there thorough tests covering happy paths,
   edge cases, and error scenarios, including E2E tests where
   applicable?  If any meaningful scenario is untested, write
   the missing tests.  Then run the full test suite and verify all tests pass.
   If tests require services (databases, message brokers, dev
   servers, etc.), start them using whatever tools the project
   provides (Docker Compose, `pnpm dev`, setup scripts, etc.).
   If a port conflict occurs, change the port rather than skipping
   the service.
3. **Error handling** — Are errors handled gracefully?
4. **External services** — Are API calls, network requests, or external
   service integrations correct and resilient?  Start all required
   services and run integration tests against them rather than skipping
   tests that need external services.
5. **Documentation consistency** — Are all forms of project
   documentation consistent with the code changes?

   If your changes affect documentation, update it accordingly —
   code comments, inline API docs (JSDoc/TSDoc/docstrings), README
   files, CHANGELOG entries, and any user-facing manuals, guides,
   or tutorials the project maintains.  If the project uses a
   documentation site generator (MkDocs/Sphinx/Docusaurus/mdBook/
   etc.), update the corresponding source pages — not just the
   README.  If the project keeps a CHANGELOG (e.g. Keep a Changelog
   format), add an appropriate entry.

   If a manual or documentation site page requires a screenshot,
   capture a real one by starting the application and opening a
   browser — do not use placeholders.  If your code changes
   affect the visual output shown in existing manual screenshots,
   retake them as part of the doc update.
6. **Security** — Are there any security concerns (injection, auth,
   secrets exposure)?
7. **Performance** — Are there obvious performance issues or regressions?
8. **Code quality** — Is the new or modified code clean and
   maintainable?  If you spot opportunities to simplify, improve,
   or refactor the code *within the scope of this change*, apply
   them.  Do not refactor unrelated existing code.
```

**Fix-or-done work prompt:**

```text
Based on your self-check above, decide what to do next.

- If you found issues that need fixing, fix them now.
- If everything looks good and no changes are needed, you are done.
```

**Fix-or-done verdict follow-up:**

```text
Reply with exactly one keyword (no commentary):
FIXED if you found and fixed issues,
DONE if everything looks good and no changes were needed.
```

**Loop behavior:** `FIXED` → repeat self-check. `DONE` → run
issue sync, then proceed. Default auto-budget: 5 iterations
(configurable via `selfCheckAutoIterations`). When the budget is
exhausted, the user is asked whether to continue.

#### Issue sync sub-step

Runs once after the self-check loop ends with `DONE`.

```text
You have completed the self-check.  Now compare the actual
implementation against the original issue description below.

## Issue #{number}: {title}

{issue_body}

## Instructions

1. Review the implementation in the worktree and compare it against
   the issue description above.
2. Determine if there are any discrepancies between what was
   implemented and what the issue describes.
3. For **minor discrepancies** (typos, corrected file paths,
   clarified wording, added details): update the issue description
   directly using:
   `gh issue edit {number} --repo {owner}/{repo} --body-file <(cat <<'ISSUE_BODY'
   <new body here>
   ISSUE_BODY
   )`
4. For **major discrepancies** (scope change, different approach,
   modified requirements): leave a comment on the issue using:
   `gh issue comment {number} --repo {owner}/{repo} --body "..."`
   Do NOT modify the issue description for major changes.
5. If there are no discrepancies, do nothing.
```

**Issue sync verdict follow-up:**

```text
Report what issue sync actions you performed.
Respond with one or more of the following on separate lines:

- ISSUE_NO_CHANGES — if no changes were needed
- ISSUE_UPDATED: <brief description> — if you updated the issue
- ISSUE_COMMENTED: <brief description> — if you added a comment

Do not include any other commentary.
```

The verdict response is strictly parsed: every non-blank line must
match one of the recognised keyword patterns.  If the response
contains extra commentary, missing colons, or unrecognised lines,
a single clarification retry is attempted.  Issue sync is
best-effort — if the verdict is still malformed after the retry,
or if any step fails, the pipeline continues.

---

### Stage 4: Create PR

**Agent:** A\
**Purpose:** Create a pull request from the implementation branch.

**Prompt:**

```text
You are creating a pull request for the following GitHub issue.

## Issue #{number}: {title}

{issue_body}

## Instructions

1. Commit any remaining uncommitted changes on the branch.
2. Push the branch to the remote.
3. Create a pull request using `gh pr create` targeting the default
   branch.  The PR title should reference the issue number
   (e.g. "Fix widget rendering (#42)").
4. In the PR body, include:
   - A brief summary of the changes
   - If this PR fully resolves the issue, include "Closes #{number}"
     in the description. If it only partially addresses it,
     use "Part of #{number}" instead and add a
     "## Not addressed" section listing which issue requirements
     were not implemented and why.
   - A "## Test plan" section with a checkbox checklist of items to
     verify (derived from the issue requirements)
5. Do NOT merge the PR — just create it.
```

**Completion check:**

```text
Reply with exactly one keyword (no commentary):
COMPLETED if the pull request was created successfully,
BLOCKED if you could not create the PR and need user intervention.
```

**Ambiguous response handling:** If the completion check response
does not clearly match `COMPLETED` or `BLOCKED`, the orchestrator
resumes the same session with a clarification prompt (rather than
re-running the PR creation step, which would be side-effectful).
If clarification also fails, the handler performs a post-condition
check using `findPrNumber` to verify whether a PR was actually
created.  If the PR exists, the stage completes; otherwise it
reports `BLOCKED`.

**Outcome handling:** PR creation is a required step
(`requiresArtifact: true`). If `BLOCKED`, only **Instruct** and
**Halt** are offered — **Proceed** is not available because
subsequent stages depend on the PR.

---

### Stage 5: CI check loop

**Agent:** A (only on failure or findings review)\
**Purpose:** Wait for CI to pass. If CI fails, build a bounded
pointer-based inspection context (failing run/job IDs, check-run
IDs, the commit SHA, and incomplete-metadata flags) and send it to
Agent A so the agent can fetch the failure logs itself. If CI passes
but check runs report findings (annotations), pass the same pointer
context to Agent A for review — the agent reads annotation bodies
and code scanning alerts on demand rather than receiving them
inlined.

The orchestrator polls CI status at 30-second intervals. The CI
verdict includes both **workflow runs** (Actions API) and **check
runs** (Checks API). A run's `source` field (`"workflow"` or
`"check"`) is preserved on the bounded inspection context that the
agent uses to fetch logs and annotations on demand. While CI is
pending, the handler waits internally without consuming the loop
budget.

When CI passes and no check run reports annotations, the stage
completes immediately.

**Read-side delegation:** Failure logs, annotation bodies, and
code scanning alert payloads are **not** pre-fetched and inlined
into the CI prompts.  A 27,000-line failure log easily overflowed
the model context window when inlined; instead the orchestrator
emits a small `CiInspectionContext` (failing run/job IDs, check-run
IDs, an `annotationsIncomplete` flag, and the ref) and the agent
fetches the relevant content itself with `gh`.

**CI fix prompt** (sent only when CI fails):

```text
You are fixing CI failures for the following GitHub issue.

## Issue #{number}: {title}

{issue_body}

## CI Inspection Context

Repository: {owner}/{repo}
Branch: {branch}
ref: {sha-or-branch}
hasAnnotations: {true|false}
annotationsIncomplete: {true|false}

Failing workflow runs:
- runId: {runId}
  failedJobs:
    - {jobId} "{jobName}"

Check runs to inspect:
- {checkRunId}

## Fetching CI details

Failure logs, annotation bodies, and code scanning alert payloads
are **not** inlined here — fetch them yourself with `gh` as you
narrow down the failure.  Useful commands:

    gh run view <runId> --repo {owner}/{repo} --log-failed --job <jobId>
    gh run view <runId> --repo {owner}/{repo} --log-failed
    gh api "repos/{owner}/{repo}/check-runs/<checkRunId>"
    gh api "repos/{owner}/{repo}/check-runs/<checkRunId>/annotations"
    gh api "repos/{owner}/{repo}/code-scanning/alerts?ref={branch}&state=open&per_page=100"

The code-scanning `ref` filter takes a Git ref (a branch ref or
PR merge ref) — _not_ a commit SHA — so the hint uses `{branch}`,
not `inspection.ref`.

When `annotationsIncomplete: true`, the prompt also includes
pagination hints so the agent can recover regardless of which
listing was truncated:

    gh api "repos/{owner}/{repo}/actions/runs/<runId>/jobs?per_page=100&page=<n>"
    gh api "repos/{owner}/{repo}/actions/runs?branch={branch}&per_page=100&page=<n>"
    gh api "repos/{owner}/{repo}/actions/runs?head_sha=<commit-sha>&per_page=100&page=<n>"
    gh api "repos/{owner}/{repo}/commits/{ref}/check-runs?per_page=100&page=<n>"

## Instructions

Use the pointers above and the `gh` commands to read the actual
failure context, diagnose the failures, and fix them.  After making
your changes:

If your changes affect documentation, update it accordingly —
code comments, inline API docs (JSDoc/TSDoc/docstrings), README
files, CHANGELOG entries, and any user-facing manuals, guides,
or tutorials the project maintains.  If the project uses a
documentation site generator (MkDocs/Sphinx/Docusaurus/mdBook/
etc.), update the corresponding source pages — not just the
README.  If the project keeps a CHANGELOG (e.g. Keep a Changelog
format), add an appropriate entry.

If a manual or documentation site page requires a screenshot,
capture a real one by starting the application and opening a
browser — do not use placeholders.  If your code changes
affect the visual output shown in existing manual screenshots,
retake them as part of the doc update.

Before pushing, check whether the PR description still accurately
reflects the current code changes.  Run
`gh pr view --json body --jq .body` to read the current
description, then compare it against what the branch actually does.
If the description is outdated or inaccurate, update it using
`gh pr edit --body "..."`.  Keep the issue reference
(Closes #{number} or Part of #{number}) in the body.

Then commit and push the branch so a new CI run is triggered.
```

**Loop behavior:** Each CI failure consumes one iteration from the
auto-budget (default: 3, configurable via `ciCheckAutoIterations`).
The stage polls for CI completion up to a configurable timeout
(default: 10 minutes, configurable via `ciCheckTimeoutMinutes`).
When the budget is exhausted, the user is asked whether to continue.

#### CI findings review

When CI passes but at least one check run carries **annotations**
(e.g., lint warnings, CodeQL alerts), the orchestrator enters a
findings-review sub-path instead of completing immediately.  As on
the failure path, annotation bodies and code scanning alert payloads
are **not** inlined — Agent A receives the same pointer-only
`CiInspectionContext` and fetches the actual content itself with
`gh`.

**Findings-review prompt:**

````text
CI passed but check runs reported annotations.  Inspect them
yourself and decide whether any should be addressed.

## Issue #{number}: {title}

{issue_body}

## CI Inspection Context

Repository: {owner}/{repo}
Branch: {branch}
ref: {sha-or-branch}
hasAnnotations: true
annotationsIncomplete: {true|false}

Check runs to inspect:
- {checkRunId}

## Fetching CI details

Annotations and alert details are not inlined — fetch them with
`gh`:

    gh api "repos/{owner}/{repo}/check-runs/<checkRunId>"
    gh api "repos/{owner}/{repo}/check-runs/<checkRunId>/annotations"
    gh api "repos/{owner}/{repo}/code-scanning/alerts?ref={branch}&state=open&per_page=100"

(Code scanning's `ref` filter takes a Git ref — branch or PR
merge ref — not a commit SHA, so the hint uses `{branch}`, not
`inspection.ref`.)

When `annotationsIncomplete: true`, the prompt also includes
pagination hints (jobs / workflow-run list / check-runs listing) —
particularly important when `checkRunIds` is empty, which happens
when the upstream check-runs page was truncated and the visible
runs carry no annotations.

## Triage of code scanning alerts

Some annotations may correspond to open code scanning alerts.
Fetch the alerts list for the ref above, then for each alert decide
whether it is a **real issue** or a **false positive**.

### Evaluation criteria

A finding is a **real issue** when:
- The flagged code path is reachable in production.
- An attacker-controlled or untrusted input can reach the sink
  without adequate sanitisation or validation.
- The reported weakness (e.g. SQL injection, XSS, path traversal)
  is exploitable given the application's threat model.

A finding is a **false positive** when:
- The data is already sanitised or validated before it reaches the
  flagged location, but the analyser cannot see through the
  sanitiser.
- The flagged code is dead, test-only, or unreachable in production.
- The "source" is not actually attacker-controlled (e.g. a hardcoded
  constant, an environment variable set at deploy time).
- The framework or library provides built-in protection that makes
  the flagged pattern safe (e.g. parameterised queries).

### Actions

- **Real issue:** Fix the code.  After fixing, commit and push.
- **False positive:** For each false-positive alert, dismiss it via
  the API:

  ```
  gh api -X PATCH "repos/{owner}/{repo}/code-scanning/alerts/{number}" \
    -f state=dismissed \
    -f "dismissed_reason=false positive" \
    -f "dismissed_comment={your brief explanation}"
  ```

  Then leave one PR comment summarising all dismissed alerts and
  the reasoning for each.  First, find the PR number:

  ```
  gh pr view --repo {owner}/{repo} {branch} --json number --jq .number
  ```

  Then post the comment:

  ```
  gh pr comment --repo {owner}/{repo} <pr_number> --body "..."
  ```

## Instructions

Read the annotations and any code scanning alerts via the `gh`
commands above.  For each finding, decide whether it should be
fixed or can be safely ignored.  If you fix any findings:

If your changes affect documentation, update it accordingly —
code comments, inline API docs (JSDoc/TSDoc/docstrings), README
files, CHANGELOG entries, and any user-facing manuals, guides,
or tutorials the project maintains.  If the project uses a
documentation site generator (MkDocs/Sphinx/Docusaurus/mdBook/
etc.), update the corresponding source pages — not just the
README.  If the project keeps a CHANGELOG (e.g. Keep a Changelog
format), add an appropriate entry.

If a manual or documentation site page requires a screenshot,
capture a real one by starting the application and opening a
browser — do not use placeholders.  If your code changes
affect the visual output shown in existing manual screenshots,
retake them as part of the doc update.

Before pushing, check whether the PR description still accurately
reflects the current code changes.  Run
`gh pr view --json body --jq .body` to read the current
description, then compare it against what the branch actually does.
If the description is outdated or inaccurate, update it using
`gh pr edit --body "..."`.  Keep the issue reference
(Closes #{number} or Part of #{number}) in the body.

Then commit and push the branch so a new CI run is triggered.
If all findings are acceptable as-is, explain your reasoning.
````

**`annotationsIncomplete` flag:** Surfaces in the prompt as a line
of the inspection context.  It means the _pointer metadata_ itself
could not be fully determined, not that annotation bodies are
missing — those are fetched by the agent on demand.  Three things
can set the flag:

- A `gh api .../jobs` call failed for one of the failing workflow
  runs.
- The job listing for a failing run hit its first-page cap of 100
  entries (matrix builds with many jobs).
- The upstream CI run listing itself was truncated (the workflow
  run page was full, or the check-runs endpoint reported
  `total_count > 100`).  In this case `hasAnnotations` is also
  forced to `true` so the findings-review path stays engaged
  instead of treating an incomplete listing as a clean pass.

When `true`, the prompt includes pagination hints for all three
truncation sources so the agent can recover regardless of which
source was truncated:

- Failing-jobs listing for a workflow run:
  `gh api .../actions/runs/<runId>/jobs?per_page=100&page=<n>`.
- Workflow-run listing — paginate the Actions API directly with
  `gh api .../actions/runs?branch=<branch>&per_page=100&page=<n>`
  (or `head_sha=<sha>` to narrow to one commit).  The hint
  deliberately does _not_ recommend re-running `gh run list
  --limit 100`: that's the bounded read whose 100-cap originally
  set the truncation flag, so repeating it cannot reach the
  hidden runs and would also drop the commit filter the
  pipeline applied.
- Check-runs listing for the ref:
  `gh api .../commits/<ref>/check-runs?per_page=100&page=<n>`.

This matters in particular when the upstream check-runs page was
truncated: the visible `checkRunIds` set may be empty even though
additional check runs (and annotations) exist on later pages.

**Pointer-only design:** The pipeline never serialises annotation
bodies, alert payloads, or correlated `[alert #N]` lists into the
prompt.  The agent receives bounded check-run IDs and uses
`gh api` to read the actual content.  This keeps prompts at a
small constant size regardless of CI volume.

**Findings-review budget:** Tracked independently from the
failure-fix budget. The maximum number of findings reviews is
`max(1, maxFixAttempts)` — always at least one review even when
`maxFixAttempts` is 0.

**Verdict handling:** The findings-review sub-path does **not**
use a verdict keyword. Instead, the handler compares the HEAD SHA
before and after the review:

- If the SHA changed (agent pushed fixes), the result is
  `not_approved` and another CI poll begins.
- If the SHA is unchanged (agent reviewed but made no changes),
  the result is `completed` and the stage finishes.

#### CodeQL triage

The findings-review prompt always includes a `## Triage of code
scanning alerts` section with evaluation criteria and dismiss
instructions (see the prompt template above).  The list of
dismissible alerts is **not** built on the pipeline side — the
agent fetches the open alerts itself with `gh api .../code-scanning/
alerts?ref={branch}&state=open&per_page=100` (the API's `ref`
filter accepts a branch or PR merge ref, not a commit SHA),
correlates them to the annotations it just read, and dismisses
any false positives via `gh api -X PATCH .../alerts/{number}`.

---

### Stage 6: Test plan verification loop

**Agent:** A\
**Purpose:** Execute each item in the PR's test plan checklist and
check off completed tasks in the issue.

**Verify prompt:**

```text
You are verifying the test plan for the following GitHub issue.

## Issue #{number}: {title}

{issue_body}

## Instructions

1. Find the pull request for this branch (use `gh pr view`).
2. Go through each item in the PR's "Test plan" checklist.  For
   each item, actually run or verify the described test or behavior.
   - Start all required services (dev servers, databases, external
     services, etc.) using whatever tools the project provides
     (Docker Compose, `pnpm dev`, setup scripts, etc.).  If a port
     conflict occurs, change the port rather than skipping the
     service.
   - If a browser is needed for testing, launch one (e.g., headless
     Chrome via Playwright).
   - For manual test items, do not defer them to the user.  Act as
     the end user: launch the application, navigate the UI, verify
     behavior, and check off each item yourself.  Use browser
     automation (Playwright, headless Chrome) or direct CLI/API
     interaction to replicate what a human user would do.
   - Only flag a test item for the user if it is truly impossible
     to verify programmatically (e.g., subjective visual design
     judgment).
   - When documentation or the PR requires screenshots, do not use
     placeholders.  Actually start the application, open a browser,
     and capture real screenshots.
3. Check off each verified item in the PR using `gh` commands.
4. Also go through the task checklist in the GitHub issue.  Check
   off each completed task using `gh` commands.  Then check the
   issue's parent issue (and grandparent, recursively) and check
   off any tasks that are now completed.
5. If you made any code changes:
   Before pushing, check whether the PR description still accurately
   reflects the current code changes.  Run
   `gh pr view --json body --jq .body` to read the current
   description, then compare it against what the branch actually does.
   If the description is outdated or inaccurate, update it using
   `gh pr edit --body "..."`.  Keep the issue reference
   (Closes #{number} or Part of #{number}) in the body.
   Then commit and push them so a new CI run is triggered.
6. Make sure CI is still passing after any changes.
```

**Self-check work prompt:**

```text
Based on your verification above, evaluate the current state.

- Are ALL test plan items in the PR checked off?
- Are ALL task checklist items in the issue checked off?  Also check
  off completed tasks in the issue's parent issue (and grandparent,
  recursively) when applicable.
- Is CI still passing?

If you found issues during verification, fix them now.
If everything is verified and passing, you are done.
```

**Test plan verdict follow-up:**

```text
Reply with exactly one keyword (no commentary):
FIXED if you found and fixed issues,
DONE if everything is verified and passing with no changes needed.
```

**Loop behavior:** `FIXED` → repeat the verification loop.
`DONE` -> proceed to review. Default auto-budget: 3 iterations.

---

### Stage 7: Review loop

**Agents:** B (reviewer) and A (author)\
**Purpose:** Independent code review by Agent B, with Agent A
addressing feedback. Multi-round until approval.

Since both agents operate under the same GitHub account, comments
are distinguished by prefix and round number.

Agent A and Agent B use separate worktrees during review. Agent B
reviewer turns run from the detached reviewer worktree, refreshed
from `origin/{branch}` before reviewer activity. Agent A author
substeps, including PR finalization and review fixes, continue to run
from the author worktree.

#### Review prompt — Agent B (round 1)

```text
You are reviewing a pull request for the following GitHub issue.

## Issue #{number}: {title}

{issue_body}

## Instructions

1. Find the pull request for this branch (use
   `gh pr view {branch} --repo {owner}/{repo}`).
2. Review the diff against the issue.
   Your job is an
   independent judgment on whether this is the right change
   and whether it is built well — not a mechanical checklist.
   Read the code, form an opinion, and explain it with
   concrete references where they help anchor the point.

   Common review angles include:
   - Whether the approach actually solves the issue, and
     whether any requirement appears to be dropped, only
     partially implemented, or implemented in a surprising way.
   - Correctness on edge cases and failure paths, not just the
     happy path.
   - Design quality: readability, appropriate abstractions,
     avoiding over-engineering, unrelated drive-by changes,
     dead code, or stray debug output.
   - Test presence and meaningfulness — especially whether the
     tests exercise the new behaviour in a way that would have
     failed before the change. You do NOT need to run the test
     suite or re-check CI; assume those are already handled and
     focus on whether the tests are the right tests.
   - Error handling, security (input validation, injection,
     secrets, permissions), and obvious performance issues.
   - Documentation or comments that now appear out of sync with
     the code.
   - PR hygiene if it appears off: issue linkage (`Closes #N`
     vs. `Part of #N` with `## Not addressed` when partial) and
     a `## Test plan` checklist.

   The list above is guidance, not a limit. If something feels
   off for any other reason — architectural, stylistic, product,
   or subtle — raise it.
3. Post your review as a PR comment prefixed with
   `**[Reviewer Round {n}]**`. Be specific. Cite file paths and
   line numbers when they help; for broader concerns, explain
   the concern at the appropriate level.
```

**Reviewer verdict follow-up** (sent after the review comment):

```text
Reply with exactly one keyword (no commentary):
APPROVED if the changes are ready to merge,
NOT_APPROVED if changes are needed.
```

**Verdict comment:** After recording the verdict, the
orchestrator posts a machine-readable PR comment:
`[Review Verdict Round {n}: APPROVED|NOT_APPROVED]`. This
comment is used for state reconciliation on resume (see
[PR-comment-based resume](#pr-comment-based-resume) below).

#### Review prompt — Agent B (round 2+)

For follow-up reviews (round > 1), step 2 adds follow-through
verification and reasoned-pushback handling before the review
step:

```text
2. Read the author's response in the PR comment prefixed with
   `[Author Round {n-1}]` to understand what was changed.
   For each item you raised in `[Reviewer Round {n-1}]`,
   check the outcome:
   - If the author says it was fixed, verify that the fix is
     actually present in the updated diff.
   - If the author pushed back with reasoning, evaluate that
     reasoning honestly. If it is sound, treat the item as
     resolved and do NOT re-raise it. If it is weak, unclear,
     or does not address the concern, keep the item open.
   - Only carry forward items that remain genuinely unresolved.
3. Review the updated diff against the issue.
   Your job is an
   independent judgment on whether this is the right change
   and whether it is built well — not a mechanical checklist.
   Read the code, form an opinion, and explain it with
   concrete references where they help anchor the point.

   Common review angles include:
   - Whether the approach actually solves the issue, and
     whether any requirement appears to be dropped, only
     partially implemented, or implemented in a surprising way.
   - Correctness on edge cases and failure paths, not just the
     happy path.
   - Design quality: readability, appropriate abstractions,
     avoiding over-engineering, unrelated drive-by changes,
     dead code, or stray debug output.
   - Test presence and meaningfulness — especially whether the
     tests exercise the new behaviour in a way that would have
     failed before the change. You do NOT need to run the test
     suite or re-check CI; assume those are already handled and
     focus on whether the tests are the right tests.
   - Error handling, security (input validation, injection,
     secrets, permissions), and obvious performance issues.
   - Documentation or comments that now appear out of sync with
     the code.
   - PR hygiene if it appears off: issue linkage (`Closes #N`
     vs. `Part of #N` with `## Not addressed` when partial) and
     a `## Test plan` checklist.

   The list above is guidance, not a limit. If something feels
   off for any other reason — architectural, stylistic, product,
   or subtle — raise it.
4. Post your follow-up review as a PR comment prefixed with
   `**[Reviewer Round {n}]**`. Include any still-unresolved
   prior items and any new findings from this round. Be
   specific. Cite file paths and line numbers when they help;
   for broader concerns, explain the concern at the
   appropriate level.
```

The same reviewer verdict follow-up is sent after the round 2+
review comment.

#### Author fix prompt — Agent A (round N)

Sent when Agent B returns `NOT_APPROVED`:

```text
You are addressing review feedback for the following GitHub issue.

## Issue #{number}: {title}

{issue_body}

## Instructions

1. Find the pull request for this branch (use `gh pr view`).
2. Read the review comments prefixed with `[Reviewer Round {n}]`
   (only comments from your own account).
3. Evaluate each review item against the issue requirements and
   the codebase context before acting on it:
   - **Accept and fix** items that are valid.
   - **Push back with reasoning** on items that are incorrect,
     out of scope, would introduce regressions, or conflict
     with project conventions — do not apply them blindly.
   - **Partially address** items where only part of the
     suggestion is appropriate, and explain what you kept
     and why.
4. Post a response as a PR comment prefixed with
   `**[Author Round {n}]**`. For each review item,
   clearly state its disposition:
   - **Fixed** — what you changed.
   - **Pushed back** — why the suggestion should not be applied.
   - **Partially addressed** — what you changed and what you
     left, with reasoning.
5. If your changes affect documentation, update it accordingly —
   code comments, inline API docs (JSDoc/TSDoc/docstrings), README
   files, CHANGELOG entries, and any user-facing manuals, guides,
   or tutorials the project maintains.  If the project uses a
   documentation site generator (MkDocs/Sphinx/Docusaurus/mdBook/
   etc.), update the corresponding source pages — not just the
   README.  If the project keeps a CHANGELOG (e.g. Keep a Changelog
   format), add an appropriate entry.

   If a manual or documentation site page requires a screenshot,
   capture a real one by starting the application and opening a
   browser — do not use placeholders.  If your code changes
   affect the visual output shown in existing manual screenshots,
   retake them as part of the doc update.
6. Before pushing, check whether the PR description still accurately
   reflects the current code changes.  Run
   `gh pr view --json body --jq .body` to read the current
   description, then compare it against what the branch actually does.
   If the description is outdated or inaccurate, update it using
   `gh pr edit --body "..."`.  Keep the issue reference
   (Closes #{number} or Part of #{number}) in the body.
7. Commit and push your changes so a new CI run is triggered.
```

**Author completion check:**

```text
Reply with exactly one keyword (no commentary):
COMPLETED if all feedback was addressed and changes were pushed,
BLOCKED if you cannot proceed and need user intervention.
```

After Agent A pushes, the orchestrator runs an internal CI
poll-and-fix loop (up to 3 fix attempts). Once CI passes, the
next review round begins.

#### Unresolved summary — Agent B

When the review loop ends (either because B approves or the
auto-budget is exhausted), B is asked:

**Work step:**

```text
The review loop has ended.  Please check whether there are any
unresolved items from this review cycle.

- If there are unresolved items, post a PR comment prefixed with
  `**[Reviewer Unresolved Round {n}]**` listing each unresolved item.
- If there are no unresolved items, simply confirm that there is
  nothing left to address.
```

**Verdict follow-up:**

```text
Reply with exactly one keyword (no commentary):
NONE if there are no unresolved items,
COMPLETED if you posted the unresolved items comment.
```

If the verdict is ambiguous or contains an out-of-scope keyword,
the orchestrator retries once with a scoped clarification prompt.
If B posts an unresolved summary, the orchestrator shows it to
the user before asking whether to continue (at budget limit) or
before reporting completion (on approval).

#### PR finalization — Agent A

After Agent B approves, Agent A is invoked once more to verify
the PR body:

```text
The review is complete and the PR has been approved.  Before
merging, verify that the PR body accurately reflects the final
state of the implementation.

## Issue #{number}: {title}

{issue_body}

## Instructions

1. Read the current PR body using
   `gh pr view --json body --jq .body`.
2. Compare the issue requirements above against the code on the
   branch to determine whether every requirement has been addressed.
3. If the PR fully resolves the issue, ensure the body contains
   "Closes #{number}".  If it only partially addresses it,
   ensure it says "Part of #{number}" and includes a
   "## Not addressed" section listing which issue requirements
   were not implemented and why.
4. If the reference or "## Not addressed" section needs to change,
   update the PR body using `gh pr edit --body "..."`.
```

**PR finalization verdict follow-up:**

```text
Reply with exactly one keyword (no commentary):
PR_FINALIZED if the PR body is now accurate.
```

Agent A must respond with `PR_FINALIZED` for the stage to
complete. If the verdict is ambiguous after the clarification
retry, the handler verifies the PR body directly for
consistency: `Closes #N` must not have a contradictory
`## Not addressed` section, and `Part of #N` must include one.
If the body is consistent the stage proceeds as completed;
otherwise it returns `blocked` so the user can intervene. This
avoids relying on the squash stage to catch a bad body, since
squash short-circuits on single-commit branches.

**Loop behavior:** Default auto-budget: 5 rounds (configurable
via `reviewAutoRounds`). When the budget is exhausted, the user
is asked whether to continue.

#### PR-comment-based resume

When a review stage is resumed after interruption, the
orchestrator reconstructs review state from PR comments rather
than relying solely on persisted run state. The reconciliation
(in `reconcileWithPr`) compares the saved `RunState` against the
actual PR comment history and corrects:

- **`reviewRound`** — always corrected to the maximum round number
  seen across reviewer, author, and verdict PR comments.
- **`stageLoopCount`** — only corrected when `currentStage` is 7
  (the review stage); set to `max(0, prMaxRound - 1)` because the
  loop counter is zero-based while round numbers are one-based.
  When the pipeline is at a different stage, `stageLoopCount` is
  left untouched so it preserves that stage's own loop counter.
- **`currentStage`** — demoted from later stages back to 7 if the latest round
  lacks an `APPROVED` verdict with a matching reviewer comment;
  promoted to stage 7 if review rounds exist but local state is
  still earlier.
- **`reviewSubStep`** — derived conservatively from the comment
  history (see below).  **Exception:** when `currentStage > 7`
  (post-review stages such as squash), the max round is `APPROVED`,
  and local `lastVerdict` is already `APPROVED`, sub-step
  reconciliation is skipped.  PR comments cannot distinguish
  `unresolved_summary` from `pr_finalization`, so the derivation
  would conservatively return `unresolved_summary` and trigger a
  false mismatch against a local `pr_finalization`.  Local state is
  authoritative for post-approval progress.
- **`lastVerdict`** — always corrected to the verdict derived from
  the comment history, even when sub-step reconciliation is skipped.
- **`reviewerWorktreePath`** — persisted with run state so resumed
  review stages continue to know the detached reviewer checkout path.
  The worktree itself is still refreshed from `origin/{branch}`
  before reviewer activity.
- **Agent session invalidation** — if any field diverged from the
  persisted value, all agent sessions are invalidated so they
  start fresh with corrected state.

The sub-step derivation follows conservative rules:

| PR comment state | Derived sub-step |
| --- | --- |
| No reviewer comment for current round | `review` |
| Reviewer comment but no verdict comment | `verdict` |
| Verdict is `APPROVED` | `unresolved_summary` |
| Verdict is `NOT_APPROVED`, no author comment | `author_fix` |
| Author comment exists | `ci_poll` |

#### ReviewSubStep state machine

Within each review round, the handler tracks progress through a
`ReviewSubStep` enum:

```text
review → verdict → (APPROVED)     → unresolved_summary → pr_finalization
                  → (NOT_APPROVED) → author_fix → ci_poll → [next round]
```

The sub-steps are:

- **`review`** — Agent B posts a review comment.
- **`verdict`** — Agent B provides `APPROVED` or `NOT_APPROVED`.
- **`unresolved_summary`** — Agent B summarises unresolved items
  (approval path only).
- **`pr_finalization`** — Agent A verifies the PR body (approval
  path only).
- **`author_fix`** — Agent A addresses feedback and pushes.
- **`ci_poll`** — internal CI poll-and-fix after the author push.

On resume, the handler skips directly to the derived sub-step,
avoiding re-execution of already-completed work within a round.

---

### Stage 8: Squash commits

**Agent:** A\
**Purpose:** Decide whether the branch is best presented as a
single squash commit (in which case the agent drafts the suggested
title and body and agentcoop posts the marker-delimited PR comment,
letting GitHub's "Squash and merge" apply the message at merge
time) or several meaningful commits (rewrite history and
force-push).  Skipped automatically if the branch has only one
commit.

The single-commit suggestion path was added to avoid wasting an
extra CI cycle on a force-push that GitHub's "Squash and merge"
button would perform anyway.

**Prompt:**

The work prompt asks the agent to:

1. Sync the PR description (standard PR-sync instructions).
2. Decide whether the work belongs in **one** commit or **several**.
3. Branch on that decision:
   - **Single commit appropriate:** do not rewrite history, do not
     force-push, and do not post or edit any PR comment yourself.
     Draft the squash title and body, then reply with them wrapped
     in a `<<<TITLE>>>...<<</TITLE>>>` / `<<<BODY>>>...<<</BODY>>>`
     envelope.  agentcoop parses the envelope, builds the
     marker-delimited PR comment from those fields
     (`<!-- agentcoop:squash-suggestion:start -->` …
     `<!-- agentcoop:squash-suggestion:end -->`, with each field
     under a `**Title**` / `**Body**` label inside its own fenced
     code block), and PATCH/POSTs the comment idempotently.  Fence
     sizing follows the CommonMark rule
     `fence_len = max(longest backtick run in content, 2) + 1`
     (minimum 3) so a body that itself contains triple-backtick
     samples gets a four-or-more-backtick outer fence and the inner
     fence cannot close the outer block early.  Stage 9 reads the
     same block via `parseSquashSuggestionBlock` (closing fence ≥
     opening, same character) to render the inline preview.  The
     formatter and parser are pinned in lock-step by a round-trip
     unit test.
   - **Multiple commits appropriate:** consolidate the branch
     commits — using `git reset --soft {baseSha}` + `git commit` or
     interactive rebase — write clear messages, and force-push
     (`git push --force-with-lease`).

**Completion check:**

```text
Reply with exactly one keyword (no commentary):
SQUASHED_MULTI if you rewrote history into multiple meaningful
commits and force-pushed,
SUGGESTED_SINGLE if a single commit is appropriate and you drafted
the suggested title and body in the <<<TITLE>>>/<<<BODY>>> envelope
(no force-push),
BLOCKED if you could not complete either path and need user
intervention.
```

The handler calls `parseVerdictKeyword` directly with these three
keywords (rather than feeding them through the shared `KEYWORD_MAP`)
because the three-way distinction is squash-specific.

**Already-merged short-circuit:** Before any destructive action
(the `"agent"` apply branch and the `squashing` resume branch in
particular), a `guardIfPrMerged` helper runs `queryPrState`
(`gh pr view --json state`, fails open to `OPEN`).  If the user
merged the PR on GitHub mid-run, the helper clears
`squashSubStep` and finishes the stage with
`squash.alreadyMerged` so the pipeline does not force-push history
onto a closed branch or kick off a CI poll for a head SHA with no
open PR.  Stage 8 cannot reuse Stage 9's `ensurePrStillOpen`
helper because the Done stage owns the worktree lifecycle —
cleanup stays in Stage 9.

**Envelope-driven SUGGESTED_SINGLE shortcut:** Before running the
verdict turn, the handler scans the work response for the
`<<<TITLE>>>` / `<<<BODY>>>` envelope.  Detection keys off a
`<<<TITLE>>>` open tag on its own line — prose that merely names
the tags mid-sentence or in backticks (e.g. a multi-commit reply
explaining why the envelope was not used) never produces a tag on
a line by itself, so it does not register as envelope intent.
Once envelope intent is declared, the parser walks the structure
and classifies the response as one of three outcomes:

- **Well-formed envelope** (TITLE_OPEN → TITLE_CLOSE → BODY_OPEN
  → BODY_CLOSE all present on their own lines, in order, with
  non-empty content) → agentcoop calls
  `buildSquashSuggestionComment` to render the canonical marker
  block (asserts round-trip parseability as defense-in-depth),
  BODY_CLOSE is anchored to the LAST own-line `<<</BODY>>>` after
  BODY_OPEN so a body that legitimately documents the envelope
  contract (plausible for issue #304 itself) is not truncated at
  an in-body literal close tag — only the final own-line
  `<<</BODY>>>` terminates the envelope, and that close tag must
  be the last non-blank line of the response so a forgotten real
  close tag (with an in-body example present) classifies as
  malformed instead of silently truncating the body,
  then `postOrUpdateSquashSuggestion` PATCHes the prior comment by
  id (when one exists) or POSTs a fresh one.  A transient lookup
  failure inside the write helper (auth, network, rate-limit) is
  surfaced as a `blocked` outcome rather than POSTing a duplicate
  suggestion comment.  The verdict turn is skipped — the envelope
  is the SUGGESTED_SINGLE signal — and the handler proceeds
  directly to the user-choice path.  A `pipeline:verdict` event
  with keyword `SUGGESTED_SINGLE` is emitted so telemetry
  consumers see the verdict.
- **Malformed envelope** (envelope intent declared but the
  structure is broken: a missing close tag, an absent body
  section, or empty / whitespace-only title or body content) →
  send one focused
  **clarification turn** asking the agent to reply with either a
  valid envelope or a `SQUASHED_MULTI` / `BLOCKED` keyword (no
  other commentary).  Re-parse the retry:
  - Valid envelope → author and post the comment, proceed to the
    user-choice path.
  - `SQUASHED_MULTI` keyword → run the CI poll path.
  - `BLOCKED` keyword → existing blocked flow.
  - Anything else (still malformed, missing, or a bare
    `SUGGESTED_SINGLE` keyword without an envelope) → fail closed
    with `blocked` and surface both responses for diagnostics.
  The clarification preserves the recoverable-mistake path the
  verdict-clarification round already provides, so a single
  formatting slip — including a dropped close tag, exactly the
  failure mode that caused the original issue — does not dump the
  user into "Give instruction / Halt" with no context.  Falling
  through to the verdict path instead would either hard-block
  opaquely (when the verdict comes back as SUGGESTED_SINGLE
  without an envelope to draw from) or quietly reuse a stale
  prior suggestion comment from an earlier run.
- **Envelope absent** (no `<<<TITLE>>>` tag on its own line) →
  fall through to the existing verdict / clarification chain.
  Envelope absence on its own is not a SUGGESTED_SINGLE signal:
  the agent could be in the SQUASHED_MULTI branch, or BLOCKED,
  or simply ambiguous.

**Verdict handling** (only reached when the envelope is absent):

- `SQUASHED_MULTI` → poll CI after the force-push (existing
  behaviour, up to 3 internal fix attempts) and finish with
  `squash.completed` when CI passes.
- `SUGGESTED_SINGLE` → the agent declared SUGGESTED_SINGLE in the
  verdict turn but never provided a `<<<TITLE>>> / <<<BODY>>>`
  envelope in any earlier response.  Agentcoop does **not**
  consume a historical squash-suggestion comment from an earlier
  run as evidence here — that would propagate the stale-suggestion
  problem this stage was redesigned to fix (issue #304).  Instead,
  the same focused envelope clarification turn used for the
  malformed case fires, asking for either a valid envelope or a
  `SQUASHED_MULTI` / `BLOCKED` keyword.  On retry: a valid
  envelope → author and post the comment + ask the user;
  `SQUASHED_MULTI` → CI poll; `BLOCKED` → blocked; anything else
  → blocked with both responses surfaced.  Before sending the
  clarification, the PR-merged guard fires so a concurrent merge
  during the verdict round short-circuits to `alreadyMerged`
  instead of asking the agent to draft a suggestion for a closed
  branch.
- `BLOCKED` → existing blocked flow.

**Ambiguous response handling:** Same internal clarification
retry pattern as stage 4 (Create PR).  If clarification also
fails, the handler runs a **deterministic fallback chain**:

1. If the branch commit count **decreased** relative to the
   snapshot taken at stage entry, treat as `SQUASHED_MULTI` (the
   force-push has already happened — that hard-to-undo side
   effect must be detected first).
2. Else, run the PR-merged guard.  If the PR was concurrently
   merged on GitHub, return `alreadyMerged` instead of falling
   through to BLOCKED.
3. Else, treat as `BLOCKED`.

The fallback chain deliberately does **not** promote a historical
squash-suggestion comment on the PR to a `SUGGESTED_SINGLE`
verdict.  Without an envelope from this run, the only
deterministic signals are commit-count collapse (`SQUASHED_MULTI`)
or `BLOCKED`.  Promoting a stale marker block here would
re-introduce the stale-suggestion propagation issue #304 was
written to fix.

The derived verdict is emitted as a `pipeline:verdict` event just
like a parsed-keyword verdict, so telemetry consumers see every
verdict regardless of whether it came from the agent response or
the fallback chain.

**`SquashSubStep` state machine:**

```text
planning ──┬── (envelope ok)         → awaiting_user_choice
           │       ├── (agent)  → squashing → ci_poll → done
           │       └── (github) → applied_via_github (stage done)
           ├── (envelope malformed)  → clarify
           │       ├── (envelope ok)        → awaiting_user_choice (as above)
           │       ├── (SQUASHED_MULTI)     → ci_poll → done
           │       ├── (BLOCKED)            → blocked
           │       └── (still unrecoverable) → blocked
           └── (envelope absent)     → verdict
                ├── (SQUASHED_MULTI)   → ci_poll → done
                ├── (SUGGESTED_SINGLE) → clarify  (no stale-comment promotion;
                │                        a current envelope is required)
                │       ├── (envelope ok)        → awaiting_user_choice
                │       ├── (SQUASHED_MULTI)     → ci_poll → done
                │       ├── (BLOCKED)            → blocked
                │       └── (still unrecoverable) → blocked
                └── (BLOCKED)          → blocked
```

`RunState.squashSubStep` persists the current substate so resume
re-enters at the correct point:

- `applied_via_github` → stage already done; advance to Stage 9.
- `awaiting_user_choice` → re-verify a parseable suggestion block is
  still in the squash-suggestion PR comment (same strict check as
  the verdict path); if present, re-present the user choice without
  re-invoking the agent.  If absent or malformed, fall back to
  `planning` rather than re-presenting a choice the user could not
  act on.  If the comment lookup itself **throws** (a transient
  `gh api` failure: auth, network, rate limit), the stage fails
  closed with `blocked` and leaves `squashSubStep` at
  `awaiting_user_choice` so a retry once `gh` recovers re-presents
  the existing choice — silently degrading to "no matching comment"
  here would fall through to a fresh planning run, re-invoke the
  agent, and could re-author the suggestion or change the branch
  decision after the user had already been asked about one.  If
  the user then picks "agent squashes now" but no agent session is
  available (neither the saved run state nor the current verdict
  produced a session ID), the stage fails closed with `blocked`
  rather than silently completing as if the user had picked
  "github" — the user's choice must not be misrepresented.
- `ci_poll` → resume the post-squash CI poll loop directly.
- `squashing` → the user picked "agent squashes now" and the
  follow-up prompt was sent, but we were interrupted before the
  transition to `ci_poll`.  Resume runs a deterministic check
  before doing anything expensive:
  1. Re-count the branch commits.  If it collapsed to 1, the
     squash already landed — jump straight to `ci_poll`.  This is
     the common case and avoids a second force-push / CI cycle.
  2. Otherwise, if a saved session is available, re-send **only**
     the follow-up squash prompt on that session so the agent
     continues the same conversation rather than restarting
     planning.
  3. As a last resort (no session persisted), fall back to a
     fresh planning run.
- `planning` (or absent) → run the agent prompt fresh (the work
  prompt is idempotent — the agent will redo or confirm the same
  decision).

The stage reads the sub-step and the persisted agent-A session id
via live getters on each handler invocation, so an in-process
retry (e.g. after a transient `ci_poll` error) observes the
values the previous iteration persisted rather than the startup
snapshot.  Without this, a retry from `ci_poll` after the branch
had already collapsed could fall into the single-commit skip path
and falsely complete the stage.

The stage also persists the **verdict turn's** session id (the one
returned by `resolveVerdict`) before transitioning to
`awaiting_user_choice`.  Adapters can surface a new session id on
a follow-up turn, so the verdict session is not guaranteed to
equal the planning session.  Persisting it ensures that a resume
from `awaiting_user_choice` — where the user picks "agent
squashes now" — re-sends the follow-up on the exact conversation
that drafted the squash-suggestion comment, rather than the
earlier planning session.

**Outcome handling:** `requiresArtifact: true` — if `BLOCKED`,
only **Instruct** and **Halt** are offered.

---

### Stage 9: Done

**Agent:** A (only for rebase)\
**Purpose:** Check for merge conflicts, optionally rebase, and
confirm merge with the user.

**Flow:**

```text
             +------------------+
             | Check mergeable  |<-------------------------------+
             +--------+---------+                                |
       +--------------|---------------+                          |
       v              v               v                          |
  MERGEABLE       CONFLICTING      UNKNOWN                       |
       |              |               |                          |
       v              v               v                          |
       |         User choice     User choice                     |
       |         +----+----+     +----+-----+                    |
       |         v         v     v          v                    |
       |       Agent    Manual  Recheck    Exit                  |
       |       rebase      |       |         |                   |
       |          |        v       |         v                   |
       |          |    Wait for    |       Cleanup               |
       |          |    user resolve|                              |
       |          |        |       +-----------------------------+
       |          v        v
       |     +----+--------+----+
       |     | Re-check mergeable |
       |     +----+------+------+-+
       |          |      |      |
       |     MERGEABLE CONFL. UNKNOWN--Exit---> Cleanup
       |          |      |
       |          v      +----------------------------> (top)
       |       CI poll
       |       +--+--+
       |       |     |
       |    passed  failed
       |       |     |
       |       v     v
       |       |   Cleanup
       v       v
  Merge confirm  <--+
   +---+---+        |
   v   v   v        |
Merged | Check      |
   |   | conflicts--+
   |   |
   |   v
   |  Exit
   |   |
   v   v
Cleanup
```

1. **Check mergeable status** using the GitHub API. GitHub may
   return `UNKNOWN` while computing mergeability, so the
   orchestrator retries with exponential backoff (up to 5 retries,
   starting at 2 seconds, doubling each time) before reporting
   the state to the user.

   Each `checkMergeable` call is wrapped in `ensurePrStillOpen`,
   which reads the PR lifecycle via `queryPrState`
   (`gh pr view --json state`, fails open to `OPEN`).  If the user
   merged the PR on GitHub mid-run, the helper short-circuits
   straight to `stopServices()` + `cleanup()` — the same silent
   path used on `confirmMerge === "merged"` — so the stage does
   not burn its full backoff budget on `UNKNOWN` against a closed
   branch.  The guard is centralised at the helper boundary and
   fires at all three call sites: the initial mergeable loop,
   `afterResolution`, and the `check_conflicts` inner loop.

2. **Based on the result:**

   - **MERGEABLE** -> proceed to merge confirmation.

   - **CONFLICTING** -> offer the user a choice:
     - **Agent rebase** — invoke Agent A to rebase onto the
       latest default branch. The rebase handler returns one of
       three outcomes:
       - `completed` — rebase succeeded and was force-pushed.
         The orchestrator polls CI. If CI passes, proceed to
         merge confirmation; on every `pollCiAndFix` failure
         path (fix-budget exhausted, pending timeout, or agent
         error during findings review or fix) the user is
         asked via `confirmRetry` whether to keep trying.
         Cleanup only runs after an explicit decline, so the
         session never ends silently on a transient blip.
       - `blocked` — the agent finished but reported `BLOCKED`.
         The user sees the agent's own explanation (no longer
         a generic "resolve manually" notice) and falls back to
         manual resolution.  This consumes the single-attempt
         budget.
       - `error` — the agent process itself failed (crash, CLI
         error, timeout).  The error detail is surfaced to the
         user and the single-attempt budget is _not_ consumed,
         so the user can retry rebase after dealing with the
         underlying error.
       Only `completed` and `blocked` count against the
       one-attempt-per-run rebase budget.
     - If rebase was **already attempted** earlier in this run
       (`completed` or `blocked`) the agent rebase option is
       not offered.  The user is prompted to resolve manually.
     - **Manual** — pause and wait for the user to resolve
       conflicts outside of AgentCoop (e.g., in their own
       terminal). Once the user signals completion, the
       orchestrator re-checks the mergeable status. If still
       conflicting, the flow loops back.

   - **UNKNOWN** (after exhausting retries) -> offer:
     **Recheck** (re-poll with backoff) or **Exit**.

3. **Merge confirmation** — the user chooses:
   - **Merged** — the user has merged the PR externally. Stop
     running services (e.g., Docker Compose), clean up the author
     worktree and branch plus the detached reviewer worktree, and
     report completion.
   - **Check conflicts** — run the mergeable check again without
     leaving this screen. This lets the user verify the state
     right before merging. If `MERGEABLE` comes back, the inner
     loop **does not** block on a press-enter prompt; instead it
     stashes a one-shot `pipeline.noConflicts` notice and falls
     straight back to `confirmMerge`, which folds the notice into
     its next redraw and clears it.  `waitForManualResolve` stays
     reserved for cases where the user actually has manual work to
     do (post-rebase / already-attempted `CONFLICTING`).  If
     conflicts are found here, the same conflict resolution flow
     (agent rebase or manual) is available; after resolution, the
     merge confirmation is re-presented.
   - **Exit** — stop the pipeline without merging. The
     orchestrator offers cleanup options: stop running services,
     delete the author and reviewer worktrees, delete the remote
     branch, and close the PR. Each action is individually selectable.

   **Prompt viewport cap.** Stage 9's prompts must always leave the
   choice / text-input line visible.  Ink renders in-place without
   an alt-screen, so anything that overflows the bottom of the
   terminal cannot be scrolled back into view and the prompt
   appears frozen.  Two policies enforce this:

   - The merge-confirm screen never inlines arbitrarily long
     content.  Rendered values are summarised (e.g. body length
     in lines) and pathologically long single-line values are
     ellipsized so they cannot wrap to multiple rendered rows.
   - As a defensive backstop, `InputArea` caps its own height —
     reserving the status bar plus `MIN_PANE_CONTENT * 2` rows for
     the agent panes — and tail-truncates any future overflow with
     a single `…(truncated)` marker.  Each rendered line is drawn
     with `wrap="truncate-end"` so a long single-line message
     cannot wrap to multiple rendered rows on a narrow terminal,
     keeping the newline-based row budget accurate.

   When a squash suggestion is live in a PR comment, the
   merge-confirm screen renders the suggested title verbatim
   (ellipsized if pathologically long) and a one-line summary of
   the body (`Suggested body: N lines`).  The full body is _not_
   inlined: under the viewport-cap policy above, a long body would
   otherwise push the choice lines off the bottom of the terminal
   with no way to scroll them back.  The PR URL is shown right
   below so the user can open the comment to read the body.

   When the terminal can write to the system clipboard, the
   screen also renders `[t] copy` / `[b] copy` hotkey hints next
   to the title and body-summary lines.  Pressing `t` or `b`
   writes the corresponding value (the full title / the full
   body) to the system clipboard via `pbcopy` / `wl-copy` /
   `xclip` on local sessions, or OSC 52 on SSH.  If the
   environment can reach neither a native clipboard tool nor an
   OSC 52–capable stdout, the hints are not rendered — the user
   falls back to opening the PR comment without being told about
   a feature that cannot work here.

**Agent rebase prompt:**

```text
You are rebasing a feature branch onto the latest main.

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}

## Instructions

1. Run `git fetch origin {defaultBranch}` to get the latest main.
2. Run `git rebase origin/{defaultBranch}` to rebase onto main.
3. Resolve any merge conflicts that arise.
4. After resolving conflicts, verify the result locally:
   - Build the project to ensure it compiles.
   - Run the full test suite to ensure nothing is broken.
5. Only if the build and all tests pass, force-push the branch:
   `git push --force-with-lease`
6. After a successful force-push, post a brief PR comment noting
   which main commit the branch was rebased onto and a short
   summary of resolved conflicts. Use:
   `gh pr comment --body "<your summary>"`
   If no PR exists or the comment fails, continue without failing.

IMPORTANT: If you cannot resolve conflicts cleanly or if the
build/tests fail after resolution, do NOT push. Instead, abort
the rebase (`git rebase --abort`) and report failure.
```

**Verdict follow-up:**

```text
You have finished the rebase attempt.
Respond with exactly one of the following keywords:

- COMPLETED — if the rebase succeeded and was force-pushed
- BLOCKED — if you could not resolve conflicts or tests failed

Do not include any other commentary — just the keyword.
```

**Rebase constraints and rationale:**

- **One attempt per run.** Agent rebase is limited to a single
  attempt across the entire pipeline run, regardless of how many
  times the user loops back through the merge confirmation flow.
  This prevents the agent from repeatedly attempting (and failing)
  a difficult rebase.  The budget counts `completed` and
  `blocked` outcomes only — an `error` (agent process failure)
  leaves the budget intact so the user can retry.
- **Build and test verification.** The agent is instructed to
  verify the result locally before force-pushing. If the build or
  tests fail after conflict resolution, the agent must abort the
  rebase (`git rebase --abort`) and report `BLOCKED` rather than
  push broken code.
- **PR comment.** On success, the agent posts a PR comment
  summarizing which main commit it rebased onto and what conflicts
  were resolved. This creates an audit trail for the rebase.
- **CI re-validation.** After a successful rebase and force-push,
  the orchestrator polls CI and runs the CI fix loop if needed,
  because the rebase may have introduced regressions even if
  local tests passed.  Stage 9's `confirmRetry` callback on
  `pollCiAndFix` covers all three non-pass branches that would
  otherwise terminate the stage silently:
  - `exhausted` — the fix-attempt budget hit `maxFixAttempts`.
    On confirm, the counter resets to 0 and the fix loop
    re-enters.
  - `timeout` — `pollTimeoutMs` (default 10 minutes) elapsed
    while CI was still pending.  On confirm, polling resumes;
    HEAD SHA is re-read at the top of the outer loop so a fix
    that landed during the timeout window is automatically
    picked up.
  - `agent_error` — the findings-review or fix turn itself
    failed (CLI crash, timeout, etc.).  On confirm, the same
    step re-runs and the relevant counter is decremented to
    undo the pre-increment, so a permanent failure cannot
    silently exhaust the budget across retries.
  Cleanup only runs after an explicit decline, so the session
  never ends silently on a transient CI blip.  Stages 7 and 8
  do not pass `confirmRetry` — they already route CI failures
  through the engine's `dispatchError` prompt and must not
  double-ask.
- **Fallback to manual.** If the agent rebase fails, or if it
  was already attempted, the user is always offered manual
  resolution as a fallback.

## Orchestrator-managed operations

The following operations are handled directly by the orchestrator,
not delegated to agents.  Repository cloning, default-branch
detection, and worktree creation are the three Stage 1 (Bootstrap)
operations — see [Stage 1: Bootstrap](#stage-1-bootstrap) above for
details.

- **PR number extraction:** After Agent A creates a PR, extract
  the number via `gh pr list --head {branch} --json number`.
- **CI status polling:** Check CI status and build a bounded
  pointer-based inspection context (failing run/job IDs,
  check-run IDs, ref/SHA, incomplete-metadata flags) — never
  raw failure logs, annotation bodies, or alert payloads, which
  the agent fetches itself. A CI check is considered passed
  when all required checks succeed. `pending` -> wait and
  re-poll. `skipped` -> ignore. `cancelled` -> treat as failure.
- **Mergeable status checking:** Query the GitHub API with
  exponential backoff to handle the `UNKNOWN` state that occurs
  while GitHub computes mergeability.
- **Inactivity timeout:** If no output is received from an agent
  process for a configurable duration (default: 20 minutes), kill
  the process and resume the session automatically. Auto-resume up
  to 3 times; on the 4th timeout, ask the user. This is a silence
  timeout, not a total execution timeout.
