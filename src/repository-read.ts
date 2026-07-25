type Env = {
  GITHUB_TOKEN: string;
};

type JsonObject = Record<string, unknown>;

const API = "https://api.github.com";
const USER_AGENT = "github-gpt-patch-worker";

function required(args: JsonObject, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function github(env: Env, path: string): Promise<unknown> {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": USER_AGENT
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data && typeof data.message === "string" ? data.message : `GitHub request failed with ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export const readCapabilities = [
  {
    command: "repo_info",
    description: "Read repository metadata and default branch.",
    requiredArgs: ["owner", "repo"]
  },
  {
    command: "get_branch_head",
    description: "Get the current commit SHA of a branch before reading or patching.",
    requiredArgs: ["owner", "repo", "branch"]
  },
  {
    command: "list_tree",
    description: "List every file and directory recursively at a branch, tag or commit.",
    requiredArgs: ["owner", "repo", "ref"]
  },
  {
    command: "list_branches",
    description: "List repository branches.",
    requiredArgs: ["owner", "repo"]
  },
  {
    command: "list_commits",
    description: "List recent commits, optionally filtered by ref or path.",
    requiredArgs: ["owner", "repo"]
  }
];

export async function runRepositoryRead(command: string, args: JsonObject, env: Env): Promise<unknown | undefined> {
  const owner = required(args, "owner");
  const repo = required(args, "repo");
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  if (command === "repo_info") return github(env, base);

  if (command === "get_branch_head") {
    const branch = required(args, "branch");
    return github(env, `${base}/git/ref/heads/${encodeURIComponent(branch)}`);
  }

  if (command === "list_tree") {
    const ref = required(args, "ref");
    return github(env, `${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  }

  if (command === "list_branches") return github(env, `${base}/branches?per_page=100`);

  if (command === "list_commits") {
    const params = new URLSearchParams({ per_page: "100" });
    if (typeof args.ref === "string" && args.ref) params.set("sha", args.ref);
    if (typeof args.path === "string" && args.path) params.set("path", args.path);
    return github(env, `${base}/commits?${params.toString()}`);
  }

  return undefined;
}
