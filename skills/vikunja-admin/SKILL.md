---
name: vikunja-admin
description: "Use when administering the self-hosted Vikunja stack: working in Portainer, editing the vikunja-mcp bridge on GitHub, deploying or rebuilding, adding tools to the bridge, adding user accounts, minting or rotating API tokens, giving another person their own access, or troubleshooting why the Vikunja connector won't connect."
---

# Vikunja — administration

Infrastructure for the self-hosted Vikunja. Day-to-day ticket work and its conventions are
in **`vikunja-tickets`**. Developers who need access get the separate
**`vikunja-for-developers`** bundle, which carries the conventions and API notes without
any of the infrastructure below — that one is safe to hand out; this one is not.

| Thing | Where |
|---|---|
| Vikunja 2.6.0 | `https://vikunja.example.com` |
| MCP bridge | `https://mcp.example.com/mcp` |
| Portainer | `https://portainer.example.com` — environment **local**, stack **vikunja** |
| Bridge source | GitHub `edkog/vik` (public) — https://github.com/edkog/vik |

The GitHub account was renamed from `Pro-coder-69` to **`edkog`** on 2026-09-16. GitHub
redirects old `Pro-coder-69/vik` URLs for now, but that redirect breaks if anyone registers
the old name, so anything still pointing at it (the Portainer stack's repository URL, git
remotes) should use `edkog/vik`.

## Where documentation goes

The owner is explicit about this:

- **A standard, repeatable procedure** → the **README in the repo**, so it is always
  referenceable. Adding a user, deploying, minting a token: these belong there.
- **Something the owner has to do** → a **Vikunja ticket**.
- **A file handed over in chat** is the wrong home for either. Don't produce one as the
  deliverable.

And when you find a missing capability or a flaw: **write it up as work to be added** —
what to build, the API shape, how to test it — not as "this doesn't exist". Then file it.

## Verify API shapes against the instance, not from memory

Before specifying or building anything against Vikunja, read the real routes. Three
assumptions in an assignee spec were wrong until this was done, and one of them
(`/users` vs `/projectusers`) would have shipped a bug that looked like broken permissions.

- `GET /api/v1/routes` — every route, grouped by **token route group**, which is also how
  you learn which permission checkbox a route needs.
- `GET /api/v1/docs.json` — the instance's own swagger, authoritative for what an endpoint
  *does* on this version. It is what settled that the bulk assignee endpoint unassigns
  anyone left out of the list.
- Both need auth. From the browser pane, the logged-in session's JWT is in
  `localStorage.getItem('token')`; send it as `Authorization: Bearer <that>`. Read-only
  probes like these are fine against production; writes are not.
- **Check who the pane is logged in as** (`GET /api/v1/user`) before trusting what you see —
  it has been left signed in as someone other than the owner.

## The scratch copy is not a checkout

There is **no local git clone**. Any `vikunja-stack` directory in the sandbox is a scratch
copy in an ephemeral container, kept in sync by nothing. It has already been caught badly
stale: a 1.3 KB README stub against the 8.6 KB real one, which would have wiped the
portfolio README had it been committed.

**Always fetch the live file from GitHub and hash it before editing.** Treat a local copy as
a hint, never as the source.

**Browser: use the Claude desktop app's own browser pane (`Claude_Browser__*`) by default**
for GitHub, Portainer and the Vikunja UI. It holds the owner's signed-in sessions and is what all
of this work has been done in. Open a page with `preview_start`, read with
`get_page_text` / `read_page`, and drive editors with `javascript_tool`. Only use Claude in
Chrome (`mcp__claude-in-chrome__*`) if the owner asks for it. Site access is granted per site
with `request_access`.

## The stack

Three services, defined in `docker-compose.yml` at the repo root:

- **`vikunja-init`** — alpine; chowns the named volumes to uid 1000, then exits.
  **Exit code 0 is normal, not a failure.** It exists because Vikunja runs as uid 1000
  while Docker creates named volumes root-owned, which caused "permission denied" on
  `/files`. The app waits on it via `service_completed_successfully`.
