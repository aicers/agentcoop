import { afterEach, describe, expect, test, vi } from "vitest";
import type { Config } from "./config.js";
import type { Issue } from "./github.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mockSelect = vi.fn();
const mockSearch = vi.fn();
const mockInput = vi.fn();
const mockConfirm = vi.fn();
const mockCheckbox = vi.fn();

vi.mock("@inquirer/prompts", () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  search: (...args: unknown[]) => mockSearch(...args),
  input: (...args: unknown[]) => mockInput(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
  checkbox: (...args: unknown[]) => mockCheckbox(...args),
}));

const mockLoadConfig = vi.fn();
const mockSaveConfig = vi.fn();

vi.mock("./config.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
}));

const mockListRepositories = vi.fn();
const mockGetIssue = vi.fn();

vi.mock("./github.js", () => ({
  listRepositories: (...args: unknown[]) => mockListRepositories(...args),
  getIssue: (...args: unknown[]) => mockGetIssue(...args),
}));

const { runStartup } = await import("./startup.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function defaultConfig(): Config {
  return {
    owners: ["aicers", "my-org"],
    cloneBaseDir: "~/projects",
    language: "en",
    pipelineSettings: {
      selfCheckAutoIterations: 3,
      reviewAutoRounds: 3,
      inactivityTimeoutMinutes: 15,
      autoResumeAttempts: 3,
    },
  };
}

function defaultIssue(): Issue {
  return {
    number: 42,
    title: "Fix authentication",
    body: "Auth is broken when using SSO",
    state: "OPEN",
    labels: ["bug"],
  };
}

function setupHappyPath() {
  mockLoadConfig.mockReturnValue(defaultConfig());
  mockSelect
    .mockResolvedValueOnce("aicers") // owner
    .mockResolvedValueOnce("opus") // agent A model
    .mockResolvedValueOnce("gpt-5.4") // agent B model
    .mockResolvedValueOnce("auto") // execution mode
    .mockResolvedValueOnce("auto") // permission mode
    .mockResolvedValueOnce("en"); // language
  mockSearch.mockResolvedValueOnce("agentcoop"); // repo
  mockInput.mockResolvedValueOnce("42"); // issue number
  mockCheckbox.mockResolvedValueOnce([]); // no pipeline settings adjusted
  mockListRepositories.mockReturnValue([
    { name: "agentcoop", description: "Multi-agent CLI" },
  ]);
  mockGetIssue.mockReturnValue(defaultIssue());
  mockConfirm.mockResolvedValueOnce(true); // confirm issue
}

afterEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
describe("runStartup — happy path", () => {
  test("returns complete StartupResult with correct values", async () => {
    setupHappyPath();
    const result = await runStartup();

    expect(result.owner).toBe("aicers");
    expect(result.repo).toBe("agentcoop");
    expect(result.issue).toEqual(defaultIssue());
    expect(result.agentA).toEqual({ model: "opus" });
    expect(result.agentB).toEqual({ model: "gpt-5.4" });
    expect(result.executionMode).toBe("auto");
    expect(result.claudePermissionMode).toBe("auto");
    expect(result.language).toBe("en");
    expect(result.pipelineSettings).toEqual({
      selfCheckAutoIterations: 3,
      reviewAutoRounds: 3,
      inactivityTimeoutMinutes: 15,
      autoResumeAttempts: 3,
    });
  });

  test("calls loadConfig exactly once", async () => {
    setupHappyPath();
    await runStartup();
    expect(mockLoadConfig).toHaveBeenCalledOnce();
  });

  test("calls listRepositories with selected owner", async () => {
    setupHappyPath();
    await runStartup();
    expect(mockListRepositories).toHaveBeenCalledWith("aicers");
  });

  test("calls getIssue with owner, repo, and issue number", async () => {
    setupHappyPath();
    await runStartup();
    expect(mockGetIssue).toHaveBeenCalledWith("aicers", "agentcoop", 42);
  });

  test("does not save config when nothing changed", async () => {
    setupHappyPath();
    await runStartup();
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Owner selection
// ---------------------------------------------------------------------------
describe("runStartup — owner selection", () => {
  test("prompts for input when owners list is empty", async () => {
    const config: Config = {
      owners: [],
      cloneBaseDir: "~/projects",
      language: "en" as const,
      pipelineSettings: {
        selfCheckAutoIterations: 3,
        reviewAutoRounds: 3,
        inactivityTimeoutMinutes: 15,
        autoResumeAttempts: 3,
      },
    };
    mockLoadConfig.mockReturnValue(config);
    mockInput
      .mockResolvedValueOnce("new-org") // owner input
      .mockResolvedValueOnce("1"); // issue number
    mockSelect
      .mockResolvedValueOnce("sonnet") // agent A
      .mockResolvedValueOnce("gpt-5.3-codex") // agent B
      .mockResolvedValueOnce("step") // execution mode
      .mockResolvedValueOnce("bypass") // permission mode
      .mockResolvedValueOnce("ko"); // language
    mockCheckbox.mockResolvedValueOnce([]); // no pipeline settings adjusted
    mockSearch.mockResolvedValueOnce("repo1");
    mockListRepositories.mockReturnValue([{ name: "repo1", description: "" }]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm.mockResolvedValueOnce(true);

    const result = await runStartup();
    expect(result.owner).toBe("new-org");
    expect(config.owners).toContain("new-org");
    // Config is saved once at the end with both owner and language changes
    expect(mockSaveConfig).toHaveBeenCalledOnce();
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        owners: ["new-org"],
        language: "ko",
      }),
    );
  });

  test("rejects empty owner input via validate", async () => {
    const config = defaultConfig();
    config.owners = [];
    mockLoadConfig.mockReturnValue(config);

    let ownerCallDone = false;
    mockInput.mockImplementation(
      async (opts: {
        message: string;
        validate?: (v: string) => string | true;
      }) => {
        if (!ownerCallDone) {
          ownerCallDone = true;
          // This is the owner input
          expect(opts.validate).toBeDefined();
          expect(opts.validate?.("")).toBe("Owner cannot be empty");
          expect(opts.validate?.("   ")).toBe("Owner cannot be empty");
          expect(opts.validate?.("aicers")).toBe(true);
          return "aicers";
        }
        // This is the issue number input
        return "42";
      },
    );
    mockSelect
      .mockResolvedValueOnce("opus")
      .mockResolvedValueOnce("gpt-5.4")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("en");
    mockCheckbox.mockResolvedValueOnce([]);
    mockSearch.mockResolvedValueOnce("repo1");
    mockListRepositories.mockReturnValue([{ name: "repo1", description: "" }]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm.mockResolvedValueOnce(true);

    await runStartup();
  });

  test("trims whitespace from manually entered owner", async () => {
    const config = defaultConfig();
    config.owners = [];
    mockLoadConfig.mockReturnValue(config);
    mockInput
      .mockResolvedValueOnce("  aicers  ") // owner with spaces
      .mockResolvedValueOnce("42");
    mockSelect
      .mockResolvedValueOnce("opus")
      .mockResolvedValueOnce("gpt-5.4")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("en");
    mockCheckbox.mockResolvedValueOnce([]);
    mockSearch.mockResolvedValueOnce("repo1");
    mockListRepositories.mockReturnValue([{ name: "repo1", description: "" }]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm.mockResolvedValueOnce(true);

    const result = await runStartup();
    expect(result.owner).toBe("aicers");
    expect(config.owners).toContain("aicers");
    expect(config.owners).not.toContain("  aicers  ");
  });

  test("presents configured owners as select choices", async () => {
    setupHappyPath();
    await runStartup();
    expect(mockSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select organization:",
        choices: [
          { name: "aicers", value: "aicers" },
          { name: "my-org", value: "my-org" },
        ],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Repository selection
// ---------------------------------------------------------------------------
describe("runStartup — repository selection", () => {
  test("throws when no repositories found for owner", async () => {
    mockLoadConfig.mockReturnValue(defaultConfig());
    mockSelect.mockResolvedValueOnce("aicers");
    mockListRepositories.mockReturnValue([]);

    await expect(runStartup()).rejects.toThrow(
      "No repositories found for aicers",
    );
  });

  test("search source function filters repos by name", async () => {
    setupHappyPath();
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "CLI tool" },
      { name: "aice-web", description: "Web app" },
      { name: "other", description: "Something else" },
    ]);

    // Capture the source function passed to search
    mockSearch.mockImplementation(
      async (opts: {
        source: (term: string) => { name: string; value: string }[];
      }) => {
        const allResults = opts.source("");
        expect(allResults).toHaveLength(3);

        const filtered = opts.source("agent");
        expect(filtered).toHaveLength(1);
        expect(filtered[0].value).toBe("agentcoop");

        return "agentcoop";
      },
    );

    await runStartup();
  });

  test("search source function filters repos by description", async () => {
    setupHappyPath();
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "CLI tool" },
      { name: "aice-web", description: "Web app" },
    ]);

    mockSearch.mockImplementation(
      async (opts: {
        source: (term: string) => { name: string; value: string }[];
      }) => {
        const filtered = opts.source("web");
        expect(filtered).toHaveLength(1);
        expect(filtered[0].value).toBe("aice-web");
        return "agentcoop";
      },
    );

    await runStartup();
  });

  test("search is case-insensitive", async () => {
    setupHappyPath();
    mockListRepositories.mockReturnValue([
      { name: "AgentCoop", description: "CLI Tool" },
      { name: "other", description: "Something" },
    ]);

    mockSearch.mockImplementation(
      async (opts: {
        source: (term: string | undefined) => { name: string; value: string }[];
      }) => {
        const upper = opts.source("AGENT");
        expect(upper).toHaveLength(1);
        expect(upper[0].value).toBe("AgentCoop");

        const lower = opts.source("agent");
        expect(lower).toHaveLength(1);

        const mixed = opts.source("cli tool");
        expect(mixed).toHaveLength(1);

        return "AgentCoop";
      },
    );

    await runStartup();
  });

  test("search source returns all repos when term is undefined", async () => {
    setupHappyPath();
    mockListRepositories.mockReturnValue([
      { name: "a", description: "" },
      { name: "b", description: "" },
    ]);

    mockSearch.mockImplementation(
      async (opts: {
        source: (term: string | undefined) => { name: string; value: string }[];
      }) => {
        const results = opts.source(undefined);
        expect(results).toHaveLength(2);
        return "a";
      },
    );

    await runStartup();
  });

  test("search handles repos with null descriptions safely", async () => {
    setupHappyPath();
    mockListRepositories.mockReturnValue([
      { name: "repo1", description: null },
      { name: "repo2", description: "A tool" },
    ]);

    mockSearch.mockImplementation(
      async (opts: {
        source: (term: string | undefined) => { name: string; value: string }[];
      }) => {
        // Searching by a term that only matches description should not crash on null
        const filtered = opts.source("tool");
        expect(filtered).toHaveLength(1);
        expect(filtered[0].value).toBe("repo2");

        // Null description repo should show name only
        const all = opts.source(undefined);
        expect(all[0].name).toBe("repo1");
        expect(all[1].name).toBe("repo2 — A tool");

        return "repo1";
      },
    );

    await runStartup();
  });

  test("search source returns empty array when nothing matches", async () => {
    setupHappyPath();
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "CLI tool" },
      { name: "aice-web", description: "Web app" },
    ]);

    mockSearch.mockImplementation(
      async (opts: {
        source: (term: string) => { name: string; value: string }[];
      }) => {
        const filtered = opts.source("zzz-no-match");
        expect(filtered).toEqual([]);
        return "agentcoop";
      },
    );

    await runStartup();
  });

  test("search source displays description when present", async () => {
    setupHappyPath();
    mockListRepositories.mockReturnValue([
      { name: "repo1", description: "Has description" },
      { name: "repo2", description: "" },
    ]);

    mockSearch.mockImplementation(
      async (opts: {
        source: (term: string) => { name: string; value: string }[];
      }) => {
        const results = opts.source("");
        expect(results[0].name).toBe("repo1 — Has description");
        expect(results[1].name).toBe("repo2");
        return "repo1";
      },
    );

    await runStartup();
  });
});

