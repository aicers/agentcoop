import { execFileSync } from "node:child_process";

/**
 * Returns the login of the currently authenticated GitHub user.
 */
export function getGitHubUsername(): string {
  try {
    return execFileSync("gh", ["api", "user", "--jq", ".login"], {
      encoding: "utf-8",
    }).trim();
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
  const output = execFileSync(
    "gh",
    [
      "repo",
      "list",
      owner,
      "--json",
      "name,description",
      "--limit",
      "100",
      "--no-archived",
    ],
    { encoding: "utf-8" },
  );
  return JSON.parse(output);
}

export function getIssue(owner: string, repo: string, number: number): Issue {
  const output = execFileSync(
    "gh",
    [
      "issue",
      "view",
      String(number),
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "number,title,body,state,labels",
    ],
    { encoding: "utf-8" },
  );
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