- **`vikunja`** — the app. SQLite at `/db/vikunja.db`, uploads at `/files`.
- **`vikunja-mcp`** — the MCP bridge, **built from source** (`build: ./mcp`), not a
  published image, so a redeploy must **rebuild**.

Named volumes: `vikunja_db`, `vikunja_files`. Network: `vikunja` (bridge driver). Ports are
published on the VM's LAN, **not** bound to `127.0.0.1`, because nginx proxy manager runs
on a different Proxmox VM and has to reach them.

Stack env vars: `VIKUNJA_DOMAIN`, `VIKUNJA_JWT_SECRET`, `VIKUNJA_PORT`,
`VIKUNJA_API_TOKEN`, `MCP_AUTH_TOKEN`, `MCP_PRINCIPALS` (optional), `MCP_PORT_HOST`, `TZ`.

## Portainer

The environment list appears first — **click "local"** before URLs like `#!/N/docker/...`
will resolve; the numeric environment id is not stable, so navigate by clicking rather than
guessing it.

- **Stack**: Stacks → `vikunja`. It was deployed with the **Repository** build method
  pointing at the GitHub repo (should be `https://github.com/edkog/vik`), which is why
  **"Pull and redeploy"** re-clones and rebuilds. Environment variables are edited on this
  same page.
- **Containers**: Containers → search. Names are `vikunja-vikunja-1`,
  `vikunja-vikunja-mcp-1`, `vikunja-vikunja-init-1`. Each row has quick actions for
  **Logs**, **Inspect**, **Stats**, **Console**. (The container search box is fussy — clear
  it before retyping, and search a short fragment like `mcp`.)
- **Verify env on the container, not the stack page.** A stack update that errors can leave
  the previous container running with old values while the page shows the new ones.
- **The owner often works over SSH on the Docker host instead** — `docker compose up -d
  --force-recreate`, `docker logs`, `docker inspect`. If he says he's in the terminal, hand
  him commands and stop driving Portainer.
- Housekeeping: `docker image prune` and `docker builder prune` already run on cron, so
  dangling images from rebuilds clear themselves.

## Environment changes need a container RECREATE

This has burned a full debugging round. Editing a stack variable — or a host `.env` — and
*restarting* leaves the old environment baked into the running container: the symptom was
the startup log still printing `principals=owner` after `MCP_PRINCIPALS` had been set.
A container's environment is fixed at creation.

- Portainer **"Pull and redeploy"**, or `docker compose up -d --force-recreate`.
- **Confirm the container id actually changed.** Unchanged id = unchanged environment.
- Check the keys without printing secrets:
  `docker inspect vikunja-vikunja-mcp-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | cut -d= -f1`
- **Portainer stack variables and a host `.env` are not the same thing.** Set the one the
  stack is actually deployed from.

## GitHub

Edits go through the **GitHub web editor** and commit straight to `main`. Repo layout:

```
README.md               public-facing docs (portfolio piece; no internal hostnames)
docker-compose.yml      the whole stack
mcp/server.js           the bridge (~1,120 lines, serverInfo version 1.5.0)
mcp/Dockerfile          node:22-alpine + npm install
mcp/package.json        one dependency: marked
```

The repo doubles as the owner's **portfolio piece** (linked from LinkedIn and his resume). The
README documents the architecture, the tools, design decisions, env vars, deploy/verify
steps, the add-a-user runbook and troubleshooting. Keep it in sync when tools or env vars
change, and keep it generic: use `example.com`, never the real `*.example.com` /
`portainer.example.com` hostnames, and no real people's names. A README-only commit needs
**no redeploy**. Repo polish still to do (repo name, topics, license) is tracked in Vikunja.

Workflow for a change:

1. Open `https://github.com/edkog/vik/edit/main/<path>`.
2. Patch the content, then **verify before committing** — compare a SHA-256 of the editor
   contents against the file actually tested. This has already caught a bad edit that would
   otherwise have shipped, and a second time caught a block inserted in the wrong place
   (identical text, different order — the hash was the only thing that showed it).
