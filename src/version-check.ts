/**
 * CLI version tracking and startup update check.
 *
 * Runs `claude --version` / `codex --version` before the pipeline
 * starts, resolves the installed binary's distribution channel, and
 * fetches the channel-appropriate "latest" version.  When the installed
 * version is older, the user is prompted to update.
 *
 * Structured so each CLI plugs in its own channel-detection and
 * latest-version resolver — adding a third CLI should not require
 * touching the orchestration code.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";

import type { Config } from "./config.js";

// ---- public types --------------------------------------------------------

export type CliName = "claude" | "codex";

/**
 * Where a CLI was installed from.  Drives which "latest version" URL
 * we fetch.  Claude only has one meaningful channel (npm), so it
 * always uses {@link npm}; Codex has multiple independent channels
 * (see issue #276 rationale).
 */
export type InstallSource =
  | { kind: "npm"; registryPackage: string }
  | { kind: "homebrew-formula"; formula: string }
  | { kind: "homebrew-cask"; cask: string }
  | { kind: "github-releases"; repo: string }
  | { kind: "inconclusive"; reason: string };

export interface VersionCheckDeps {
  /** Run `cli --version` and return the raw stdout, or undefined. */
  runVersion: (cli: CliName) => string | undefined;
  /** Resolve the installed binary path following symlinks, or undefined. */
  resolveBinary: (cli: CliName) => string | undefined;
  /** Fetch a JSON document.  Throws on network / HTTP / parse errors. */
  fetchJson: (url: string) => Promise<unknown>;
}

export interface CliVersionCheckResult {
  cli: CliName;
  /** Raw `--version` stdout, useful for logging. */
  rawOutput?: string;
  /** Parsed installed version string (e.g. "1.2.3"), or undefined. */
  installed?: string;
  /** Latest version from the appropriate channel, when resolvable. */
  latest?: string;
  /** Resolved install source, or an inconclusive marker. */
  source?: InstallSource;
  /** When set, the check could not reach a definitive verdict. */
  skippedReason?: string;
}

// ---- version string parsing ----------------------------------------------

/**
 * Extract the first semver-looking version from a `--version` output.
 *
 * Accepts shapes like:
 *   "1.2.3"
 *   "v1.2.3"
 *   "codex-cli 0.46.0"
 *   "1.2.3 (Claude Code)"
 *   "1.2.3-beta.1"
 */
export function parseVersion(output: string): string | undefined {
  // Allow a leading `v` (e.g. "v1.2.3") or any non-digit delimiter;
  // `\b` alone would not split `v` from the digits because both are
  // word characters.
  const m = output.match(
    /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/,
  );
  return m ? m[1] : undefined;
}

/**
 * Compare two version strings as dotted integer tuples, ignoring a
 * leading `v` and treating a missing segment as `0`.  Non-numeric
 * segments (e.g. `-beta.1`) fall back to lexicographic comparison at
 * the first mismatch.
 *
 * Returns -1 if `a < b`, 0 if equal, 1 if `a > b`.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const strip = (v: string) => v.replace(/^v/, "");
  const aParts = strip(a).split(/[.-]/);
  const bParts = strip(b).split(/[.-]/);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i] ?? "0";
    const bp = bParts[i] ?? "0";
    const an = Number(ap);
    const bn = Number(bp);
    const aIsNum = !Number.isNaN(an) && /^\d+$/.test(ap);
    const bIsNum = !Number.isNaN(bn) && /^\d+$/.test(bp);
    if (aIsNum && bIsNum) {
      if (an < bn) return -1;
      if (an > bn) return 1;
    } else if (aIsNum && !bIsNum) {
      // numeric > pre-release tag ("1.2.3" > "1.2.3-beta")
      return 1;
    } else if (!aIsNum && bIsNum) {
      return -1;
    } else {
      if (ap < bp) return -1;
      if (ap > bp) return 1;
    }
  }
  return 0;
}

// ---- install-source detection --------------------------------------------

/**
 * Match a realpath-resolved binary location against known install
 * layouts and return the corresponding distribution channel.  An
 * unrecognized layout returns `inconclusive` — we do not guess, because
 * a wrong prompt is worse than no prompt.
 */
