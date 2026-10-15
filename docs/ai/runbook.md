# AI Router Runbook

How to run, test and deploy the AI model router. Scope and rules: `v1-scope.md`. Resolver and data shapes: `api-contract.md`.

## One-time setup

1. `forge login` with an Atlassian API token, or export `FORGE_EMAIL` and `FORGE_API_TOKEN` (for example in `~/.zshrc`).
2. `npm install` and `npm --prefix src/frame install`.
3. Install `cloudflared` if the tunnel asks for it: `brew install cloudflared`.
4. Copy `.env.example` to `.env` (gitignored) and fill in values. Forge does not read `.env`; load it into the shell that runs the tunnel (see below).
5. Keep the repo outside iCloud-synced folders. Syncing `node_modules` creates `name 2` conflict copies that break `tsc`. If you see `Cannot find type definition file for '... 2'`, remove the empty duplicate folders in `node_modules/@types` or reinstall.

## Run locally (two terminals, repo root)

```bash
# Terminal 1: frame dev server
npm --prefix src/frame run dev

# Terminal 2: tunnel (load .env first so the tunnel sees it)
set -a; source .env; set +a
forge tunnel -e development
```

Environment changes only reach the tunnel when it starts, so restart it after editing `.env`. Changes to `manifest.yml` need a deploy and a tunnel restart.

## Mock mode (no network, no cost)

Set `FORGE_USER_VAR_AI_MOCK=1` in `.env`, reload it, restart the tunnel. Mock mode skips every OpenRouter call, including the model list.

| Put this in the task text | Result |
|---|---|
| `debug` or `code` | coding recommendation |
| `summarize` | summarization |
| `image` | image generation, which ends as no eligible model in V1 |
| `MOCK_AMBIGUOUS` | low confidence, shows the category picker |
| `MOCK_UNSAFE` | blocked by the guard, no model runs |

Manual checks: recommendation card with price and alternatives; confirm runs only after clicking; double click runs once; editing the Todo after a run marks the old run as for an earlier version; Models tab shows source and disabled media models; AI failures never block normal Todo use.

Mock mode is off unless the variable is exactly `1`. Never set it in a deployed environment.

## Database

- Migrations live in `src/sql/migration.ts` (append-only, one statement each, `v001` to `v007`). They run from the hourly scheduled trigger, the webtrigger, and also through the tunnel.
- To run now: `forge webtrigger list -e development` (or `create --functionKey run-schema-migration-webtrigger --site <site> --product Jira --environment development`), then `curl --fail-with-body --request POST '<url>'`. Keep the URL private.
- Check results: the migration log lists `Migrations applied:` and the history; or open `forge console` and use the SQL view for the development environment; or use the app (status change works, a Start Task run appears in history).
- Until migrations run, the list falls back to the original columns and writes show "The app is still updating its database."

## Real OpenRouter calls

These need the key, the egress permission and a deploy. Tell the team first: there is one shared development environment.

1. In OpenRouter set a spending limit on the key.
2. `forge lint` (a `MAJOR_VERSION_RULE` approval request is expected for the egress change).
3. `forge variables set --encrypt -e development OPENROUTER_API_KEY` (paste the key at the prompt, not on the command line).
4. `forge deploy -e development` (add `--approve MAJOR_VERSION_RULE` if lint stops).
5. `forge install --upgrade -e development` for the Jira site.
6. Run the migration webtrigger (or wait for the hourly trigger).
7. For tunnel testing with the real key, export `FORGE_USER_VAR_OPENROUTER_API_KEY` in the tunnel terminal and leave `FORGE_USER_VAR_AI_MOCK` empty.
8. Try one short real task. Each run costs money; the output cap is 1500 tokens and the timeout is 20 s.

A merge to `main` triggers the CI deploy, which stops on the major-version check until the egress change is approved. Hold the `manifest.yml` egress commit back until the team has agreed.

## Refreshing the model table

`npm run models:table` rewrites `docs/ai/model-table.md` from OpenRouter's public model list (no key needed). The Models tab in the app shows live data after the deploy and the snapshot before it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `forge login` cannot save credentials | Keychain unavailable; use `FORGE_EMAIL` and `FORGE_API_TOKEN` |
| `cloudflared` install error on `forge tunnel` | `brew install cloudflared` |
| `Unknown column 'notes'` | Migrations `v002` to `v005` not applied yet; run the webtrigger or wait for the hourly trigger |
| `[ai] openrouter failure ... PROVIDER_ERROR status=n/a` | No API key, or mock mode off without a key; set `FORGE_USER_VAR_AI_MOCK=1` or the key and restart the tunnel |
| `... status=402` | Out of credits, or the key spending limit was reached |
| `... status=429` | Rate limited; retry shortly |
| Run stuck in `running` | Reported as failed (TIMEOUT) after 2 minutes; start the task again |
| `TS2688 ... '... 2'` | iCloud duplicate folders in `node_modules`; see One-time setup |

## Security reminders

- The repo is public. Never commit keys; `.env` is gitignored.
- OpenRouter is only called from resolvers, never from the frontend.
- Only registry models marked approved and enabled can run, and only candidates stored on the run can be confirmed.
- Model output is shown as plain text and is never executed.
