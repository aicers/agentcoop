import { ghExec } from "./gh-exec.js";

/**
 * Returns the login of the currently authenticated GitHub user.
 */
export function getGitHubUsername(): string {
  try {
    return ghExec(["api", "user", "--jq", ".login"]).trim();
  } catch {
    throw new Error(
      "Failed to determine GitHub username. Ensure `gh` is installed and authenticated (`gh auth login`).",
    );
  }
}

export interface Repository {
  name: string;
  description: string | null;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
}

export function listRepositories(owner: string): Repository[] {
  const output = ghExec([
    "repo",
    "list",
    owner,
    "--json",
    "name,description",
    "--limit",
    "100",
    "--no-archived",
  ]);
  return JSON.parse(output);
}

export function getIssue(owner: string, repo: string, number: number): Issue {
  const output = ghExec([
    "issue",
    "view",
    String(number),
    "--repo",
    `${owner}/${repo}`,
    "--json",
    "number,title,body,state,labels",
  ]);
  const raw = JSON.parse(output);
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((l: { name: string }) => l.name)
      : [],
  };
}