// ---------------------------------------------------------------------------
// Issue number input
// ---------------------------------------------------------------------------
describe("runStartup — issue number input", () => {
  test("rejects non-numeric input via validate", async () => {
    setupHappyPath();

    mockInput.mockImplementation(
      async (opts: { validate: (v: string) => string | true }) => {
        expect(opts.validate("abc")).toBe("Enter a valid issue number");
        expect(opts.validate("0")).toBe("Enter a valid issue number");
        expect(opts.validate("-1")).toBe("Enter a valid issue number");
        expect(opts.validate("3.5")).toBe("Enter a valid issue number");
        expect(opts.validate("")).toBe("Enter a valid issue number");
        expect(opts.validate("42")).toBe(true);
        expect(opts.validate("1")).toBe(true);
        return "42";
      },
    );

    await runStartup();
  });
});

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------
describe("runStartup — model selection", () => {
  test("offers all Claude and Codex models as choices", async () => {
    setupHappyPath();
    await runStartup();

    // Agent A model selection is the 2nd select call
    const agentACall = mockSelect.mock.calls[1][0];
    const values = agentACall.choices.map((c: { value: string }) => c.value);
    expect(values).toContain("opus");
    expect(values).toContain("sonnet");
    expect(values).toContain("gpt-5.4");
    expect(values).toContain("gpt-5.3-codex");
    expect(values).toHaveLength(4);
  });

  test("agent A and B can use different models", async () => {
    setupHappyPath();
    mockSelect
      .mockReset()
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("sonnet") // agent A
      .mockResolvedValueOnce("gpt-5.3-codex") // agent B
      .mockResolvedValueOnce("step") // execution mode
      .mockResolvedValueOnce("bypass") // permission mode
      .mockResolvedValueOnce("en"); // language
    mockConfirm.mockResolvedValueOnce(true);

    const result = await runStartup();
    expect(result.agentA.model).toBe("sonnet");
    expect(result.agentB.model).toBe("gpt-5.3-codex");
  });
});

