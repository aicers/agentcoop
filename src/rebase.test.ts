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

    expect(result.success).toBe(true);
    expect(result.message).toBe("rebased OK");
  });

  test("BLOCKED → success: false", async () => {
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

    expect(result.success).toBe(false);
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

    expect(result.success).toBe(true);
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

    expect(result.success).toBe(false);
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

    expect(result.success).toBe(true);
    expect(agent.resume).toHaveBeenCalledTimes(2);
  });

  test("FIXED is out-of-scope and not treated as success", async () => {
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

    // FIXED maps to "fixed" status, not "completed" → success: false
    expect(result.success).toBe(false);
  });

  test("agent work step error → success: false", async () => {
    const agent: AgentAdapter = {
      invoke: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            responseText: "crash",
          }),
        ),
      ),
      resume: vi.fn(),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    expect(result.success).toBe(false);
    expect(result.message).toBe("crash");
    expect(agent.resume).not.toHaveBeenCalled();
  });

  test("verdict follow-up error → success: false", async () => {
    const agent: AgentAdapter = {
      invoke: vi
        .fn()
        .mockReturnValue(makeStream(makeResult({ responseText: "rebased" }))),
      resume: vi.fn().mockReturnValue(
        makeStream(
          makeResult({
            status: "error",
            errorType: "execution_error",
            responseText: "verdict crash",
          }),
        ),
      ),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    expect(result.success).toBe(false);
    expect(result.message).toBe("verdict crash");
  });

  test("clarification retry error → success: false", async () => {
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
            responseText: "crash",
          }),
        );
      }),
    };
    const handler = createRebaseHandler(agent, "main");
    const result = await handler(BASE_CTX);

    expect(result.success).toBe(false);
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