3. Commit to `main`, with a message saying what changed and why.
4. Redeploy (below) — unless it was README-only.

### The edit method that works

For a large file, do **not** paste the whole thing. Build the change as a list of exact
`[old, new]` string pairs and apply them in the page:

1. Prove the pairs locally first: applying them **in reverse** to your edited file must
   reproduce the hash of the file currently on `main`. That proves the set is complete and
   exact before a browser is involved.
2. Transfer the pairs into the page as **base64** (`atob` → `TextDecoder` → `JSON.parse`).
   Base64 carries no quotes, backslashes or backticks, so nothing is mangled in
   transcription — which matters because the file is full of template literals. Split it
   into ~6 KB chunks appended to one `window.__pairsB64`; a 17 KB payload took three.
3. In the page: assert each `old` occurs **exactly once**, apply, hash the result, and only
   `view.dispatch` if the hash matches the tested file. Guard the dispatch behind that check
   so a mismatch changes nothing.

**Do not retype the new code to build the pairs.** Generate `pairs.json` from the edited
file by slicing between stable anchors, so only the short unchanged anchors are typed by
hand. The reverse-apply hash check then proves the whole set.

This has now worked first try twice: a 17-pair, 6 KB change and a 7-pair, 10 KB change
across a 45 KB file.

**The uniqueness assert earns its keep.** On a README edit it caught an anchor that
occurred twice (the same token-permissions sentence appears in both the deploy section and
the add-a-user runbook) and aborted instead of silently patching only the first.

**Use a replacer FUNCTION, not a replacement string.** `str.replace(old, new)` interprets
`$&`, ``$` ``, `$'` and `$1` inside `new`. A replacement containing ``$` `` (a dollar sign
followed by a backtick — common in prose about Compose eating `$`) silently injected the
entire preceding document and doubled the file. Write `doc.replace(old, () => NEW)`. The
only reason this was caught was the post-edit length check.

**Driving the editor.** CodeMirror 6; the DOM value is not the document. Get the view with
`document.querySelector('.cm-content').cmView.view` (fall back to `.cmTile.view` — the
property name has changed between GitHub releases) and apply edits with
`view.dispatch({changes: …})`. Hash the **UTF-8 bytes**
(`new TextEncoder().encode(doc)`), not JS string length. If the hash differs but length and
line count look right, suspect **ordering**, and chunk-hash ~20 slices to find what moved.

### Clicking in the browser pane

**Click by `ref`, not by coordinate.** `Claude_Browser__find` returns `ref_N` handles and
`Claude_Browser__computer` accepts them directly. This is the fix for the commit button
that kept being missed: coordinate clicks were being aimed in a frame that had shifted
(the pane resized from 800×1119 to 800×850 mid-task) or read from
`getBoundingClientRect`, which returns CSS pixels and not the screenshot's frame — 578 vs
710 for the same button. With refs, "Commit changes…", the message field, the description
field and the final "Commit changes" button all hit first time, with no screenshots at all.

If you must use coordinates, re-screenshot immediately before every click and never reuse
one across calls.

- **Before typing, verify focus.** Check `document.activeElement` is the field you meant.
  A click that misses the "Commit changes…" button leaves focus in the editor, and the
  `cmd+a` → `Delete` → type sequence then **wipes the document and replaces it with the
  commit message**. This happened; it was recovered with ~12 `cmd+z` and a hash check
  confirming the original was back. Nothing was committed because the document length was
  checked before clicking Commit.
- **If a click keeps missing, stop and say so.** the owner would rather click it himself than
  watch five attempts — he has said so twice. Ask, don't grind.

Things that bite in the commit dialog:

- Copilot pre-fills the message and description and keeps "thinking" for a few seconds.
  **Wait ~5 s before touching the fields**, or Copilot's text lands after yours.
