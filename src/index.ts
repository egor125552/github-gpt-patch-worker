import { applyPatch } from "diff";

interface Env {
  GITHUB_TOKEN: string;
  BRIDGE_API_KEY: string;
}

type JsonObject = Record<string, unknown>;

type PatchItem = {
  path: string;
  patch: string;
};

type ApplyPatchesRequest = {
  owner: string;
  repo: string;
  branch: string;
  expectedCommitSha: string;
  message: string;
  patches: PatchItem[];
};

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "github-gpt-patch-worker";

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

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function isAuthorized(request: Request, env: Env): boolean {
  const supplied = request.headers.get("x-bridge-key");
  return Boolean(env.BRIDGE_API_KEY && supplied === env.BRIDGE_API_KEY);
}

async function github<T>(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is not configured");
  }

  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": USER_AGENT,
      ...(init.headers ?? {})
    }
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      payload && typeof payload.message === "string"
        ? payload.message
        : `GitHub request failed with ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function getBranchHead(
  env: Env,
  owner: string,
  repo: string,
  branch: string
): Promise<string> {
  const ref = await github<{ object: { sha: string } }>(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`
  );
  return ref.object.sha;
}

async function readTextFile(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<{ content: string; blobSha: string }> {
  const file = await github<{
    type: string;
    content?: string;
    encoding?: string;
    sha: string;
  }>(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${encodeURIComponent(ref)}`
  );

  if (file.type !== "file" || file.encoding !== "base64" || !file.content) {
    throw new Error(`Cannot read ${path} as a UTF-8 text file`);
  }

  return {
    content: decodeBase64Utf8(file.content),
    blobSha: file.sha
  };
}

async function createBlob(
  env: Env,
  owner: string,
  repo: string,
  content: string
): Promise<string> {
  const result = await github<{ sha: string }>(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: encodeBase64Utf8(content), encoding: "base64" })
    }
  );
  return result.sha;
}

async function handleReadFile(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as JsonObject;
  const owner = requireString(body.owner, "owner");
  const repo = requireString(body.repo, "repo");
  const path = requireString(body.path, "path");
  const ref = requireString(body.ref, "ref");

  const file = await readTextFile(env, owner, repo, path, ref);
  const lines = file.content.split("\n");

  return json({
    ok: true,
    path,
    ref,
    blobSha: file.blobSha,
    totalLines: lines.length,
    content: file.content
  });
}

async function handleApplyPatches(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Partial<ApplyPatchesRequest>;
  const owner = requireString(body.owner, "owner");
  const repo = requireString(body.repo, "repo");
  const branch = requireString(body.branch, "branch");
  const expectedCommitSha = requireString(
    body.expectedCommitSha,
    "expectedCommitSha"
  );
  const message = requireString(body.message, "message");

  if (!Array.isArray(body.patches) || body.patches.length === 0) {
    throw new Error("patches must contain at least one patch");
  }
  if (body.patches.length > 20) {
    throw new Error("A maximum of 20 files can be patched in one request");
  }

  const actualHead = await getBranchHead(env, owner, repo, branch);
  if (actualHead !== expectedCommitSha) {
    return json(
      {
        ok: false,
        error: "branch_changed",
        expectedCommitSha,
        actualCommitSha: actualHead
      },
      409
    );
  }

  const baseCommit = await github<{ tree: { sha: string } }>(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(expectedCommitSha)}`
  );

  const tree: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  const changedFiles: Array<{
    path: string;
    oldBlobSha: string;
    newBlobSha: string;
  }> = [];

  for (const item of body.patches) {
    const path = requireString(item?.path, "patch.path");
    const patch = requireString(item?.patch, "patch.patch");
    const original = await readTextFile(
      env,
      owner,
      repo,
      path,
      expectedCommitSha
    );

    const modified = applyPatch(original.content, patch, {
      fuzzFactor: 0
    });

    if (modified === false) {
      return json(
        {
          ok: false,
          error: "patch_conflict",
          path,
          message: "The patch did not match the current file exactly"
        },
        409
      );
    }

    if (modified === original.content) {
      return json(
        {
          ok: false,
          error: "no_change",
          path,
          message: "The patch produced no change"
        },
        400
      );
    }

    const newBlobSha = await createBlob(env, owner, repo, modified);
    tree.push({ path, mode: "100644", type: "blob", sha: newBlobSha });
    changedFiles.push({
      path,
      oldBlobSha: original.blobSha,
      newBlobSha
    });
  }

  const newTree = await github<{ sha: string }>(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base_tree: baseCommit.tree.sha,
        tree
      })
    }
  );

  const newCommit = await github<{ sha: string; html_url: string }>(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        tree: newTree.sha,
        parents: [expectedCommitSha]
      })
    }
  );

  await github(
    env,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha: newCommit.sha, force: false })
    }
  );

  return json({
    ok: true,
    branch,
    previousCommitSha: expectedCommitSha,
    commitSha: newCommit.sha,
    commitUrl: newCommit.html_url,
    changedFiles
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, x-bridge-key",
          "access-control-allow-methods": "GET, POST, OPTIONS"
        }
      });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({
          ok: true,
          service: "github-gpt-patch-worker",
          version: "0.1.0"
        });
      }

      if (!isAuthorized(request, env)) {
        return json({ ok: false, error: "unauthorized" }, 401);
      }

      if (request.method === "POST" && url.pathname === "/github/read-file") {
        return await handleReadFile(request, env);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/github/apply-patches"
      ) {
        return await handleApplyPatches(request, env);
      }

      return json({ ok: false, error: "not_found" }, 404);
    } catch (error) {
      console.error(error);
      return json(
        {
          ok: false,
          error: "internal_error",
          message: error instanceof Error ? error.message : "Unknown error"
        },
        500
      );
    }
  }
};