export function detectCodexSource(binPath: string): InstallSource {
  // Homebrew formula layouts.  Brew stores each formula's files under
  // `<prefix>/Cellar/<formula-name>/<version>/...`, so the package
  // name is the path segment directly after `Cellar/`.  A custom
  // wrapper formula like `my-codex-wrapper` would land in
  // `.../Cellar/my-codex-wrapper/...` and must not be classified as
  // the official `codex` formula — a wrong prompt is worse than no
  // prompt.  Anchor the match on the `codex` segment explicitly, and
  // root-anchor on the Homebrew prefixes so a copied tree like
  // `/tmp/opt/homebrew/Cellar/codex/...` or
  // `/Users/me/sandbox/usr/local/Cellar/codex/...` does not pass as
  // an actual Homebrew install.  The three supported prefixes are
  // Homebrew's documented defaults: Apple Silicon macOS
  // (`/opt/homebrew`), Intel macOS (`/usr/local`), and Linuxbrew
  // (`/home/linuxbrew/.linuxbrew`).
  //
  // The Homebrew formula check runs before the npm-prefix check
  // because some `codex` formulae bundle their JS via an internal
  // `libexec/lib/node_modules/@openai/codex/...` tree.  A realpath
  // resolved into that tree is still under `Cellar/codex/`, so it
  // must resolve to the formula channel — npm and the formula update
  // independently and pointing a formula install at the npm registry
  // can produce a wrong update prompt, which is exactly what this
  // feature is meant to avoid.
  if (
    binPath.startsWith(
      `${sep}opt${sep}homebrew${sep}Cellar${sep}codex${sep}`,
    ) ||
    binPath.startsWith(`${sep}usr${sep}local${sep}Cellar${sep}codex${sep}`) ||
    binPath.startsWith(
      `${sep}home${sep}linuxbrew${sep}.linuxbrew${sep}Cellar${sep}codex${sep}`,
    )
  ) {
    return { kind: "homebrew-formula", formula: "codex" };
  }
  // Homebrew cask layouts.  A real cask install of the CLI binary
  // resolves through `realpath` into a Caskroom directory under the
  // Homebrew prefix, so Caskroom is the only reliable marker.  An
  // earlier version of this check also matched any path containing
  // `/Applications/` on the reasoning that casks stage GUI apps
  // there, but after `realpath` resolution a cask-managed
  // `~/Applications/` entry always points back into Caskroom — if we
  // still see the raw `~/Applications/` path it means the binary is
  // *not* a cask symlink and classifying it as cask would be a
  // guess.  A hand-placed `/tmp/Applications/codex` or a plain
  // `~/Applications/Codex.app/Contents/MacOS/codex` would otherwise
  // get a bogus cask update prompt, which is exactly the "guess a
  // channel" failure the issue warns against.  Drop the
  // `Applications` check entirely — unrecognized Applications-style
  // layouts fall through to `inconclusive`.
  //
  // Casks are stored at `<prefix>/Caskroom/<cask-name>/<version>/...`,
  // so the cask name is the path segment directly after `Caskroom/`.
  // Anchor on the `codex` segment so a custom cask like
  // `custom-codex` does not get an official Codex update prompt, and
  // root-anchor on the Homebrew prefixes so a copied tree like
  // `/Users/me/sandbox/usr/local/Caskroom/codex/...` does not pass as
  // an actual Homebrew install.
  if (
    binPath.startsWith(
      `${sep}opt${sep}homebrew${sep}Caskroom${sep}codex${sep}`,
    ) ||
    binPath.startsWith(`${sep}usr${sep}local${sep}Caskroom${sep}codex${sep}`) ||
    binPath.startsWith(
      `${sep}home${sep}linuxbrew${sep}.linuxbrew${sep}Caskroom${sep}codex${sep}`,
    )
  ) {
    return { kind: "homebrew-cask", cask: "codex" };
  }
  // npm global prefix — anchor on `lib/node_modules/@openai/codex/`
  // because a project-local install lives at
  // `<repo>/node_modules/@openai/codex/...` (no `lib/` segment) and
  // `realpath(command -v codex)` can hit it via `node_modules/.bin`.
  // Routing a project-local install to the npm registry would produce
  // an unwanted update prompt for a dependency the user didn't pick
  // globally — exactly the "wrong prompt is worse than no prompt"
  // failure the issue warns against.  Most npm-style global layouts we
  // care about (system npm, nvm, asdf, Volta, custom `--prefix`)
  // place packages under `<prefix>/lib/node_modules/...`, so this
  // marker covers them.  pnpm's global layout is different and is
  // handled by the separate check below.  This runs after the
  // Homebrew checks because a `codex` formula that bundles its JS
  // internally places the resolved binary under
  // `Cellar/codex/.../libexec/lib/node_modules/@openai/codex/...` — a
  // path that contains the global-npm marker but is really a formula
  // install.
  if (
    binPath.includes(
      `${sep}lib${sep}node_modules${sep}@openai${sep}codex${sep}`,
    )
  ) {
    return { kind: "npm", registryPackage: "@openai/codex" };
  }
  // pnpm global layout: `<pnpm-home>/pnpm/global/<store>/node_modules/
  // @openai/codex/...`, or after realpath resolution through pnpm's
  // `.pnpm` virtual store, `<pnpm-home>/pnpm/global/<store>/node_modules/
  // .pnpm/@openai+codex@<ver>/node_modules/@openai/codex/...`.  pnpm
  // global does not use a `lib/node_modules/` segment, so it is missed
  // by the npm-prefix check above (`pnpm root -g` returns e.g.
  // `~/Library/pnpm/global/5/node_modules` on macOS,
  // `~/.local/share/pnpm/global/<N>/node_modules` on Linux,
  // `%LOCALAPPDATA%/pnpm/global/<N>/node_modules` on Windows, or
  // `$PNPM_HOME/global/<N>/node_modules` when set).
  //
  // The `/pnpm/global/` segment is the distinguishing marker — project-
  // local pnpm uses `<repo>/node_modules/.pnpm/...` with no `global`
  // segment, so anchoring on `/pnpm/global/` keeps the project-local
  // false positive closed while still routing a real `pnpm add -g
  // @openai/codex` to the npm registry.
  if (
    binPath.includes(`${sep}pnpm${sep}global${sep}`) &&
    binPath.includes(`${sep}node_modules${sep}@openai${sep}codex${sep}`)
  ) {
    return { kind: "npm", registryPackage: "@openai/codex" };
  }
  // Standalone GitHub-release layouts.  The installer has shipped
  // several shapes over time, and only these specific subpaths under
  // `~/.codex/` count as a recognized standalone install:
  //   ~/.codex/bin/codex               (symlink farm)
  //   ~/.codex/versions/<ver>/codex    (older per-version layout)
  //   ~/.codex/packages/standalone/releases/<ver>-<triple>/codex
  //                                     (current standalone layout)
  //
  // Any other path inside `~/.codex/` (e.g. `~/.codex/tools/codex`,
  // `~/.codex/tmp/codex`) is a hand-placed / custom binary and must
  // fall through to `inconclusive` — matching the whole directory
  // would hand out a bogus update prompt, which is the "guess a
  // channel" failure the issue warns against.  The home-anchoring
  // also rejects rogue `.codex` directories outside `$HOME`.
  const homeCodex = `${homedir()}${sep}.codex${sep}`;
  if (
    binPath.startsWith(`${homeCodex}bin${sep}`) ||
    binPath.startsWith(`${homeCodex}versions${sep}`) ||
    binPath.startsWith(
      `${homeCodex}packages${sep}standalone${sep}releases${sep}`,
    )
  ) {
    return { kind: "github-releases", repo: "openai/codex" };
  }
  return {
    kind: "inconclusive",
    reason: `Unrecognized install layout: ${binPath}`,
  };
}

