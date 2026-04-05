import { afterEach, describe, expect, test, vi } from "vitest";
import type { Config } from "./config.js";
import type { Issue } from "./github.js";
import { initI18n } from "./i18n/index.js";

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

const { runStartup, selectTarget, modelDisplayName } = await import(
  "./startup.js"
);

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
    .mockResolvedValueOnce("claude") // agent A CLI
    .mockResolvedValueOnce("opus") // agent A model
    .mockResolvedValueOnce("200k") // agent A context window
    .mockResolvedValueOnce("high") // agent A effort
    .mockResolvedValueOnce("codex") // agent B CLI
    .mockResolvedValueOnce("gpt-5.4") // agent B model
    .mockResolvedValueOnce("high") // agent B effort
    .mockResolvedValueOnce("auto") // execution mode
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

afterEach(async () => {
  vi.resetAllMocks();
  await initI18n("en");
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
    expect(result.agentA).toEqual({
      cli: "claude",
      model: "opus",
      contextWindow: "200k",
      effortLevel: "high",
    });
    expect(result.agentB).toEqual({
      cli: "codex",
      model: "gpt-5.4",
      contextWindow: undefined,
      effortLevel: "high",
    });
    expect(result.executionMode).toBe("auto");
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

  test("saves config when agent selections differ from saved", async () => {
    setupHappyPath();
    await runStartup();
    expect(mockSaveConfig).toHaveBeenCalledOnce();
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
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("sonnet") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.3-codex") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("step") // execution mode
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
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
      .mockResolvedValueOnce("en"); // language
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
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
      .mockResolvedValueOnce("en"); // language
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
  test("offers CLI-specific models as choices for agent A", async () => {
    setupHappyPath();
    await runStartup();

    // Agent A CLI selection is the 2nd select call (index 1)
    // Agent A model selection is the 3rd select call (index 2)
    const agentAModelCall = mockSelect.mock.calls[2][0];
    const values = agentAModelCall.choices.map(
      (c: { value: string }) => c.value,
    );
    // Agent A selected "claude" CLI, so only Claude models are shown
    expect(values).toContain("opus");
    expect(values).toContain("sonnet");
    expect(values).not.toContain("gpt-5.4");
    expect(values).not.toContain("gpt-5.3-codex");
    expect(values).toHaveLength(2);
  });

  test("switching CLI seeds defaults from CLI_DEFAULTS", async () => {
    // Config has Claude saved for agent A; user switches to Codex.
    // The model/effort prompts should receive Codex defaults (gpt-5.4, xhigh)
    // instead of falling back to the first choice.
    const config = {
      ...defaultConfig(),
      agentA: {
        cli: "claude" as const,
        model: "opus",
        contextWindow: "1m",
        effortLevel: "high",
      },
    };
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("codex") // agent A CLI — switched!
      .mockResolvedValueOnce("gpt-5.4") // agent A model
      .mockResolvedValueOnce("xhigh") // agent A effort
      .mockResolvedValueOnce("claude") // agent B CLI
      .mockResolvedValueOnce("opus") // agent B model
      .mockResolvedValueOnce("1m") // agent B context window
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
      .mockResolvedValueOnce("en"); // language
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockCheckbox.mockResolvedValueOnce([]);
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm.mockResolvedValueOnce(true);

    await runStartup();

    // Agent A model prompt (index 2) should have Codex default
    const agentAModelCall = mockSelect.mock.calls[2][0];
    expect(agentAModelCall.default).toBe("gpt-5.4");

    // Agent A effort prompt (index 3) should have Codex default
    const agentAEffortCall = mockSelect.mock.calls[3][0];
    expect(agentAEffortCall.default).toBe("xhigh");
  });

  test("agent A and B can use different models", async () => {
    setupHappyPath();
    mockSelect
      .mockReset()
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("sonnet") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.3-codex") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("step") // execution mode
      .mockResolvedValueOnce("en"); // language
    mockConfirm.mockResolvedValueOnce(true);

    const result = await runStartup();
    expect(result.agentA.cli).toBe("claude");
    expect(result.agentA.model).toBe("sonnet");
    expect(result.agentB.cli).toBe("codex");
    expect(result.agentB.model).toBe("gpt-5.3-codex");
  });
});

// ---------------------------------------------------------------------------
// Effort level selection
// ---------------------------------------------------------------------------
describe("runStartup — effort level choices", () => {
  test("offers max effort for Opus but not for Sonnet", async () => {
    setupHappyPath();
    mockSelect
      .mockReset()
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("max") // agent A effort
      .mockResolvedValueOnce("claude") // agent B CLI
      .mockResolvedValueOnce("sonnet") // agent B model
      .mockResolvedValueOnce("200k") // agent B context window
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
      .mockResolvedValueOnce("en"); // language
    mockConfirm.mockResolvedValueOnce(true);

    const result = await runStartup();

    // Agent A (Opus) effort prompt should include "max"
    // index: 0=owner, 1=agentA CLI, 2=agentA model, 3=agentA context, 4=agentA effort
    const agentAEffortCall = mockSelect.mock.calls[4][0];
    const agentAValues = agentAEffortCall.choices.map(
      (c: { value: string }) => c.value,
    );
    expect(agentAValues).toContain("max");
    expect(agentAValues).toEqual(["low", "medium", "high", "max"]);

    // Agent B (Sonnet) effort prompt should NOT include "max"
    // index: 5=agentB CLI, 6=agentB model, 7=agentB context, 8=agentB effort
    const agentBEffortCall = mockSelect.mock.calls[8][0];
    const agentBValues = agentBEffortCall.choices.map(
      (c: { value: string }) => c.value,
    );
    expect(agentBValues).not.toContain("max");
    expect(agentBValues).toEqual(["low", "medium", "high"]);

    expect(result.agentA.effortLevel).toBe("max");
    expect(result.agentB.effortLevel).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// modelDisplayName
// ---------------------------------------------------------------------------
describe("modelDisplayName", () => {
  test("shows Max label for Opus with max effort", () => {
    const name = modelDisplayName({
      cli: "claude",
      model: "opus",
      contextWindow: "1m",
      effortLevel: "max",
    });
    expect(name).toBe("Claude Opus 4.6 (1M) / Max");
  });

  test("shows High label for Sonnet with high effort", () => {
    const name = modelDisplayName({
      cli: "claude",
      model: "sonnet",
      effortLevel: "high",
    });
    expect(name).toBe("Claude Sonnet 4.6 / High");
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
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
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
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
      .mockResolvedValueOnce("ko"); // same as config
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockCheckbox.mockResolvedValueOnce([]);
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm.mockResolvedValueOnce(true);

    await runStartup();

    // Language select call index:
    // 0=owner, 1=agentA CLI, 2=agentA model, 3=agentA context, 4=agentA effort,
    // 5=agentB CLI, 6=agentB model, 7=agentB effort, 8=exec, 9=lang
    const langCall = mockSelect.mock.calls[9][0];
    expect(langCall.default).toBe("ko");
  });
});

// ---------------------------------------------------------------------------
// Config persistence — dirty tracking
// ---------------------------------------------------------------------------
describe("runStartup — config dirty tracking", () => {
  test("does not save config when all selections match saved values", async () => {
    const config = {
      ...defaultConfig(),
      agentA: {
        cli: "claude" as const,
        model: "opus",
        contextWindow: "200k",
        effortLevel: "high",
      },
      agentB: {
        cli: "codex" as const,
        model: "gpt-5.4",
        effortLevel: "high",
      },
      executionMode: "auto" as const,
    };
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
      .mockResolvedValueOnce("en"); // language
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockCheckbox.mockResolvedValueOnce([]);
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm
      .mockResolvedValueOnce(false) // decline quick-start
      .mockResolvedValueOnce(true); // confirm issue

    await runStartup();
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  test("saves config when agent selections differ from saved", async () => {
    setupHappyPath();
    await runStartup();
    expect(mockSaveConfig).toHaveBeenCalledOnce();
  });

  test("saves once when new owner entered and language unchanged", async () => {
    const config = defaultConfig();
    config.owners = [];
    mockLoadConfig.mockReturnValue(config);
    mockInput.mockResolvedValueOnce("new-org").mockResolvedValueOnce("1");
    mockSelect
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
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
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
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
// Full flow with step mode
// ---------------------------------------------------------------------------
describe("runStartup — alternate selections", () => {
  test("step mode + ko language", async () => {
    const config = defaultConfig();
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("my-org") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("sonnet") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.3-codex") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("step") // execution mode
      .mockResolvedValueOnce("ko"); // language
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
    expect(result.agentA.cli).toBe("claude");
    expect(result.agentA.model).toBe("sonnet");
    expect(result.agentB.cli).toBe("codex");
    expect(result.agentB.model).toBe("gpt-5.3-codex");
    expect(result.executionMode).toBe("step");
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

  test("does not persist pipeline settings when user declines save", async () => {
    setupHappyPath();
    mockCheckbox.mockReset().mockResolvedValueOnce(["autoResumeAttempts"]);
    mockInput.mockReset().mockResolvedValueOnce("42"); // issue number
    mockInput.mockResolvedValueOnce("10"); // autoResumeAttempts
    mockConfirm.mockReset().mockResolvedValueOnce(false); // decline save
    mockConfirm.mockResolvedValueOnce(true); // confirm issue

    const result = await runStartup();
    expect(result.pipelineSettings.autoResumeAttempts).toBe(10);
    // Config is still saved (agent selections always persist) but without pipeline changes
    expect(mockSaveConfig).toHaveBeenCalledOnce();
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
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
      .mockResolvedValueOnce("en"); // language
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
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
      .mockResolvedValueOnce("en"); // language
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
    // Config pipelineSettings was NOT mutated (save declined)
    expect(config.pipelineSettings.selfCheckAutoIterations).toBe(3);
    // Config is still saved (agent selections always persist), but with original pipelineSettings
    expect(mockSaveConfig).toHaveBeenCalledOnce();
  });

  test("input shows current value as default", async () => {
    const config = defaultConfig();
    config.pipelineSettings.autoResumeAttempts = 7;
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
      .mockResolvedValueOnce("en"); // language
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

// ---------------------------------------------------------------------------
// selectTarget
// ---------------------------------------------------------------------------
describe("selectTarget", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns owner, repo, issueNumber, config, and configDirty", async () => {
    mockLoadConfig.mockReturnValue(defaultConfig());
    mockSelect.mockResolvedValueOnce("aicers"); // owner
    mockSearch.mockResolvedValueOnce("agentcoop"); // repo
    mockInput.mockResolvedValueOnce("42"); // issue number
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "Multi-agent CLI" },
    ]);

    const result = await selectTarget();
    expect(result.owner).toBe("aicers");
    expect(result.repo).toBe("agentcoop");
    expect(result.issueNumber).toBe(42);
    expect(result.config).toBeDefined();
    expect(result.configDirty).toBe(false);
  });

  test("does not prompt for agent models or execution mode", async () => {
    mockLoadConfig.mockReturnValue(defaultConfig());
    mockSelect.mockResolvedValueOnce("aicers"); // owner
    mockSearch.mockResolvedValueOnce("agentcoop"); // repo
    mockInput.mockResolvedValueOnce("7"); // issue number
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);

    await selectTarget();
    // select called only once for owner (not for models, mode, language).
    expect(mockSelect).toHaveBeenCalledTimes(1);
    // getIssue NOT called (that happens in runStartup).
    expect(mockGetIssue).not.toHaveBeenCalled();
  });

  test("marks configDirty when new owner is entered", async () => {
    mockLoadConfig.mockReturnValue({
      ...defaultConfig(),
      owners: [],
    });
    mockInput
      .mockResolvedValueOnce("new-org") // new owner
      .mockResolvedValueOnce("1"); // issue number
    mockSearch.mockResolvedValueOnce("some-repo");
    mockListRepositories.mockReturnValue([
      { name: "some-repo", description: "" },
    ]);

    const result = await selectTarget();
    expect(result.owner).toBe("new-org");
    expect(result.configDirty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runStartup with pre-selected target
// ---------------------------------------------------------------------------
describe("runStartup with target parameter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("skips owner/repo/issue prompts when target is provided", async () => {
    const config = defaultConfig();
    const target = {
      owner: "aicers",
      repo: "agentcoop",
      issueNumber: 42,
      config,
      configDirty: false,
    };
    // Only prompts needed: agentA (cli+model+context+effort), agentB (cli+model+effort),
    // executionMode, language, settings, confirm.
    mockSelect
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
      .mockResolvedValueOnce("en"); // language
    mockCheckbox.mockResolvedValueOnce([]); // no settings adjusted
    mockConfirm.mockResolvedValueOnce(true); // confirm issue
    mockGetIssue.mockReturnValue(defaultIssue());

    const result = await runStartup(target);
    expect(result.owner).toBe("aicers");
    expect(result.repo).toBe("agentcoop");
    expect(result.issue.number).toBe(42);
    expect(result.agentA.cli).toBe("claude");
    expect(result.agentA.model).toBe("opus");
    expect(result.agentB.cli).toBe("codex");
    expect(result.agentB.model).toBe("gpt-5.4");
    // Should NOT have called search (repo) or input (issue number).
    expect(mockSearch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Quick-start — reuse previous configuration
// ---------------------------------------------------------------------------
describe("runStartup — quick-start", () => {
  function configWithAgents(): Config {
    return {
      ...defaultConfig(),
      agentA: {
        cli: "claude" as const,
        model: "opus",
        contextWindow: "1m",
        effortLevel: "high",
      },
      agentB: {
        cli: "codex" as const,
        model: "gpt-5.4",
        effortLevel: "xhigh",
      },
      executionMode: "auto" as const,
    };
  }

  test("reuses saved config when user accepts quick-start", async () => {
    mockLoadConfig.mockReturnValue(configWithAgents());
    mockSelect.mockResolvedValueOnce("aicers"); // owner
    mockSearch.mockResolvedValueOnce("agentcoop"); // repo
    mockInput.mockResolvedValueOnce("42"); // issue number
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm
      .mockResolvedValueOnce(true) // accept quick-start
      .mockResolvedValueOnce(true); // confirm issue

    const result = await runStartup();

    expect(result.agentA).toEqual({
      cli: "claude",
      model: "opus",
      contextWindow: "1m",
      effortLevel: "high",
    });
    expect(result.agentB).toEqual({
      cli: "codex",
      model: "gpt-5.4",
      effortLevel: "xhigh",
    });
    expect(result.executionMode).toBe("auto");
    expect(result.language).toBe("en");
    // No agent selection prompts should have been shown.
    // select is called once for owner only.
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockCheckbox).not.toHaveBeenCalled();
  });

  test("falls through to full flow when user declines quick-start", async () => {
    mockLoadConfig.mockReturnValue(configWithAgents());
    mockSelect
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("sonnet") // agent A model (different!)
      .mockResolvedValueOnce("200k") // agent A context window
      .mockResolvedValueOnce("medium") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("high") // agent B effort
      .mockResolvedValueOnce("step") // execution mode
      .mockResolvedValueOnce("en"); // language
    mockSearch.mockResolvedValueOnce("agentcoop"); // repo
    mockInput.mockResolvedValueOnce("42"); // issue number
    mockCheckbox.mockResolvedValueOnce([]); // no pipeline settings adjusted
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm
      .mockResolvedValueOnce(false) // decline quick-start
      .mockResolvedValueOnce(true); // confirm issue

    const result = await runStartup();

    expect(result.agentA.model).toBe("sonnet");
    expect(result.executionMode).toBe("step");
  });

  test("is not shown on first run (no saved agents)", async () => {
    setupHappyPath();

    await runStartup();

    // confirm is called once for issue confirmation only.
    // If quick-start were shown, confirm would be called twice.
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  test("is not shown when only agentA is saved", async () => {
    const config = {
      ...defaultConfig(),
      agentA: {
        cli: "claude" as const,
        model: "opus",
        contextWindow: "1m",
        effortLevel: "high",
      },
    };
    mockLoadConfig.mockReturnValue(config);
    mockSelect
      .mockResolvedValueOnce("aicers") // owner
      .mockResolvedValueOnce("claude") // agent A CLI
      .mockResolvedValueOnce("opus") // agent A model
      .mockResolvedValueOnce("1m") // agent A context window
      .mockResolvedValueOnce("high") // agent A effort
      .mockResolvedValueOnce("codex") // agent B CLI
      .mockResolvedValueOnce("gpt-5.4") // agent B model
      .mockResolvedValueOnce("xhigh") // agent B effort
      .mockResolvedValueOnce("auto") // execution mode
      .mockResolvedValueOnce("en"); // language
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockCheckbox.mockResolvedValueOnce([]);
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm.mockResolvedValueOnce(true); // confirm issue

    await runStartup();

    // confirm called once (issue only), not twice (quick-start + issue).
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  test("throws when user declines issue confirmation after quick-start", async () => {
    mockLoadConfig.mockReturnValue(configWithAgents());
    mockSelect.mockResolvedValueOnce("aicers");
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm
      .mockResolvedValueOnce(true) // accept quick-start
      .mockResolvedValueOnce(false); // decline issue

    await expect(runStartup()).rejects.toThrow("Issue not confirmed");
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  test("saves config when configDirty and quick-start accepted", async () => {
    const config = configWithAgents();
    config.owners = [];
    mockLoadConfig.mockReturnValue(config);
    mockInput
      .mockResolvedValueOnce("new-org") // new owner (marks dirty)
      .mockResolvedValueOnce("42"); // issue number
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm
      .mockResolvedValueOnce(true) // accept quick-start
      .mockResolvedValueOnce(true); // confirm issue

    await runStartup();

    expect(mockSaveConfig).toHaveBeenCalledOnce();
  });

  test("displays saved config summary", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockLoadConfig.mockReturnValue(configWithAgents());
    mockSelect.mockResolvedValueOnce("aicers");
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm
      .mockResolvedValueOnce(true) // accept quick-start
      .mockResolvedValueOnce(true); // confirm issue

    await runStartup();

    const logs = consoleSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logs).toContain("Found saved configuration:");
    expect(logs).toContain("Agent A (author): Claude Opus 4.6 (1M) / High");
    expect(logs).toContain("Agent B (reviewer): GPT-5.4 / Extra High");
    expect(logs).toContain("Mode: auto");
    expect(logs).toContain("Language: English");
    expect(logs).toContain("Pipeline settings:");
    expect(logs).toContain("Self-check auto iterations");
    expect(logs).toContain("Review auto rounds");
    expect(logs).toContain("Inactivity timeout");
    expect(logs).toContain("Auto-resume attempts");

    consoleSpy.mockRestore();
  });

  test("defaults executionMode when not saved", async () => {
    const config = {
      ...defaultConfig(),
      agentA: {
        cli: "claude" as const,
        model: "opus",
        contextWindow: "1m",
        effortLevel: "high",
      },
      agentB: {
        cli: "codex" as const,
        model: "gpt-5.4",
        effortLevel: "xhigh",
      },
      // executionMode is undefined
    };
    mockLoadConfig.mockReturnValue(config);
    mockSelect.mockResolvedValueOnce("aicers");
    mockSearch.mockResolvedValueOnce("agentcoop");
    mockInput.mockResolvedValueOnce("42");
    mockListRepositories.mockReturnValue([
      { name: "agentcoop", description: "" },
    ]);
    mockGetIssue.mockReturnValue(defaultIssue());
    mockConfirm
      .mockResolvedValueOnce(true) // accept quick-start
      .mockResolvedValueOnce(true); // confirm issue

    const result = await runStartup();

    expect(result.executionMode).toBe("auto");
  });
});
