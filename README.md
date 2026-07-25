# GitHub GPT Patch Worker

Cloudflare Worker bridge for Custom GPT Actions. It reads UTF-8 text files from GitHub and applies small exact unified patches without sending complete replacement files back through the model.

## Endpoints

- `GET /health` — public health check.
- `POST /github/read-file` — reads a complete text file at a branch, tag, or commit.
- `POST /github/apply-patches` — applies exact unified patches to up to 20 existing files and creates one commit.

Protected endpoints require the `X-Bridge-Key` header.

## Required secrets

Set these in Cloudflare Worker settings:

- `GITHUB_TOKEN` — GitHub fine-grained personal access token with access to the target repositories and Contents read/write permission.
- `BRIDGE_API_KEY` — a long random password shared only with the Custom GPT Action.

## Cloudflare build settings

- Production branch: `main`
- Root directory: `/`
- Build command: `npm run typecheck`
- Deploy command: `npx wrangler deploy`

## Custom GPT

After deployment, replace the placeholder URL in `openapi.yaml` with the Worker URL, then import the schema in the GPT Builder. Configure Action authentication as an API key in the custom header `X-Bridge-Key`.

## Safety and conflict behaviour

`apply-patches` requires `expectedCommitSha`. If the target branch has moved, the Worker returns HTTP 409 and creates no commit. Patch hunks use zero fuzz: if the old text does not match exactly, the Worker returns HTTP 409 and does not update the branch.