function detectClaudeSource(_binPath: string): InstallSource {
  // Claude is effectively distributed via npm only, so the registry
  // is the source of truth even when the binary is shimmed through a
  // version manager.  The _binPath parameter is kept for symmetry with
  // detectCodexSource and so a future channel can be wired in without
  // changing the caller signature.
  return { kind: "npm", registryPackage: "@anthropic-ai/claude-code" };
}

/** Dispatch install-source detection by CLI name. */
export function detectInstallSource(
  cli: CliName,
  binPath: string,
): InstallSource {
  return cli === "claude"
    ? detectClaudeSource(binPath)
    : detectCodexSource(binPath);
}

// ---- latest-version resolvers --------------------------------------------

async function fetchNpmLatest(
  pkg: string,
  deps: VersionCheckDeps,
): Promise<string | undefined> {
  const data = await deps.fetchJson(`https://registry.npmjs.org/${pkg}/latest`);
  if (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { version?: unknown }).version === "string"
  ) {
    return (data as { version: string }).version;
  }
  return undefined;
}

async function fetchHomebrewFormulaLatest(
  formula: string,
  deps: VersionCheckDeps,
): Promise<string | undefined> {
  const data = await deps.fetchJson(
    `https://formulae.brew.sh/api/formula/${formula}.json`,
  );
  if (typeof data === "object" && data !== null) {
    const versions = (data as { versions?: { stable?: unknown } }).versions;
    if (versions && typeof versions.stable === "string") {
      return versions.stable;
    }
  }
  return undefined;
}

