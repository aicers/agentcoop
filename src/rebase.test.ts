import { describe, expect, test, vi } from "vitest";
import type { AgentAdapter, AgentResult, AgentStream } from "./agent.js";
import type { StageContext } from "./pipeline.js";
import {
  buildRebasePrompt,
  buildRebaseVerdictPrompt,
  createRebaseHandler,
  REBASE_KEYWORDS,
} from "./rebase.js";

// ---- helpers ---------------------------------------------------------------

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    sessionId: "sess-1",
    responseText: "COMPLETED",
    status: "success",
    errorType: undefined,
    stderrText: "",
    ...overrides,
  };
}

function makeStream(result: AgentResult): AgentStream {
  return {
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true, value: "" }) };
    },
    result: Promise.resolve(result),
    child: {} as AgentStream["child"],
  };
}

const BASE_CTX: StageContext = {
  owner: "org",
  repo: "repo",
  issueNumber: 42,
  branch: "issue-42",
  worktreePath: "/tmp/wt",
  iteration: 0,
  lastAutoIteration: false,
  userInstruction: undefined,
};

// ---- prompt builders -------------------------------------------------------

describe("buildRebasePrompt", () => {
  test("includes repository context", () => {
    const prompt = buildRebasePrompt(BASE_CTX, "main");
    expect(prompt).toContain("Owner: org");
    expect(prompt).toContain("Repo: repo");
    expect(prompt).toContain("Branch: issue-42");
  });

  test("references the default branch", () => {
    const prompt = buildRebasePrompt(BASE_CTX, "develop");
    expect(prompt).toContain("git fetch origin develop");
    expect(prompt).toContain("git rebase origin/develop");
  });
});

describe("buildRebaseVerdictPrompt", () => {
  test("mentions COMPLETED and BLOCKED", () => {
    const prompt = buildRebaseVerdictPrompt();
    expect(prompt).toContain("COMPLETED");
    expect(prompt).toContain("BLOCKED");
  });

  test("does not contain work instructions", () => {
    const prompt = buildRebaseVerdictPrompt();
    expect(prompt).not.toContain("git fetch");
    expect(prompt).not.toContain("git rebase");
  });
});

// ---- createRebaseHandler ---------------------------------------------------

describe("createRebaseHandler", () => {
  test("COMPLETED → success: true", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "rebased OK" })),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(result.message).toBe("rebased OK");
  });

  test("BLOCKED → outcome: blocked with agent message", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(makeResult({ responseText: "could not resolve" })),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "BLOCKED" }))),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
    // BLOCKED keeps the work-step response so the user sees the
    // agent's own explanation.
    expect(result.message).toBe("could not resolve");
  });

  test("ambiguous verdict → clarification retry → COMPLETED", async () => {
    let resumeCall = 0;
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "rebased" }))),
      resume: vi.fn().mockImplementation(() => {
        resumeCall++;
        if (resumeCall === 1) {
          return makeStream(makeResult({ responseText: "I think it worked" }));
        }
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(agent.resume).toHaveBeenCalledTimes(2);
  });

  test("out-of-scope DONE → clarification retry → BLOCKED", async () => {
    let resumeCall = 0;
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "rebased" }))),
      resume: vi.fn().mockImplementation(() => {
        resumeCall++;
        if (resumeCall === 1) {
          return makeStream(makeResult({ responseText: "DONE" }));
        }
        return makeStream(makeResult({ responseText: "BLOCKED" }));
      }),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    expect(result.outcome).toBe("blocked");
    expect(agent.resume).toHaveBeenCalledTimes(2);
  });

  test("out-of-scope APPROVED → clarification retry → COMPLETED", async () => {
    let resumeCall = 0;
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "rebased" }))),
      resume: vi.fn().mockImplementation(() => {
        resumeCall++;
        if (resumeCall === 1) {
          return makeStream(makeResult({ responseText: "APPROVED" }));
        }
        return makeStream(makeResult({ responseText: "COMPLETED" }));
      }),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    expect(result.outcome).toBe("completed");
    expect(agent.resume).toHaveBeenCalledTimes(2);
  });

  test("FIXED is out-of-scope and not treated as completed", async () => {
    let resumeCall = 0;
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "rebased" }))),
      resume: vi.fn().mockImplementation(() => {
        resumeCall++;
        if (resumeCall === 1) {
          // FIXED triggers clarification (out-of-scope)
          return makeStream(makeResult({ responseText: "FIXED" }));
        }
        // After clarification, still returns FIXED
        return makeStream(makeResult({ responseText: "FIXED" }));
      }),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    // FIXED is not in REBASE_KEYWORDS → treated as BLOCKED-equivalent.
    expect(result.outcome).toBe("blocked");
  });

  test("agent work step error → outcome: error with diagnostic detail", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            stderrText: "segfault",
            exitCode: 139,
            responseText: "crash",
          }),
        ),
      ),
      resume: vi.fn(),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    // The message carries the buildErrorDetail output so the user
    // can see what actually went wrong, not the bare response text.
    expect(result.message).toContain("execution_error");
    expect(result.message).toContain("segfault");
    expect(agent.resume).not.toHaveBeenCalled();
    // logAgentFailure writes the full diagnostic trail to stderr.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("verdict follow-up error → outcome: error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "rebased" }))),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            stderrText: "verdict crash",
            responseText: "",
          }),
        ),
      ),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("verdict crash");
    errorSpy.mockRestore();
  });

  test("clarification retry error → outcome: error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let resumeCall = 0;
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "rebased" }))),
      resume: vi.fn().mockImplementation(() => {
        resumeCall++;
        if (resumeCall === 1) {
          return makeStream(makeResult({ responseText: "I think it worked" }));
        }
        return makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            stderrText: "clarify crash",
            responseText: "",
          }),
        );
      }),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    expect(result.outcome).toBe("error");
    expect(result.message).toContain("clarify crash");
    errorSpy.mockRestore();
  });

  test("reports session ID via onSessionId", async () => {
    const onSessionId = vi.fn();
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(
          makeStream(
            makeResult({ sessionId: "sess-42", responseText: "rebased" }),
          ),
        ),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };
    const handler = createRebaseHandler(agent, "main");
    await handler({ ...BASE_CTX, onSessionId });

    expect(onSessionId).toHaveBeenCalledWith("a", "sess-42");
  });

  test("sinks receive prompts", async () => {
    const promptSink = vi.fn();
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "rebased" }))),
      resume: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "COMPLETED" }))),
    };
    const handler = createRebaseHandler(agent, "main");
    await handler({ ...BASE_CTX, promptSinks: { a: promptSink } });

    // Work prompt + verdict prompt
    expect(promptSink).toHaveBeenCalledTimes(2);
    expect(promptSink.mock.calls[0][0]).toContain("git rebase");
    expect(promptSink.mock.calls[1][0]).toContain("COMPLETED");
  });
});

describe("REBASE_KEYWORDS", () => {
  test("contains only COMPLETED and BLOCKED", () => {
    expect([...REBASE_KEYWORDS]).toEqual(["COMPLETED", "BLOCKED"]);
  });
});
