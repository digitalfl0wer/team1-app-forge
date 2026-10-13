# Todo frontend development

The existing app uses Jira global page → UI Kit wrapper
(`src/frontend/index.tsx`) → Frame resource → React frontend
(`src/frame/src/App.tsx`) → `@forge/bridge` invoke → Alan's TypeScript
resolvers (`src/resolvers/index.ts`) → Forge SQL.

React state holds the Todo list, input, loading/submitting flags and error.
TypeScript describes the resolver responses; Todo IDs remain strings because
SQL BIGINT values can exceed JavaScript's safe integer range. Vite builds static
assets into `src/frame/build` and serves local changes on port 3000.
`view.theme.enable()` supplies Jira theme tokens; CSS has fallback colors.
Only getTodos/addTodo are exposed in this UI. There are no completion/deletion
controls because the backend does not provide those operations.

## Local validation

Run from the repository root:

```sh
npm ci
npm --prefix src/frame ci
npm run type-check
npm run build
npm run lint
forge lint -e development
git grep -n -E '^(<<<<<<<|=======|>>>>>>>)'
```

No output (exit 1) from the final grep means no conflict markers were found.
The root type-check covers both the Forge code and the Frame, including its
entry point. `npm run build:frame` builds just the Frame.

## One-time development setup — requires team approval

Keep the official app ID:
`ari:cloud:ecosystem::app/aaa0d6d7-d093-4ef6-b07f-deaa154cb0ad`.

The October 12 audit found that Forge's pre-deployment lint check considers SQL,
scheduledTrigger and webtrigger new modules in this app's development environment.
The manifest is valid, but lint exits with `MAJOR_VERSION_RULE`: these modules
require a major version approval because of a Runs on Atlassian trust signal change.
No deployment, installation upgrade or migration was performed during the repair.

Deployments are handled by the team's canonical GitHub Actions workflow,
`.github/workflows/deploy.yaml`, after approved changes reach `main`.
It uses Node 24, installs Forge CLI and both npm packages, builds the Frame,
then runs `forge deploy --non-interactive -e development`.
The duplicate backend workflow has been removed. Do not run a local deployment.

The major version approval reported by Forge lint remains a release prerequisite:
the team must resolve it through its approved release process before expecting
CI deployment to succeed. No approval bypass was added to the workflow.
The Jira installation upgrade also remains pending team approval; it was not run.

SQL data from Alan's previous app ID is not evidence that this installation has
its Todos table. Alan's `v001_create_todos_table` migration must execute for this
app/site/environment. It is idempotent and skips already-recorded migrations.
The preserved hourly scheduled trigger runs migrations. For immediate setup,
after approval and installation, obtain the migration URL:

```sh
forge webtrigger create --functionKey run-schema-migration-webtrigger --site SITE --product Jira --environment development
```

Invoke the returned URL with an HTTP POST (this writes the database schema):

```sh
curl --fail-with-body --request POST 'RETURNED_WEBTRIGGER_URL'
forge logs -e development --since 15m -n 30
```

Verify a successful migration response/log before testing Todos. An empty list
is a valid successful response; a missing-table error means initialization failed.
The developer console SQL view can also verify schema/migration history.

## Run locally in Jira

After the repaired manifest is deployed, the installation is upgraded, and SQL
is initialized, run these in two terminals at the repository root:

```sh
# Terminal 1 — explicit environment avoids the missing default-environment prompt
forge tunnel -e development
```

```sh
# Terminal 2
npm --prefix src/frame run dev
```

Open Jira → Apps → Todo-list on the development installation. Test:

- Initial load displays descriptions, statuses and created dates.
- Blank/whitespace input cannot submit; input is limited to 255 characters.
- Add a Todo: button shows Adding, input clears, list reloads.
- Refresh reloads data; failed loads show an error and allow retry.
- Narrow layouts and Jira light/dark themes remain readable.

The Vite server was verified to start and serve HTML on port 3000, then stopped.
The Forge tunnel was not started: it requires the shared setup above first.
Frame code changes hot reload while tunneling. Manifest changes require an
approved redeploy and tunnel restart. After stopping a tunnel, deploy only with
team approval if those code changes should become the shared development version.

## Validation limits

Local builds/type checks/ESLint passed. Forge lint found zero errors/warnings and
one major version approval requirement; its exit status was therefore 1.
Jira/SQL end-to-end behavior still needs the approved shared setup and browser test.
Installed dependencies have npm audit findings (root: 23, including 21 high;
Frame: 23, including 16 high). No forced or breaking dependency upgrades were applied.