async function fetchHomebrewCaskLatest(
  cask: string,
  deps: VersionCheckDeps,
): Promise<string | undefined> {
  const data = await deps.fetchJson(
    `https://formulae.brew.sh/api/cask/${cask}.json`,
  );
  if (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { version?: unknown }).version === "string"
  ) {
    return (data as { version: string }).version;
  }
  return undefined;
}

async function fetchGitHubReleasesLatest(
  repo: string,
  deps: VersionCheckDeps,
): Promise<string | undefined> {
  const data = await deps.fetchJson(
    `https://api.github.com/repos/${repo}/releases/latest`,
  );
  if (typeof data !== "object" || data === null) return undefined;
  // GitHub release tag shapes vary (`v1.2.3`, `rust-v0.122.0`, `1.2.3`),
  // so extract the first semver-looking substring rather than blindly
  // stripping a leading `v`.  Prefer `name` when present — upstream
  // often sets it to the bare semver even when `tag_name` carries a
  // prefix like `rust-v` — and fall back to `tag_name` otherwise.
  const obj = data as { name?: unknown; tag_name?: unknown };
  const candidates = [obj.name, obj.tag_name];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const v = parseVersion(c);
    if (v) return v;
  }
  return undefined;
}

/** Resolve the latest version string for a given install source. */
export async function resolveLatestVersion(
  source: InstallSource,
  deps: VersionCheckDeps,
): Promise<string | undefined> {
  switch (source.kind) {
    case "npm":
      return fetchNpmLatest(source.registryPackage, deps);
    case "homebrew-formula":
      return fetchHomebrewFormulaLatest(source.formula, deps);
    case "homebrew-cask":
      return fetchHomebrewCaskLatest(source.cask, deps);
    case "github-releases":
      return fetchGitHubReleasesLatest(source.repo, deps);
    case "inconclusive":
      return undefined;
  }
}

// ---- default deps (real process + real fetch) ----------------------------

