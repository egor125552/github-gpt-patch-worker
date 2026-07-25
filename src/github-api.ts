type Env = {
  GITHUB_TOKEN: string;
};

type JsonObject = Record<string, unknown>;

const API = "https://api.github.com";
const USER_AGENT = "github-gpt-patch-worker";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function requiredString(args: JsonObject, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

async function requestGitHub(
  env: Env,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");
  if (!METHODS.has(method)) throw new Error("Unsupported HTTP method");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new Error("path must be a GitHub API path beginning with /");
  }

  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": USER_AGENT,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : `GitHub request failed with ${response.status}`;
    throw new Error(message);
  }

  const headers: Record<string, string> = {};
  for (const name of ["link", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }

  return { status: response.status, data, headers };
}

export const apiCapabilities = [
  {
    command: "list_repositories",
    description: "List repositories accessible to the configured GitHub token, including private repositories allowed by its scopes.",
    requiredArgs: []
  },
  {
    command: "github_api",
    description: "Call any GitHub REST API endpoint allowed by the configured token. Supply method, API path and optional JSON body. Use GET for inspection and write methods only when the user requests a change.",
    requiredArgs: ["method", "path"]
  }
];

export async function runGitHubApi(
  command: string,
  args: JsonObject,
  env: Env
): Promise<unknown | undefined> {
  if (command === "list_repositories") {
    const page = optionalInteger(args.page, 1, 1, 1000);
    const perPage = optionalInteger(args.perPage, 100, 1, 100);
    const affiliation =
      typeof args.affiliation === "string" && args.affiliation.trim()
        ? args.affiliation
        : "owner,collaborator,organization_member";
    const visibility =
      typeof args.visibility === "string" && args.visibility.trim()
        ? args.visibility
        : "all";
    const params = new URLSearchParams({
      affiliation,
      visibility,
      sort: "updated",
      direction: "desc",
      per_page: String(perPage),
      page: String(page)
    });
    return requestGitHub(env, "GET", `/user/repos?${params.toString()}`);
  }

  if (command === "github_api") {
    const method = requiredString(args, "method").toUpperCase();
    const path = requiredString(args, "path");
    return requestGitHub(env, method, path, args.body);
  }

  return undefined;
}