// ---------------------------------------------------------------------------
// Language selection
// ---------------------------------------------------------------------------
describe("runStartup — language selection", () => {
  test("saves config when language changes", async () => {
    const config = defaultConfig();
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("aicers")
      .mockResolvedValueOnce("opus")
      .mockResolvedValueOnce("gpt-5.4")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("ko"); // changed from "en" to "ko"
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockCheckbox.mockResolvedValueOnce([]);
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm.mockResolvedValueOnce(true);

    const result = await runStartup();
    expect(result.language).toBe("ko");
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ language: "ko" }),
    );
  });

  test("passes current config language as default to select", async () => {
    const config = defaultConfig();
    config.language = "ko";
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("aicers")
      .mockResolvedValueOnce("opus")
      .mockResolvedValueOnce("gpt-5.4")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("ko"); // same as config, no save
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockCheckbox.mockResolvedValueOnce([]);
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm.mockResolvedValueOnce(true);

    await runStartup();

    // Language select is the 6th select call (owner, agentA, agentB, exec, perm, lang)
    const langCall = mockSelect.mock.calls[5][0];
    expect(langCall.default).toBe("ko");
  });
});

// ---------------------------------------------------------------------------
// Config persistence — dirty tracking
// ---------------------------------------------------------------------------
describe("runStartup — config dirty tracking", () => {
  test("does not save when existing owner selected and language unchanged", async () => {
    setupHappyPath();
    await runStartup();
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  test("saves once when new owner entered and language unchanged", async () => {
    const config = defaultConfig();
    config.owners = [];
    mockLoadConfig.mockReturnValue(config);
    mockInput.mockResolvedValueOnce("new-org").mockResolvedValueOnce("1");
    mockSelect
      .mockResolvedValueOnce("opus")
      .mockResolvedValueOnce("gpt-5.4")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("en"); // same language
    mockCheckbox.mockResolvedValueOnce([]);
    mockSearch.mockResolvedValueOnce("repo1");
    mockListRepositories.mockReturnValue([{ name: "repo1", description: "" }]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm.mockResolvedValueOnce(true);

    await runStartup();
    expect(mockSaveConfig).toHaveBeenCalledOnce();
  });

  test("saves once when language changed but owner already existed", async () => {
    const config = defaultConfig();
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("aicers")
      .mockResolvedValueOnce("opus")
      .mockResolvedValueOnce("gpt-5.4")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("ko"); // changed
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockCheckbox.mockResolvedValueOnce([]);
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm.mockResolvedValueOnce(true);

    await runStartup();
    expect(mockSaveConfig).toHaveBeenCalledOnce();
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ language: "ko" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------
describe("runStartup — error propagation", () => {
  test("propagates getIssue error when issue not found", async () => {
    setupHappyPath();
    mockGetIssue.mockImplementation(() => {
      throw new Error("Could not resolve to an issue");
    });

    await expect(runStartup()).rejects.toThrow("Could not resolve to an issue");
  });

  test("propagates listRepositories error when gh fails", async () => {
    mockLoadConfig.mockReturnValue(defaultConfig());
    mockSelect.mockResolvedValueOnce("aicers");
    mockListRepositories.mockImplementation(() => {
      throw new Error("gh: command not found");
    });

    await expect(runStartup()).rejects.toThrow("gh: command not found");
  });

  test("does not save config when listRepositories fails after owner input", async () => {
    const config = defaultConfig();
    config.owners = [];
    mockLoadConfig.mockReturnValue(config);
    mockInput.mockResolvedValueOnce("bad-org");
    mockListRepositories.mockImplementation(() => {
      throw new Error("HTTP 404");
    });

    await expect(runStartup()).rejects.toThrow("HTTP 404");
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  test("does not save config when user declines issue confirmation", async () => {
    setupHappyPath();
    mockConfirm.mockReset().mockResolvedValueOnce(false);

    await expect(runStartup()).rejects.toThrow("Issue not confirmed");
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Stage 1 — Confirm issue
// ---------------------------------------------------------------------------
describe("runStartup — confirm issue (Stage 1)", () => {
  test("throws when user declines confirmation", async () => {
    setupHappyPath();
    mockConfirm.mockReset().mockResolvedValueOnce(false);

    await expect(runStartup()).rejects.toThrow("Issue not confirmed");
  });

  test("shows issue details before confirmation", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setupHappyPath();

    await runStartup();

    const logs = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).toContain("aicers/agentcoop#42");
    expect(logs).toContain("Fix authentication");
    expect(logs).toContain("OPEN");

    consoleSpy.mockRestore();
  });

  test("shows labels when present", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setupHappyPath();
    mockGetIssue.mockReturnValue({
      ...defaultIssue(),
      labels: ["bug", "urgent"],
    });

    await runStartup();

    const logs = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).toContain("bug, urgent");

    consoleSpy.mockRestore();
  });

  test("does not show labels line when labels are empty", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setupHappyPath();
    mockGetIssue.mockReturnValue({
      ...defaultIssue(),
      labels: [],
    });

    await runStartup();

    const logs = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).not.toContain("Labels:");

    consoleSpy.mockRestore();
  });

  test("truncates long body with ellipsis", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setupHappyPath();
    const longBody = "x".repeat(600);
    mockGetIssue.mockReturnValue({
      ...defaultIssue(),
      body: longBody,
    });

    await runStartup();

    const logs = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).toContain("x".repeat(500));
    expect(logs).toContain("…");
    expect(logs).not.toContain("x".repeat(501));

    consoleSpy.mockRestore();
  });

  test("shows full body without ellipsis when short", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setupHappyPath();
    mockGetIssue.mockReturnValue({
      ...defaultIssue(),
      body: "Short body",
    });

    await runStartup();

    const logs = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).toContain("Short body");
    expect(logs).not.toContain("…");

    consoleSpy.mockRestore();
  });

  test("shows exactly 500-char body without ellipsis", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setupHappyPath();
    const exactBody = "y".repeat(500);
    mockGetIssue.mockReturnValue({
      ...defaultIssue(),
      body: exactBody,
    });

    await runStartup();

    const logs = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).toContain(exactBody);
    expect(logs).not.toContain("…");

    consoleSpy.mockRestore();
  });

  test("does not output body section when body is empty", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setupHappyPath();
    mockGetIssue.mockReturnValue({
      ...defaultIssue(),
      body: "",
    });

    await runStartup();

    // Body section is preceded by an extra blank line + body text.
    // With empty body, the only blank lines should be the framing ones.
    const allArgs = consoleSpy.mock.calls.map((c) => c[0]);
    const bodyIndex = allArgs.findIndex(
      (a) => typeof a === "string" && a.includes("Auth is broken"),
    );
    expect(bodyIndex).toBe(-1);

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Full flow with step mode + bypass permission
// ---------------------------------------------------------------------------
describe("runStartup — alternate selections", () => {
  test("step mode + bypass permission + ko language", async () => {
    const config = defaultConfig();
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("my-org")
      .mockResolvedValueOnce("sonnet")
      .mockResolvedValueOnce("gpt-5.3-codex")
      .mockResolvedValueOnce("step")
      .mockResolvedValueOnce("bypass")
      .mockResolvedValueOnce("ko");
    mockSearch.mockResolvedValueOnce("my-repo");
    mockInput.mockResolvedValueOnce("99");
    mockCheckbox.mockResolvedValueOnce([]);
    mockListRepositories.mockReturnValue([
      { name: "my-repo", description: "test" },
    ]);
    mockGetIssue.mockReturnValue({
      number: 99,
      title: "Test issue",
      body: "body",
      state: "OPEN",
      labels: [],
    });
    mockConfirm.mockResolvedValueOnce(true);

    const result = await runStartup();
    expect(result.owner).toBe("my-org");
    expect(result.repo).toBe("my-repo");
    expect(result.issue.number).toBe(99);
    expect(result.agentA.model).toBe("sonnet");
    expect(result.agentB.model).toBe("gpt-5.3-codex");
    expect(result.executionMode).toBe("step");
    expect(result.claudePermissionMode).toBe("bypass");
    expect(result.language).toBe("ko");
  });
});

// ---------------------------------------------------------------------------
// Pipeline settings
// ---------------------------------------------------------------------------
describe("runStartup — pipeline settings", () => {
  test("returns default settings when no adjustments selected", async () => {
    setupHappyPath();
    const result = await runStartup();
    expect(result.pipelineSettings).toEqual({
      selfCheckAutoIterations: 3,
      reviewAutoRounds: 3,
      inactivityTimeoutMinutes: 15,
      autoResumeAttempts: 3,
    });
  });

  test("returns adjusted settings and saves when user confirms", async () => {
    setupHappyPath();
    mockCheckbox
      .mockReset()
      .mockResolvedValueOnce(["selfCheckAutoIterations", "reviewAutoRounds"]);
    // input for the two selected settings
    mockInput.mockReset().mockResolvedValueOnce("42"); // issue number
    mockInput.mockResolvedValueOnce("5"); // selfCheckAutoIterations
    mockInput.mockResolvedValueOnce("7"); // reviewAutoRounds
    // confirm save = yes → config dirty
    mockConfirm.mockReset().mockResolvedValueOnce(true); // save to config?
    mockConfirm.mockResolvedValueOnce(true); // confirm issue

    const result = await runStartup();
    expect(result.pipelineSettings.selfCheckAutoIterations).toBe(5);
    expect(result.pipelineSettings.reviewAutoRounds).toBe(7);
    expect(result.pipelineSettings.inactivityTimeoutMinutes).toBe(15);
    expect(mockSaveConfig).toHaveBeenCalledOnce();
  });

  test("does not save config when user declines save", async () => {
    setupHappyPath();
    mockCheckbox.mockReset().mockResolvedValueOnce(["autoResumeAttempts"]);
    mockInput.mockReset().mockResolvedValueOnce("42"); // issue number
    mockInput.mockResolvedValueOnce("10"); // autoResumeAttempts
    mockConfirm.mockReset().mockResolvedValueOnce(false); // decline save
    mockConfirm.mockResolvedValueOnce(true); // confirm issue

    const result = await runStartup();
    expect(result.pipelineSettings.autoResumeAttempts).toBe(10);
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  test("presents all four settings as checkbox choices", async () => {
    setupHappyPath();
    await runStartup();

    expect(mockCheckbox).toHaveBeenCalledOnce();
    const opts = mockCheckbox.mock.calls[0][0];
    expect(opts.choices).toHaveLength(4);
    const values = opts.choices.map((c: { value: string }) => c.value);
    expect(values).toEqual([
      "selfCheckAutoIterations",
      "reviewAutoRounds",
      "inactivityTimeoutMinutes",
      "autoResumeAttempts",
    ]);
    // Verify labels include current values with unit suffix
    const names = opts.choices.map((c: { name: string }) => c.name);
    expect(names[0]).toBe("Self-check auto iterations: 3");
    expect(names[1]).toBe("Review auto rounds: 3");
    expect(names[2]).toBe("Inactivity timeout: 15 min");
    expect(names[3]).toBe("Auto-resume attempts: 3");
  });

  test("displays current settings from config with unit suffix", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    setupHappyPath();
    await runStartup();

    const logs = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).toContain("Pipeline settings");
    expect(logs).toContain("Self-check auto iterations");
    expect(logs).toContain("Review auto rounds");
    expect(logs).toContain("Inactivity timeout");
    expect(logs).toContain("15 min");
    expect(logs).toContain("Auto-resume attempts");

    consoleSpy.mockRestore();
  });

  test("displays custom settings from config", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const config = defaultConfig();
    config.pipelineSettings.selfCheckAutoIterations = 10;
    config.pipelineSettings.inactivityTimeoutMinutes = 30;
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("aicers")
      .mockResolvedValueOnce("opus")
      .mockResolvedValueOnce("gpt-5.4")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("en");
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockCheckbox.mockResolvedValueOnce([]);
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm.mockResolvedValueOnce(true);

    const result = await runStartup();

    const logs = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).toContain("10");
    expect(logs).toContain("30 min");
    expect(result.pipelineSettings.selfCheckAutoIterations).toBe(10);
    expect(result.pipelineSettings.inactivityTimeoutMinutes).toBe(30);

    consoleSpy.mockRestore();
  });

  test("unchanged fields preserve original values after adjustment", async () => {
    setupHappyPath();
    mockCheckbox.mockReset().mockResolvedValueOnce(["selfCheckAutoIterations"]);
    mockInput.mockReset().mockResolvedValueOnce("42"); // issue number
    mockInput.mockResolvedValueOnce("10"); // selfCheckAutoIterations only
    mockConfirm.mockReset().mockResolvedValueOnce(false); // decline save
    mockConfirm.mockResolvedValueOnce(true); // confirm issue

    const result = await runStartup();
    expect(result.pipelineSettings.selfCheckAutoIterations).toBe(10);
    expect(result.pipelineSettings.reviewAutoRounds).toBe(3);
    expect(result.pipelineSettings.inactivityTimeoutMinutes).toBe(15);
    expect(result.pipelineSettings.autoResumeAttempts).toBe(3);
  });

  test("validates input rejects negative, zero, decimal, and empty values", async () => {
    setupHappyPath();
    mockCheckbox.mockReset().mockResolvedValueOnce(["reviewAutoRounds"]);

    mockInput.mockReset().mockResolvedValueOnce("42"); // issue number
    mockInput.mockImplementationOnce(
      async (opts: {
        message: string;
        default: string;
        validate: (v: string) => string | true;
      }) => {
        expect(opts.validate("")).toBe("Enter a positive integer");
        expect(opts.validate("-1")).toBe("Enter a positive integer");
        expect(opts.validate("0")).toBe("Enter a positive integer");
        expect(opts.validate("3.5")).toBe("Enter a positive integer");
        expect(opts.validate("abc")).toBe("Enter a positive integer");
        expect(opts.validate("5")).toBe(true);
        expect(opts.validate("1")).toBe(true);
        return "5";
      },
    );
    mockConfirm.mockReset().mockResolvedValueOnce(false); // decline save
    mockConfirm.mockResolvedValueOnce(true); // confirm issue

    const result = await runStartup();
    expect(result.pipelineSettings.reviewAutoRounds).toBe(5);
  });

  test("adjusting all four settings works correctly", async () => {
    setupHappyPath();
    mockCheckbox
      .mockReset()
      .mockResolvedValueOnce([
        "selfCheckAutoIterations",
        "reviewAutoRounds",
        "inactivityTimeoutMinutes",
        "autoResumeAttempts",
      ]);
    mockInput.mockReset().mockResolvedValueOnce("42"); // issue number
    mockInput
      .mockResolvedValueOnce("5") // selfCheckAutoIterations
      .mockResolvedValueOnce("7") // reviewAutoRounds
      .mockResolvedValueOnce("30") // inactivityTimeoutMinutes
      .mockResolvedValueOnce("2"); // autoResumeAttempts
    mockConfirm.mockReset().mockResolvedValueOnce(true); // save
    mockConfirm.mockResolvedValueOnce(true); // confirm issue

    const result = await runStartup();
    expect(result.pipelineSettings).toEqual({
      selfCheckAutoIterations: 5,
      reviewAutoRounds: 7,
      inactivityTimeoutMinutes: 30,
      autoResumeAttempts: 2,
    });
    expect(mockSaveConfig).toHaveBeenCalledOnce();
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineSettings: {
          selfCheckAutoIterations: 5,
          reviewAutoRounds: 7,
          inactivityTimeoutMinutes: 30,
          autoResumeAttempts: 2,
        },
      }),
    );
  });

  test("session-only changes do not update config.pipelineSettings", async () => {
    const config = defaultConfig();
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("aicers")
      .mockResolvedValueOnce("opus")
      .mockResolvedValueOnce("gpt-5.4")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("en");
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockCheckbox.mockResolvedValueOnce(["selfCheckAutoIterations"]);
    mockInput.mockResolvedValueOnce("99");
    mockConfirm
      .mockResolvedValueOnce(false) // decline save
      .mockResolvedValueOnce(true); // confirm issue
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());

    const result = await runStartup();
    // Session gets the new value
    expect(result.pipelineSettings.selfCheckAutoIterations).toBe(99);
    // Config object was NOT mutated (save declined)
    expect(config.pipelineSettings.selfCheckAutoIterations).toBe(3);
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  test("input shows current value as default", async () => {
    const config = defaultConfig();
    config.pipelineSettings.autoResumeAttempts = 7;
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("aicers")
      .mockResolvedValueOnce("opus")
      .mockResolvedValueOnce("gpt-5.4")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("auto")
      .mockResolvedValueOnce("en");
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockCheckbox.mockResolvedValueOnce(["autoResumeAttempts"]);
    mockInput.mockImplementationOnce(
      async (opts: { message: string; default: string }) => {
        expect(opts.default).toBe("7");
        return "7";
      },
    );
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());

    await runStartup();
  });
});