function defaultRunVersion(cli: CliName): string | undefined {
  try {
    const out = execFileSync(cli, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return out;
  } catch {
    return undefined;
  }
}

function defaultResolveBinary(cli: CliName): string | undefined {
  try {
    // `command -v` is POSIX-portable and works in both sh and bash.
    // We run it inside /bin/sh -c so the user's $PATH is honored.
    const raw = execFileSync("/bin/sh", ["-c", `command -v ${cli}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
    if (!raw) return undefined;
    // Expand a leading `~/` to the real home before realpath.
    const resolved = raw.startsWith(`~${sep}`)
      ? raw.replace(/^~/, homedir())
      : raw;
    if (!existsSync(resolved)) return undefined;
    return realpathSync(resolved);
  } catch {
    return undefined;
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.json();
}

export function defaultVersionCheckDeps(): VersionCheckDeps {
  return {
    runVersion: defaultRunVersion,
    resolveBinary: defaultResolveBinary,
    fetchJson: defaultFetchJson,
  };
}

// ---- per-CLI check -------------------------------------------------------

/**
 * Probe just the installed version (`--version` + parse).  No install-source
 * detection and no network calls — used on throttled / skipped runs where we
 * still want to display the version in the pane header but must not hit the
 * registry / Homebrew / GitHub.
 */
export function probeInstalledVersion(
  cli: CliName,
  deps: VersionCheckDeps = defaultVersionCheckDeps(),
): CliVersionCheckResult {
  const rawOutput = deps.runVersion(cli);
  if (!rawOutput) {
    return {
      cli,
      skippedReason: `could not run \`${cli} --version\``,
    };
  }
  const installed = parseVersion(rawOutput);
  if (!installed) {
    return {
      cli,
      rawOutput,
      skippedReason: `could not parse version from \`${cli} --version\``,
    };
  }
  return { cli, rawOutput, installed };
}

/**
 * Run the full install-source → installed-version → latest-version flow
 * for a single CLI.  Network failures and inconclusive install layouts
 * surface as `skippedReason` rather than throwing, so the caller can
 * continue the pipeline (the check is a convenience, not a gate).
 */
export async function checkCliVersion(
  cli: CliName,
  deps: VersionCheckDeps = defaultVersionCheckDeps(),
): Promise<CliVersionCheckResult> {
  const rawOutput = deps.runVersion(cli);
  if (!rawOutput) {
    return {
      cli,
      skippedReason: `could not run \`${cli} --version\``,
    };
  }
  const installed = parseVersion(rawOutput);
  if (!installed) {
    return {
      cli,
      rawOutput,
      skippedReason: `could not parse version from \`${cli} --version\``,
    };
  }

  const binPath = deps.resolveBinary(cli);
  if (!binPath) {
    return {
      cli,
      rawOutput,
      installed,
      skippedReason: `could not resolve \`${cli}\` binary path`,
    };
  }

  const source = detectInstallSource(cli, binPath);
  if (source.kind === "inconclusive") {
    return {
      cli,
      rawOutput,
      installed,
      source,
      skippedReason: source.reason,
    };
  }

  let latest: string | undefined;
  try {
    latest = await resolveLatestVersion(source, deps);
  } catch (err) {
    return {
      cli,
      rawOutput,
      installed,
      source,
      skippedReason: `could not fetch latest version: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!latest) {
    return {
      cli,
      rawOutput,
      installed,
      source,
      skippedReason: "latest version missing from channel response",
    };
  }

  return { cli, rawOutput, installed, source, latest };
}

// ---- prompt orchestration ------------------------------------------------

export type RetryChoice = "retry" | "skip" | "abort";

export interface VersionCheckPrompts {
  /** "An update is available — update now?" (yes/no). */
  confirmUpdate: (message: string) => Promise<boolean>;
  /** "Please update, then press Enter to continue." */
  waitForEnter: (message: string) => Promise<void>;
  /** Retry / skip / abort selection after an unchanged version. */
  chooseRetrySkipAbort: (message: string) => Promise<RetryChoice>;
  /** Informational message (same semantics as console.log). */
  log: (message: string) => void;
  /** Warning — non-fatal, user-facing. */
  warn: (message: string) => void;
}

export interface VersionCheckTranslations {
  /** "Checking CLI versions..." */
  checking: string;
  /** "No update check — {cli} install channel is inconclusive: {reason}" */
  inconclusive: (cli: string, reason: string) => string;
  /** "Could not check {cli} latest version: {reason}" */
  fetchFailed: (cli: string, reason: string) => string;
  /** "{cli} is up to date (v{version})" */
  upToDate: (cli: string, version: string) => string;
  /** "A newer version of {cli} is available (v{from} → v{to}). Update now?" */
  updatePrompt: (cli: string, from: string, to: string) => string;
  /** "Please update {cli}, then press Enter to continue." */
  updateWaiting: (cli: string) => string;
  /** "Version is still v{version}." */
  versionUnchanged: (version: string) => string;
  /** "How would you like to proceed?" */
  retrySkipAbortPrompt: string;
  /** "Continuing with {cli} v{version}." */
  proceedingWith: (cli: string, version: string) => string;
  /** "Update check aborted by user." */
  abortedByUser: string;
  /** "Could not determine {cli} version; skipping update check." */
  versionUnknown: (cli: string) => string;
}

export interface StartupVersionCheckOptions {
  /** CLIs in use for this run.  Deduplicated internally. */
  clis: readonly CliName[];
  config: Config;
  /**
   * Persist the version-check state fields (`lastKnownVersions` and/or
   * `lastVersionCheckAt`) to disk.  Implemented as a narrow patch
   * rather than a whole-`Config` save so unknown top-level keys in
   * `~/.agentcoop/config.json` survive the update — mirroring the
   * "don't rewrite unless dirty" guard in `runStartup()`.
   */
  persistVersionCheckState: (updates: {
    lastKnownVersions?: NonNullable<Config["lastKnownVersions"]>;
    lastVersionCheckAt?: number;
  }) => void;
  prompts: VersionCheckPrompts;
  translations: VersionCheckTranslations;
  /** Defaults to real process/network deps. */
  deps?: VersionCheckDeps;
  /** Defaults to Date.now(). */
  now?: () => number;
}

/**
 * Decide whether the throttle allows a check.  Treats a missing or
 * malformed timestamp as "check".
 */
export function shouldRunVersionCheck(
  config: Config,
  now: number,
  throttleMs = 24 * 60 * 60 * 1000,
): boolean {
  if (config.skipVersionCheck === true) return false;
  const last = config.lastVersionCheckAt;
  if (typeof last !== "number" || !Number.isFinite(last)) return true;
  return now - last >= throttleMs;
}

/**
 * Top-level startup check.  Runs after the CLIs actually used this run
 * are known (fresh/resume branches joined and `params` finalized).
 *
 * Returns a map of installed versions keyed by CLI name.  A value of
 * `undefined` means the version could not be determined (`--version`
 * failed or the output could not be parsed) — callers should still be
 * able to proceed.
 *
 * Non-fatal: every failure path returns control to the caller rather
 * than throwing.  The only way to abort is the explicit retry-skip-abort
 * flow after an update failure.
 */
export async function runStartupVersionCheck(
  opts: StartupVersionCheckOptions,
): Promise<Map<CliName, string | undefined>> {
  const deps = opts.deps ?? defaultVersionCheckDeps();
  const now = opts.now ?? (() => Date.now());
  const tr = opts.translations;
  const prompts = opts.prompts;

  const unique: CliName[] = [];
  for (const cli of opts.clis) {
    if (!unique.includes(cli)) unique.push(cli);
  }

  const versions = new Map<CliName, string | undefined>();
  // Tracks whether at least one CLI reached a definitive
  // installed-vs-latest comparison this run.  `lastVersionCheckAt`
  // only advances when this is true — otherwise a transient registry
  // outage or a fully inconclusive run would suppress re-checks for
  // the next 24h without ever comparing against a real "latest".
  let didDefinitiveCheck = false;

  const throttled = !shouldRunVersionCheck(opts.config, now());

  if (!throttled) {
    prompts.log(tr.checking);
  }

  for (const cli of unique) {
    // Throttled/skipped runs still probe the installed version so the
    // pane header can display it, but MUST NOT hit the registry /
    // Homebrew / GitHub.  `checkCliVersion` does network I/O; use the
    // lightweight probe instead.
    if (throttled) {
      const probe = probeInstalledVersion(cli, deps);
      versions.set(cli, probe.installed);
      continue;
    }

    const result = await checkCliVersion(cli, deps);
    versions.set(cli, result.installed);

    if (!result.installed) {
      prompts.warn(tr.versionUnknown(cli));
      continue;
    }

    if (result.skippedReason) {
      // Inconclusive layout or network failure: log and continue.
      if (result.source?.kind === "inconclusive") {
        prompts.log(tr.inconclusive(cli, result.skippedReason));
      } else {
        prompts.log(tr.fetchFailed(cli, result.skippedReason));
      }
      continue;
    }

    if (!result.latest) continue;

    // Reached installed-vs-latest comparison — this counts as a
    // successful check for throttle bookkeeping.
    didDefinitiveCheck = true;

    const cmp = compareVersions(result.installed, result.latest);
    if (cmp >= 0) {
      prompts.log(tr.upToDate(cli, result.installed));
      continue;
    }

    // Interactive update flow.
    const wantsUpdate = await prompts.confirmUpdate(
      tr.updatePrompt(cli, result.installed, result.latest),
    );
    if (!wantsUpdate) continue;

    let currentInstalled = result.installed;
    for (;;) {
      await prompts.waitForEnter(tr.updateWaiting(cli));

      const rawAfter = deps.runVersion(cli);
      const parsedAfter = rawAfter ? parseVersion(rawAfter) : undefined;

      if (parsedAfter && compareVersions(parsedAfter, result.latest) >= 0) {
        versions.set(cli, parsedAfter);
        currentInstalled = parsedAfter;
        prompts.log(tr.proceedingWith(cli, parsedAfter));
        break;
      }

      // Version is unchanged (or regressed, or unreadable).
      prompts.warn(tr.versionUnchanged(parsedAfter ?? currentInstalled));
      const choice = await prompts.chooseRetrySkipAbort(
        tr.retrySkipAbortPrompt,
      );
      if (choice === "retry") continue;
      if (choice === "skip") {
        versions.set(cli, parsedAfter ?? currentInstalled);
        break;
      }
      // "abort" — throw a sentinel so the caller can exit.
      prompts.warn(tr.abortedByUser);
      throw new VersionCheckAbortError();
    }
  }

  // Persist only the version-check state fields (best-effort — never
  // crash on a write error).  The callback patches the raw JSON so
  // unknown top-level keys are preserved; going through `saveConfig`
  // here would silently drop them.
  const updates: Partial<NonNullable<Config["lastKnownVersions"]>> = {};
  for (const cli of unique) {
    const v = versions.get(cli);
    if (typeof v === "string") updates[cli] = v;
  }
  const prev = opts.config.lastKnownVersions ?? {};
  const merged = { ...prev, ...updates };
  const changed = Object.keys(updates).some(
    (k) =>
      (prev as Record<string, string | undefined>)[k] !== merged[k as CliName],
  );
  if (changed) {
    opts.config.lastKnownVersions = merged;
  }
  // Only advance the throttle timestamp if at least one CLI reached a
  // real installed-vs-latest comparison.  A run where every CLI was
  // inconclusive or network-failed should re-check on the next start.
  const advanceTimestamp = !throttled && didDefinitiveCheck;
  if (advanceTimestamp) {
    opts.config.lastVersionCheckAt = now();
  }
  if (changed || advanceTimestamp) {
    const patch: {
      lastKnownVersions?: NonNullable<Config["lastKnownVersions"]>;
      lastVersionCheckAt?: number;
    } = {};
    if (changed) patch.lastKnownVersions = merged;
    if (advanceTimestamp)
      patch.lastVersionCheckAt = opts.config.lastVersionCheckAt;
    try {
      opts.persistVersionCheckState(patch);
    } catch {
      // Config write failures are non-fatal — the next run will retry.
    }
  }

  return versions;
}

/**
 * Refresh the `cliVersion` field on a mutable per-agent state object.
 *
 * On resume, `runStartupVersionCheck` may return `undefined` for a CLI
 * when `--version` failed or its output could not be parsed.  Blanking
 * the saved value in that case would discard the per-run version
 * record that issue #276 asked to preserve for postmortem.  This
 * helper overwrites only when a non-empty new value is available, so
 * a successful upgrade is captured while a failed re-probe leaves the
 * previously recorded version intact.
 */
export function refreshAgentCliVersion(
  agent: { cliVersion?: string },
  detected: string | undefined,
): void {
  if (detected !== undefined) {
    agent.cliVersion = detected;
  }
}

/**
 * Thrown from {@link runStartupVersionCheck} when the user selects
 * "abort" in the retry/skip/abort prompt.  A distinct class so the
 * caller can decide between exit codes / cleanup behavior.
 */
export class VersionCheckAbortError extends Error {
  constructor() {
    super("Version check aborted by user.");
    this.name = "VersionCheckAbortError";
  }
}