- **`cmd+a` does not select inside the message input** — it appended to Copilot's text
  instead of replacing it. **Triple-click the field (by ref), then type.** Same for the
  extended description, where `cmd+a`, `Backspace` and `Delete` all do nothing (700
  backspaces changed nothing). Multi-paragraph descriptions need a triple-click per
  paragraph, so **prefer one paragraph**.
- After typing, read both values back with JS (`input[placeholder^="Update "]`, placeholder
  is "Update <filename>"; `textarea[placeholder^="Add an optional extended"]`) before
  clicking Commit. Reading is fine; only *setting* values by JS breaks the form. Check the
  `pr-choice` radio is still `direct` while you are there.
- Setting a field's value with a JS property setter looks right on screen but **left the
  form in a state that failed with "File could not be edited"**. Type into the fields.
- That same error also appears when the editor's base blob has gone stale. Reload the edit
  page, re-apply, re-verify the hash, commit again.
- `raw.githubusercontent.com` is CDN-cached for minutes and useless for confirming a fresh
  commit. Verify from inside the page: fetch
  `api.github.com/repos/edkog/vik/contents/<path>?ref=main` with `cache:'no-store'`,
  base64-decode `content`, hash it. (The sandbox's own `api.github.com` access is gated.)

## Adding a tool to the bridge

`mcp/server.js` is dependency-light: plain `node:http` plus hand-rolled JSON-RPC, with
`marked` for markdown→HTML. Structure:

- `EP` — a map of Vikunja endpoint shapes, kept together because several are non-obvious.
- `parsePrincipals()` / `PRINCIPALS` / `callerCtx` / `currentPrincipal()` — multi-user auth,
  see below.
- `vk(path, {method, body, query})` — JSON calls; adds the **calling principal's** bearer
  token, throws on non-2xx.
- `vkUpload(path, {filename, buffer, mimeType})` — multipart, for attachments.
- `slimTask(t, {descriptionChars = 0, relations = false})` — the **read** shape. Strips
  HTML; **`descriptionChars: 0` means no limit**, and only `list_tasks` passes 500.
  `relations: true` (only `get_task`) adds `related_tasks`. A truncated description is
  flagged with `description_truncated` / `description_full_chars` rather than silently cut —
  keep that contract, because a session once edited a description it could only partly see.
- `slimRelations(t)` — flattens Vikunja's `related_tasks` map to id/identifier/title/done,
  dropping empty groups.
- `resolveProjectUsers(projectId, users)` — usernames or ids → member objects, via
  `/projectusers`. Doubles as the access check: a name that is not on the project fails here
  with the list of valid names instead of as an opaque API error.
- `bulkSetAssignees(taskId, users)` — posts the whole assignee list, then **reads it back**
  and returns `drift: true` with `intended` if Vikunja did not apply it. Keep that: the
  "bulk unassigns anyone left out" behaviour is what lets removal work with no delete
  permission, so it is verified on every call rather than assumed.
- `writeAck(t)` — the **write** shape. Deliberately omits the description: echoing back a
  body the caller just sent doubled the token cost of every write (a 9 KB spec cost ~9,800
  tokens per ticket, ~4,800 of it the echo). Keep writes on `writeAck`, reads on `slimTask`.
- `TOOLS` — an array of `{name, description, inputSchema, run}`; add an entry and it is
  exposed automatically. Currently **23 tools**.
- `mdToHtml(src, format)` — applied to `create_task` / `update_task` descriptions **and to
  `add_comment`** (`comment_format: "html"` opts out).
- `resolvePrincipal()` compares bearer tokens in constant time against every principal,
  without early exit. Keep it that way.
- `attach_from_url` fetches whatever URL it's given from inside the Docker network. It's
  behind the bearer token, but now that the bridge serves more than one person, restricting
  it to https and blocking private/LAN addresses is worth doing.

Test a new tool **before committing** against a local stub: point `VIKUNJA_URL` at a tiny
`node:http` server returning canned JSON, then call the tool over `POST /mcp`. Match stub
routes **exactly** — `/tasks` will happily match `/tasks/99` and hand a tool an array where
it expected an object, which looks like a bug in the tool. Have the stub **log the inbound
`Authorization` header**: that is how you prove per-principal identity reaches the outbound
request (grep the trace for each principal's token, and for any `DELETE` that should never
have been issued). Where behaviour depends on what Vikunja does, make the stub **switchable
via an env var** and run the suite in each mode — the assignee work used `normal`,
`addonly` (bulk refuses to remove) and `nofilter` (the server ignores `filter`), and the
two degraded modes are what proved the bridge reports the failure instead of lying.

Also stub the endpoint you deliberately did **not** build against (e.g. the wrong
`/projects/:id/users`) so a regression to it shows up as a test failure rather than in
production.

After adding a tool: commit → Pull and redeploy → **start a new chat session**. A live
session never picks up newly registered tools. **Update the README and the
`vikunja-for-developers` skill in the same pass** — both enumerate the tools, and both have
been caught stale.

## Multi-user access (v1.4.0+)

The Vikunja API token lives in the **bridge container's environment**, not in the
connector — the connector only carries `MCP_AUTH_TOKEN`. So one bridge historically meant
one Vikunja identity, and anyone handed that connector's token acted as the owner's admin
account: indistinguishable in the logs, and un-revocable without rotating the owner's own access.

`MCP_PRINCIPALS` maps each caller's MCP bearer token to their own Vikunja API token:

```
MCP_PRINCIPALS="alice:<their mcp token>:<their vikunja token>; kim:<mcp>:<vik>"
```

Semicolons separate people, colons separate the three fields. **Hex-only tokens** — Compose
eats `$`, and `:` / `;` are the delimiters. `MCP_AUTH_TOKEN` + `VIKUNJA_TOKEN` remain the
`owner` principal, so an existing deployment is unaffected — **adding a person does not
change the owner's own `MCP_AUTH_TOKEN`**, and there is no reason to rotate it.

`callerCtx` (an `AsyncLocalStorage`) carries the principal to `vk()`/`vkUpload()` so tools
stay unaware of multi-tenancy. Startup logs principal **names only, never tokens**; each
request line carries `as=<name>`; `check_api` returns `acting_as`. Config errors (blank
field, bad name, duplicate name or token) exit at startup with a specific message.

**Prefer this to a second container.** No second port, subdomain, DNS record or proxy host.
Adding or removing a person is an env-var edit plus a **recreate** (see above).

**The full step-by-step is in the repo README under "Adding a user"** — send people there
rather than restating it. **Never hand another person the owner's `MCP_AUTH_TOKEN`.**

If a token value ever appears in chat, say so plainly and recommend replacing it; don't let
it pass because it "looks like" a container id or a hash.

## Deploying and verifying

1. Portainer → Stacks → `vikunja` → **Pull and redeploy** (or `docker compose up -d
   --force-recreate` on the host).
2. Verify from the browser pane or the server — **not** Claude's sandbox (see traps):
   - `GET /healthz` → `200 {"ok":true}`
   - `GET /mcp` → `405` with `Allow: POST, OPTIONS` (a 404 here made claude.ai report the
     unhelpful "Couldn't reach")
   - `POST /mcp` with no auth → `401`
3. Check the startup log lists the expected `principals=`. A short list means the env didn't
   reach the container — recreate it.
4. Then `check_api` through the connector, and confirm `acting_as`.

## Troubleshooting: start with the log

The bridge logs **one line per request** — timestamp, method, path, status, whether an auth
header was present, which principal it resolved to (`as=`), and the JSON-RPC method.
Portainer → Containers → `vikunja-vikunja-mcp-1` → Logs. Read it before touching anything.

- `401 auth=present (token mismatch)` → the token matches no principal. claude.ai reports
  this as **"Couldn't reach Vikunja"**, which is misleading — it is not a network problem.
- `401 auth=absent` → the header isn't being sent, or nginx is stripping it.
- `as=` showing the wrong name → that connector holds someone else's token.
- `principals=` shorter than expected → env change never landed; recreate the container.
- A tool 401ing while others work → that route group is missing from the API token. Check
  against `GET /api/v1/routes` and re-mint.
- Nothing logged at all → the request never arrived; look at nginx and DNS.
- A healthy connect logs `initialize`, `server/discover`, `notifications/initialized` and
  `tools/list` within a couple of seconds.

## Traps that have already cost hours

- **Docker Compose eats `$` in env values.** A token containing `$` silently differs inside
  the container from what was pasted, producing the misleading error above. **Use hex-only
  tokens.** Also avoid a bare `$` in compose *comments*, which can trigger interpolation
  warnings.
- Do **not** set `container_name` on `vikunja-init` — it collides with the exited container
  and the stack update fails with a 500.
- Use `VIKUNJA_SERVICE_SECRET`; `VIKUNJA_SERVICE_JWTSECRET` is deprecated.
- The Dockerfile runs `npm install`, so builds need registry access. That layer caches
  unless `package.json` changes.
- **Claude's sandbox cannot reach `*.example.com`** — org egress policy, 403 on
  CONNECT. Neither can the desktop bridge's shell VM. Verification must happen from the
  browser or the server itself; do not try to route around a policy denial.

## Minting an API token

Vikunja → Settings → API Tokens → Create. Permissions are **scoped per route group**:

- `/projects/:id/views` needs **Projects Views → Read All**, *separate* from Projects.
  Without it, buckets return 401 while tasks work fine — a confusing failure that looks
  like a broken token.
- Minimum for the bridge: Projects (Read All, Read One, Tasks By Index, Views Buckets,
  Views Buckets Post/Put, Views Buckets Tasks + Tasks Get, **Project Users**), Projects
  Views (Read All, Read One), Tasks (Create, Read All, Read One, Update), Tasks Comments,
  Tasks Attachments, Tasks Labels, **Tasks Relations**, **Tasks Assignees (Read All,
  Create, Update Bulk)**, Labels.
- **`projectusers` is under the Projects group**, not Projects Users. It is what resolves a
  username to the numeric id assignment needs, and it is the only listing that includes the
  project **owner** — `/projects/:id/users` lists shares only.
- **Leave every `Delete` box unchecked, including on Tasks Assignees.** Un-assigning is
  done by re-setting the whole list through the bulk endpoint, so the rule needs no
  exception. If `drift: true` ever starts appearing on assignee writes, that claim has
  stopped holding — raise it rather than ticking the box.
- Vikunja shows the value **once**. `claude-mcp-v2` was created 2026-09-15 with a **90-day
  expiry** — when it lapses, everything 401s.

After rotating: set `VIKUNJA_API_TOKEN`, recreate, confirm with `check_api`.

**Never choose or type a secret on the owner's behalf** — JWT secret, Vikunja API token,
`MCP_AUTH_TOKEN`, a principal's tokens, GitHub PAT. Say what shape it needs (hex, no `$`)
and let him generate and paste it. Likewise **never create an account or set a password**:
write the steps and let him run them.

## Adding a person

The complete procedure lives in the **repo README, "Adding a user"**. In short:

Registration is disabled (`VIKUNJA_SERVICE_ENABLEREGISTRATION: "false"`), so nobody can
sign themselves up — and the logged-out page offers no "Register" link at all. Two routes;
prefer the first, since it never opens the instance to the world even briefly:

1. **Vikunja's CLI inside the container**, either from Portainer → Containers →
   `vikunja-vikunja-1` → Console (`/bin/sh`) or over SSH with
   `docker exec -it vikunja-vikunja-1 /bin/sh`. Run `vikunja user --help` first to confirm
   subcommands and flags for this version, then create the account. **The owner chooses and
   communicates the password — never pick, type or handle it yourself**; have the person
   change it on first login.
2. **Temporarily set `VIKUNJA_SERVICE_ENABLEREGISTRATION` to `true`**, have them register,
   then set it back and recreate — verifying afterwards on the *container's* environment,
   because a failed stack update can leave the old value running.

Then share each project: project → **Share** → type the username in the search box, select
the result, and — importantly — **set the permission before adding**. It defaults to
**Read only**, which is silent: the person sees the project but every write 403s. `Can
write` is what a developer needs. There is no org-wide default, so every project must be
shared individually.

The underlying API, if the UI misbehaves: `POST /api/v1/projects/:id/users/<username>` with
`{permission: 1}` — **username in the path, not a numeric id** (a numeric id returns 404
"The user does not exist"), and the field is `permission`, renamed from `right` in 2.6. Go
omits `permission: 0` from the JSON, which is why a read-only share looks like no field at
all.

For Claude or Codex access, have them mint their **own** API token under their **own**
account (same scopes, no Delete) and add them to `MCP_PRINCIPALS`, then recreate.

Connector setup: **No sign-in** + a request header `authorization` = `Bearer <their MCP
token>`. claude.ai tags the server "Sign in — Detected" because the bare 401 looks like
OAuth; ignore that and use the header. The bridge is plain MCP over streamable HTTP, so
Codex and other clients connect the same way.

## Known gaps worth raising

- **Backups.** The instance is SQLite on a named Docker volume (`vikunja_db`). Confirm it
  is covered by an existing backup before it matters.
- The API token expires — put a reminder somewhere ahead of the 90 days.
- **The assignee filter on `list_tasks` is unproven server-side.** Nothing on the instance
  had an assignee when it was written, so the filter syntax could not be tested against
  real data. The tool reports `assignee_filter: "server-side"` or `"client-side"` — once
  real assignments exist, check which one it says and fix the filter string if needed.

## Vikunja API reference

- Task create: `PUT /api/v1/projects/:id/tasks` (the older `PUT /api/v1/projects/:id` is
  **405** on 2.6).
- Task update: `POST /api/v1/tasks/:id` — **replaces the whole object**; read and merge.
- Attachments: `PUT /api/v1/tasks/:id/attachments`, multipart, form field name `files`.
- Comments: `PUT /api/v1/tasks/:id/comments`.
- Bulk create: `POST /api/**v2**/projects/:id/tasks/bulk` — note the v2.
- Buckets: `GET /api/v1/projects/:p/views/:v/buckets` — names and ids only, no tasks.
- **Board contents**: `GET /api/v1/projects/:p/views/:v/tasks` returns the buckets with
  their tasks embedded, and is the **only** endpoint that exposes board position — a task
  fetched any other way reports `bucket_id: 0`. Each bucket's `count` is the true total
  and can exceed the `tasks` it returns, because Vikunja pages per bucket.
- Move a task: `POST /api/v1/projects/:p/views/:v/buckets/:b/tasks`.
- **Relations**: `PUT` and `DELETE` on `/api/v1/tasks/:id/relations`. There is **no GET** —
  relations come back embedded on the task as `related_tasks`. A duplicate `PUT` returns
  **409 The task relation already exists**.
- **Project sharing**: `POST /api/v1/projects/:id/users/<username>` with `{permission: 1}`.
  Username in the path; `permission` (not `right`); `0` = read only and is omitted from
  responses.
- **Assignees** (wired into the bridge at v1.5.0): `PUT /api/v1/tasks/:id/assignees`
  `{user_id}` adds one; `POST /api/v1/tasks/:id/assignees/bulk`
  `{assignees: [{id, username}]}` sets the whole list and unassigns anyone left out (`[]`
  clears it); `GET /api/v1/tasks/:id/assignees` reads them back;
  `DELETE /api/v1/tasks/:id/assignees/:user` exists but is **deliberately unused**.
- **`GET /api/v1/projects/:id/projectusers`** resolves usernames to ids and includes the
  **owner**. `GET /api/v1/projects/:id/users` looks equivalent and is not — it lists shares
  only, so the owner is missing.
- `GET /api/v1/routes` lists every route the token can reach — the fastest way to settle a
  "which endpoint is it" question. `GET /api/v1/docs.json` is the instance's swagger and
  says what each one actually does.
- `marked` needs no custom renderer; a custom `listitem` renderer flattens nested lists.
