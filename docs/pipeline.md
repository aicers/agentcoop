# Pipeline stages and prompt design

This document describes each pipeline stage in detail, including
the exact prompt templates sent to agents, completion contracts,
and loop behavior. For a high-level overview of AgentCoop, see
the [README](../README.md).

## Table of contents

- [Pipeline overview](#pipeline-overview)
- [Prompt design principles](#prompt-design-principles)
  - [Self-contained context](#self-contained-context)
  - [Explicit completion keywords](#explicit-completion-keywords)
  - [No confirmation requests](#no-confirmation-requests)
  - [Service-aware instructions](#service-aware-instructions)
  - [PR body as living documentation](#pr-body-as-living-documentation)
  - [Issue-implementation reconciliation](#issue-implementation-reconciliation)
  - [Additional feedback injection](#additional-feedback-injection)
  - [Ambiguous response clarification](#ambiguous-response-clarification)
- [Stage reference](#stage-reference)
  - [Stage 1: Implement](#stage-1-implement)
  - [Stage 2: Self-check loop](#stage-2-self-check-loop)
  - [Stage 3: Create PR](#stage-3-create-pr)
  - [Stage 4: CI check loop](#stage-4-ci-check-loop)
  - [Stage 5: Test plan verification loop](#stage-5-test-plan-verification-loop)
  - [Stage 6: Review loop](#stage-6-review-loop)
  - [Stage 7: Squash commits](#stage-7-squash-commits)
  - [Stage 8: Done](#stage-8-done)
- [Orchestrator-managed operations](#orchestrator-managed-operations)

## Pipeline overview

```text
Implement -> Self-check -> Create PR -> CI check
   (A)       (A, loop)       (A)       (A, loop)

  -> Test plan -> Review -> Squash -> Done
     (A, loop)  (B<->A, loop) (A)    (user)
```

Agent A is the author (implements the issue). Agent B is the
reviewer. The orchestrator manages transitions, CI polling, and
user interaction.

## Prompt design principles

### Self-contained context

Every prompt includes the full repository coordinates (owner,
repo, branch, worktree path) and the complete issue body. Agents
never need to search for context — it is handed to them. This
avoids wasted tokens on exploration and reduces the chance of the
agent working against the wrong branch or issue.

### Explicit completion keywords

Each stage ends with a strict keyword contract. The orchestrator
parses the agent's final response for a specific keyword to
determine the next action. This eliminates ambiguity — the
orchestrator does not try to infer intent from free-form text.

| Step type | Keywords | Proceed | Loop/Retry |
| --------- | -------- | ------- | ---------- |
| Implementation | `COMPLETED` / `BLOCKED` | `COMPLETED` | `BLOCKED` -> user chooses |
| Loops (self-check, test plan) | `FIXED` / `DONE` | `DONE` | `FIXED` -> repeat |
| One-shot (PR, squash) | `COMPLETED` / `BLOCKED` | `COMPLETED` | `BLOCKED` -> user chooses |
| Review approval | `APPROVED` / `NOT_APPROVED` | `APPROVED` | `NOT_APPROVED` -> repeat |
| Issue sync | `ISSUE_NO_CHANGES` / `ISSUE_UPDATED` / `ISSUE_COMMENTED` | any | best-effort |
| PR finalization | `PR_FINALIZED` | `PR_FINALIZED` | missing -> clarification |

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

The standard PR sync instructions appear in stages 4 through 7:

> Before pushing, check whether the PR description still
> accurately reflects the current code changes. Run
> `gh pr view --json body --jq .body` to read the current
> description, then compare it against what the branch actually
> does. If the description is outdated or inaccurate, update it
> using `gh pr edit --body "..."`. Keep the issue reference
> (Closes #N or Part of #N) in the body.

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

When an agent's response does not end with a recognized status
keyword, the orchestrator sends a fixed clarification prompt
rather than re-running the stage (which could be side-effectful).
The same template is used in two contexts:

- **Within-stage session resume** (Create PR, Squash) — the
  orchestrator resumes the existing agent session with the
  clarification prompt.
- **Pipeline loop injection** — the prompt is set as
  `userInstruction` and appears as `## Additional feedback`
  on the next iteration.

The clarification prompt:

```text
Your previous response did not end with a clear status keyword.
Please reply with exactly one of the following keywords to indicate
the current status: COMPLETED, FIXED, DONE, APPROVED, NOT_APPROVED,
or BLOCKED.

Do not include any other commentary — just the keyword.
```

## Stage reference

### Stage 1: Implement

**Agent:** A\
**Purpose:** Implement the changes described in the GitHub issue.

**Prompt:**

```text
You are implementing a solution for the following GitHub issue.

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}
- Worktree: {worktree_path}

## Issue #{number}: {title}

{issue_body}

## Instructions

Implement the changes required to resolve this issue.  Work inside the
worktree directory listed above — it is freshly based on the latest
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
You have finished your implementation attempt.  Please evaluate the
result and respond with exactly one of the following keywords:

- COMPLETED — if the implementation is finished and working
- BLOCKED — if you cannot proceed and need user intervention

Do not include any other commentary — just the keyword.
```

**Outcome handling:**

- `COMPLETED` -> proceed to self-check.
- `BLOCKED` -> show Agent A's response to the user. Options:
  **Proceed** (continue as-is), **Instruct** (provide feedback),
  **Halt** (stop pipeline).

---

### Stage 2: Self-check loop

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
- Worktree: {worktree_path}

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
5. **Documentation consistency** — Are comments, READMEs, and inline
   docs consistent with the code changes?  If documentation or the
   PR requires screenshots, verify they were actually captured by
   starting the application, opening a browser, and taking real
   screenshots — do not use placeholders.
6. **Security** — Are there any security concerns (injection, auth,
   secrets exposure)?
7. **Performance** — Are there obvious performance issues or regressions?
8. **Code quality** — Is the new or modified code clean and
   maintainable?  If you spot opportunities to simplify, improve,
   or refactor the code *within the scope of this change*, apply
   them.  Do not refactor unrelated existing code.
```

**Fix-or-done prompt:**

```text
Based on your self-check above, decide what to do next.

- If you found issues that need fixing, fix them now and end your
  response with the keyword FIXED.
- If everything looks good and no changes are needed, end your
  response with the keyword DONE.
```

**Loop behavior:** `FIXED` -> repeat self-check. `DONE` -> run
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

## Response format

End your response with one of the following:

- If no changes were needed:
  `ISSUE_NO_CHANGES`
- If you updated the issue (minor):
  `ISSUE_UPDATED: <brief description of what changed>`
- If you added a comment (major):
  `ISSUE_COMMENTED: <brief description of the discrepancy>`

You may include both ISSUE_UPDATED and ISSUE_COMMENTED if there
were both minor and major discrepancies.
```

Issue sync is best-effort — if it fails, the pipeline continues.

---

### Stage 3: Create PR

**Agent:** A\
**Purpose:** Create a pull request from the implementation branch.

**Prompt:**

```text
You are creating a pull request for the following GitHub issue.

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}
- Worktree: {worktree_path}

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
You have finished your PR creation attempt.  Please evaluate the
result and respond with exactly one of the following keywords:

- COMPLETED — if the pull request was created successfully
- BLOCKED — if you could not create the PR and need user intervention

If BLOCKED, add a brief reason on the next line explaining what
went wrong (e.g. auth failure, push rejected, PR already exists).
```

**Ambiguous response handling:** If the completion check response
does not clearly match `COMPLETED` or `BLOCKED`, the orchestrator
resumes the same session with a clarification prompt (rather than
re-running the PR creation step, which would be side-effectful).
If clarification also fails, the response is shown to the user.

**Outcome handling:** PR creation is a required step
(`requiresArtifact: true`). If `BLOCKED`, only **Instruct** and
**Halt** are offered — **Proceed** is not available because
subsequent stages depend on the PR.

---

### Stage 4: CI check loop

**Agent:** A (only on failure)\
**Purpose:** Wait for CI to pass. If CI fails, collect failure
logs and send them to Agent A for a fix.

The orchestrator polls CI status at 30-second intervals. While
CI is pending, the handler waits internally without consuming
the loop budget. When CI passes, the stage
completes immediately.

**CI fix prompt** (sent only when CI fails):

```text
You are fixing CI failures for the following GitHub issue.

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}
- Worktree: {worktree_path}

## Issue #{number}: {title}

{issue_body}

## CI Failure Logs

{ci_failure_logs}

## Instructions

Diagnose and fix the CI failures shown above.  After making your
changes:

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
auto-budget (default: 3). When the budget is exhausted, the user
is asked whether to continue.

---

### Stage 5: Test plan verification loop

**Agent:** A\
**Purpose:** Execute each item in the PR's test plan checklist and
check off completed tasks in the issue.

**Verify prompt:**

```text
You are verifying the test plan for the following GitHub issue.

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}
- Worktree: {worktree_path}

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

**Self-check prompt:**

```text
Based on your verification above, evaluate the current state.

- Are ALL test plan items in the PR checked off?
- Are ALL task checklist items in the issue checked off?  Also check
  off completed tasks in the issue's parent issue (and grandparent,
  recursively) when applicable.
- Is CI still passing?

If you found and fixed issues during verification, end your
response with the keyword FIXED.

If everything is verified and passing with no changes needed,
end your response with the keyword DONE.
```

**Loop behavior:** `FIXED` -> repeat the verification loop.
`DONE` -> proceed to review. Default auto-budget: 3 iterations.

---

### Stage 6: Review loop

**Agents:** B (reviewer) and A (author)\
**Purpose:** Independent code review by Agent B, with Agent A
addressing feedback. Multi-round until approval.

Since both agents operate under the same GitHub account, comments
are distinguished by prefix and round number.

#### Review prompt — Agent B (round N)

```text
You are reviewing a pull request for the following GitHub issue.

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}
- Worktree: {worktree_path}

## Issue #{number}: {title}

{issue_body}

## Instructions

1. Find the pull request for this branch (use `gh pr view`).
2. Review the code changes in the PR.  Evaluate correctness,
   test coverage, error handling, security, and performance.
3. Post your review as a PR comment prefixed with
   `**[Reviewer Round {n}]**`.
4. End your response with one of these keywords:
   - APPROVED — if the changes are ready to merge
   - NOT_APPROVED — if changes are needed
```

For follow-up reviews (round > 1), step 2 changes to read the
author's previous response first:

```text
2. Read the author's response in the PR comment prefixed with
   `[Author Round {n-1}]` to understand what was changed.
3. Review the updated code changes in the PR.  Evaluate
   correctness, test coverage, error handling, security, and
   performance.
4. Post your follow-up review as a PR comment prefixed with
   `**[Reviewer Round {n}]**`.
5. End your response with one of these keywords:
   - APPROVED — if the changes are ready to merge
   - NOT_APPROVED — if changes are needed
```

#### Author fix prompt — Agent A (round N)

Sent when Agent B returns `NOT_APPROVED`:

```text
You are addressing review feedback for the following GitHub issue.

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}
- Worktree: {worktree_path}

## Issue #{number}: {title}

{issue_body}

## Instructions

1. Find the pull request for this branch (use `gh pr view`).
2. Read the review comments prefixed with `[Reviewer Round {n}]`
   (only comments from your own account).
3. Fix all agreed-upon items from the review.
4. Post a response as a PR comment prefixed with
   `**[Author Round {n}]**` summarising what you changed.
5. If your code changes affect the visual output shown in existing
   screenshots, retake those screenshots by starting the application,
   opening a browser, and capturing updated images.
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
You have finished addressing the review feedback.  Please evaluate
the result and respond with exactly one of the following keywords:

- COMPLETED — if all feedback was addressed and changes were pushed
- BLOCKED — if you cannot proceed and need user intervention
```

After Agent A pushes, the orchestrator runs an internal CI
poll-and-fix loop (up to 3 fix attempts). Once CI passes, the
next review round begins.

#### Unresolved summary — Agent B

When the review loop ends (either because B approves or the
auto-budget is exhausted), B is asked:

```text
The review loop has ended.  Please check whether there are any
unresolved items from this review cycle.

- If there are unresolved items, post a PR comment prefixed with
  `**[Reviewer Unresolved Round {n}]**` listing each unresolved item.
  Then end your response with COMPLETED.
- If there are no unresolved items, respond with exactly: NONE
```

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

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}
- Worktree: {worktree_path}

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
5. End your response with PR_FINALIZED.
```

Agent A must respond with `PR_FINALIZED` for the stage to
complete.

**Loop behavior:** Default auto-budget: 5 rounds (configurable
via `reviewAutoRounds`). When the budget is exhausted, the user
is asked whether to continue.

---

### Stage 7: Squash commits

**Agent:** A\
**Purpose:** Consolidate branch commits into one or a few
meaningful commits. Skipped automatically if the branch has only
one commit.

**Prompt:**

```text
You are squashing commits for the following GitHub issue.

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}
- Worktree: {worktree_path}

## Issue #{number}: {title}

{issue_body}

## Instructions

1. Before pushing, check whether the PR description still accurately
   reflects the current code changes.  Run
   `gh pr view --json body --jq .body` to read the current
   description, then compare it against what the branch actually does.
   If the description is outdated or inaccurate, update it using
   `gh pr edit --body "..."`.  Keep the issue reference
   (Closes #{number} or Part of #{number}) in the body.
2. Review the commits after the base commit `{baseSha}` and
   consolidate them into one or a few meaningful commits.  Only
   commits introduced on this branch should be touched — do not
   include commits from the base branch.  Use
   `git reset --soft {baseSha}` followed by `git commit`, or an
   interactive rebase — whichever is simpler.
3. Write clear, concise commit messages that summarise the changes.
   Do not include issue or PR numbers in the commit title.
   Instead, reference the issue in the commit body using
   `Closes #N` or `Part of #N`.
4. Force-push the branch (`git push --force-with-lease`).
```

**Completion check:**

```text
You have finished your squash attempt.  Please evaluate the result
and respond with exactly one of the following keywords:

- COMPLETED — if the commits were squashed and force-pushed
- BLOCKED — if you could not squash and need user intervention

If BLOCKED, add a brief reason on the next line explaining what
went wrong.
```

**Ambiguous response handling:** Same internal clarification
retry pattern as stage 3 (Create PR).

**Post-squash CI:** After a successful squash and force-push, the
orchestrator polls CI and invokes Agent A to fix failures if
needed (up to 3 internal fix attempts). The stage only completes
when CI passes.

**Outcome handling:** `requiresArtifact: true` — if `BLOCKED`,
only **Instruct** and **Halt** are offered.

---

### Stage 8: Done

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

2. **Based on the result:**

   - **MERGEABLE** -> proceed to merge confirmation.

   - **CONFLICTING** -> offer the user a choice:
     - **Agent rebase** — invoke Agent A to rebase onto the
       latest default branch. Only one rebase attempt is allowed
       per pipeline run. After the attempt:
       - If **successful**: the orchestrator polls CI. If CI
         passes, proceed to merge confirmation. If CI fix
         attempts are exhausted, offer cleanup and exit.
       - If **failed** (`BLOCKED`): the user is notified and
         prompted to resolve conflicts manually. After manual
         resolution, the mergeable status is re-checked.
       - If rebase was **already attempted** earlier in this
         run: the agent rebase option is not offered. The user
         is prompted to resolve manually.
     - **Manual** — pause and wait for the user to resolve
       conflicts outside of AgentCoop (e.g., in their own
       terminal). Once the user signals completion, the
       orchestrator re-checks the mergeable status. If still
       conflicting, the flow loops back.

   - **UNKNOWN** (after exhausting retries) -> offer:
     **Recheck** (re-poll with backoff) or **Exit**.

3. **Merge confirmation** — the user chooses:
   - **Merged** — the user has merged the PR externally. Stop
     running services (e.g., Docker Compose), clean up the git
     worktree and branch, and report completion.
   - **Check conflicts** — run the mergeable check again without
     leaving this screen. This lets the user verify the state
     right before merging. If conflicts are found here, the same
     conflict resolution flow (agent rebase or manual) is
     available. After resolution, the merge confirmation is
     re-presented.
   - **Exit** — stop the pipeline without merging. The
     orchestrator offers cleanup options: stop running services,
     delete the worktree, delete the remote branch, and close
     the PR. Each action is individually selectable.

**Agent rebase prompt:**

```text
You are rebasing a feature branch onto the latest main.

## Repository
- Owner: {owner}
- Repo: {repo}
- Branch: {branch}
- Worktree: {worktree_path}

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

When you are done, end your response with exactly one of:
- COMPLETED — if the rebase succeeded and was force-pushed.
- BLOCKED — if you could not resolve conflicts or tests failed.
```

**Rebase constraints and rationale:**

- **One attempt per run.** Agent rebase is limited to a single
  attempt across the entire pipeline run, regardless of how many
  times the user loops back through the merge confirmation flow.
  This prevents the agent from repeatedly attempting (and failing)
  a difficult rebase.
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
  local tests passed.
- **Fallback to manual.** If the agent rebase fails, or if it
  was already attempted, the user is always offered manual
  resolution as a fallback.

## Orchestrator-managed operations

The following operations are handled directly by the orchestrator,
not delegated to agents:

- **Repository bootstrap:** If the repository is not cloned under
  `cloneBaseDir/{owner}/{repo}`, clone it. If already cloned,
  fetch the latest remote state. If a worktree for the same branch
  already exists, prompt the user to reuse, clean up, or halt.
- **Default branch detection:** Query via
  `gh repo view {owner}/{repo} --json defaultBranchRef` instead
  of assuming `main`.
- **Worktree creation:** Create a git worktree from the latest
  remote default branch at
  `~/.agentcoop/worktrees/{owner}/{repo}/issue-{number}`, outside
  the repository to avoid pollution.
- **PR number extraction:** After Agent A creates a PR, extract
  the number via `gh pr list --head {branch} --json number`.
- **CI status polling:** Check CI status and collect failure
  details. A CI check is considered passed when all required
  checks succeed. `pending` -> wait and re-poll. `skipped` ->
  ignore. `cancelled` -> treat as failure.
- **Mergeable status checking:** Query the GitHub API with
  exponential backoff to handle the `UNKNOWN` state that occurs
  while GitHub computes mergeability.
- **Inactivity timeout:** If no output is received from an agent
  process for a configurable duration (default: 20 minutes), kill
  the process and resume the session automatically. Auto-resume up
  to 3 times; on the 4th timeout, ask the user. This is a silence
  timeout, not a total execution timeout.
