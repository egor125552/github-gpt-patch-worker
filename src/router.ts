import worker from "./index";
import { apiCapabilities, runGitHubApi } from "./github-api";
import { readCapabilities, runRepositoryRead } from "./repository-read";

type Env = {
  GITHUB_TOKEN: string;
  BRIDGE_API_KEY: string;
};

type JsonObject = Record<string, unknown>;

const capabilities = [
  {
    command: "list_capabilities",
    description: "Return all commands currently supported by the Worker.",
    requiredArgs: []
  },
  {
    command: "read_file",
    description: "Read a complete UTF-8 text file at a branch, tag, or commit.",
    requiredArgs: ["owner", "repo", "path", "ref"]
  },
  {
    command: "apply_patches",
    description: "Apply exact unified patches to up to 20 existing text files in one commit. Read the target file first and use the current branch commit SHA. A missing or changed line causes patch_conflict and no commit.",
    requiredArgs: ["owner", "repo", "branch", "expectedCommitSha", "message", "patches"]
  },
  ...readCapabilities,
  ...apiCapabilities
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-bridge-key",
      "access-control-allow-methods": "GET, POST, OPTIONS"
    }
  });
}

function authorized(request: Request, env: Env): boolean {
  return Boolean(
    env.BRIDGE_API_KEY &&
      request.headers.get("x-bridge-key") === env.BRIDGE_API_KEY
  );
}

function commandRequest(
  request: Request,
  pathname: string,
  args: JsonObject
): Request {
  const url = new URL(request.url);
  url.pathname = pathname;

  return new Request(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-key": request.headers.get("x-bridge-key") ?? ""
    },
    body: JSON.stringify(args)
  });
}

async function handleCommand(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const body = (await request.json()) as JsonObject;
  const command = typeof body.command === "string" ? body.command : "";
  const args =
    body.args && typeof body.args === "object" && !Array.isArray(body.args)
      ? (body.args as JsonObject)
      : {};

  if (command === "list_capabilities") {
    return json({ ok: true, command, capabilities });
  }

  if (command === "read_file") {
    return worker.fetch(
      commandRequest(request, "/github/read-file", args),
      env
    );
  }

  if (command === "apply_patches") {
    return worker.fetch(
      commandRequest(request, "/github/apply-patches", args),
      env
    );
  }

  try {
    const repositoryResult = await runRepositoryRead(command, args, env);
    if (repositoryResult !== undefined) {
      return json({ ok: true, command, data: repositoryResult });
    }

    const apiResult = await runGitHubApi(command, args, env);
    if (apiResult !== undefined) {
      return json({ ok: true, command, data: apiResult });
    }
  } catch (error) {
    return json(
      {
        ok: false,
        error: "github_command_failed",
        message: error instanceof Error ? error.message : "Unknown error"
      },
      400
    );
  }

  return json(
    {
      ok: false,
      error: "unknown_command",
      message: `Unsupported command: ${command}`,
      availableCommands: capabilities.map(item => item.command)
    },
    400
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/github/command") {
      return handleCommand(request, env);
    }

    return worker.fetch(request, env);
  }
};
