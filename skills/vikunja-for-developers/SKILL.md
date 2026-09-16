---
name: vikunja-for-developers
description: "Use when working with tickets in a team-run self-hosted Vikunja (vikunja.example.com) — reading, creating, updating, assigning or commenting on them, via the web UI, the API, or a Vikunja MCP connector. Also covers connecting Claude or Codex to it."
---

# Vikunja — developer guide

The team self-hosts **Vikunja** as its issue tracker, replacing Linear (whose free plan
capped out at 250 issues). Tickets were migrated across, and new work is tracked here.

| Thing | Where |
|---|---|
| Vikunja 2.6.0 | `https://vikunja.example.com` |
| MCP bridge | `https://mcp.example.com/mcp` (v1.5.0, 23 tools) |
| Bridge source | GitHub `edkog/vik` (https://github.com/edkog/vik; formerly `Pro-coder-69/vik`) |

## Getting access

**Self-registration is disabled**, so an account has to be created for you — ask whoever
administers the instance. Projects are then shared with you individually and there is no
org-wide default, so if you can't see a project, ask to be added rather than assuming it
doesn't exist.

**Your Vikunja login and your MCP access are two separate things.** The bridge is
multi-user (v1.4.0+): it maps each caller's MCP bearer token to that caller's **own**
Vikunja API token, so you act as yourself — your own permissions, your own name in the
server log. To get set up you mint an API token under your own Vikunja account
(Settings → API Tokens → Create, **leave every `Delete` box unchecked**) and the
administrator adds you as a principal and redeploys. You are given your **own** MCP token;
you should never be handed the owner's. Run `check_api` once connected — it returns
`acting_as`, which should be your name.

The bridge is a standard MCP server over streamable HTTP, so any MCP client works —
Claude desktop/web, Codex, or anything else. Point it at the `/mcp` URL above with
**no sign-in / no OAuth**, plus a request header named `authorization` whose value is
`Bearer <your MCP token>`. In Claude that's Settings → Connectors → Add custom connector;
in Codex it's an MCP server entry with the same URL and header. Claude will tag the server
"Sign in — Detected" because the bare 401 looks like OAuth; ignore that, the header is the
right answer.

## How tickets are written here

**New tickets need no special title prefix** — just a clear title. Vikunja numbers them
itself. The Linear key convention below applies **only to tickets that were imported from
Linear**.

**Imported tickets keep their Linear key in the title**, e.g.
`EK-241 Money representation: ...`, so the old identifier stays searchable. Vikunja assigns
its own sequential numbers and the API cannot override them, so both numbering schemes
coexist on imports. That's expected, not a bug.

Other conventions:

- **Descriptions are HTML.** Vikunja stores HTML, not markdown — raw markdown renders as
  literal `##` and `**bold**`. The MCP bridge converts markdown for you on the way in; if
  you call the API directly, convert it yourself.
- **Comments are converted too**, through the bridge — write markdown and it renders. Pass
  `comment_format: "html"` to opt out and send HTML yourself. Calling the API directly means
  converting it yourself.
- **Titles are plain text**, not HTML — writing `&amp;` in a title stores it literally.
- **Migrated tickets open with a blockquote header** linking back to the original Linear
  issue, with its team, project, status, priority, assignee and labels.
- **Priority scales are inverted** between the two systems. Linear counts *down* from
  Urgent=1; Vikunja counts *up*. Urgent→4, High→3, Medium→2, Low→1, none→0. Passing a
  Linear priority straight through silently mislabels the ticket.
- **Board columns** on "Engineering (EK)": Backlog / To-Do / In Review / Done.

## Working through an MCP client

Run **`check_api` first** in any session that will touch Vikunja — it probes projects,
tasks, views and buckets, names whichever one is broken, and reports `acting_as` so you
know whose credentials you're using. That saves a lot of guessing.

The 23 tools, with their arguments:

- **`check_api`** `{project_id?}` — self-test; returns `acting_as`.
- **`list_projects`** `{}` — id, title, is_archived. A negative id is a Vikunja
  pseudo-project (e.g. "My Open Tasks"), not a real one.
- **`list_tasks`** `{project_id, include_done?, updated_since?, assignee?, limit?, page?}` —
  newest updates first. **`limit` caps at 50**; page with `page`. `updated_since` (ISO
  timestamp) is the cheap way to ask "what changed recently". Descriptions come back as a
  500-char preview, flagged with `description_truncated` and `description_full_chars`.
  Passing `assignee` changes the return shape from a bare array to
  `{assignee, assignee_filter, count, tasks}` — **read `assignee_filter`**: `server-side`
  means the count is real, anything else means Vikunja ignored the filter and the bridge
  narrowed the page itself, so later pages may hold more.
- **`search_tasks`** `{query, project_id?, include_done?, limit?, page?}` — text search
  across titles and descriptions. Much cheaper than paging `list_tasks` when you know
  roughly what you're looking for, including an old `EK-nnn` key.
- **`get_task`** `{task_id}` — one task plus comments and its relations, **in full, nothing
  truncated**.
- **`get_description`** `{task_id}` — the description as raw stored HTML. Read this before
  rewriting one, or to find the exact string for `edit_description`.
- **`create_task`** `{project_id, title, description?, description_format?, done?,
  due_date?, priority?}` — description is markdown by default and converted for you. Pass
  `done: true` to create an already-completed task. A new open task lands in the default
  bucket, so follow with `move_task` if it belongs elsewhere.
- **`update_task`** `{task_id, title?, description?, description_format?, done?, due_date?,
  priority?}` — only the fields you pass change; the bridge reads and merges. But
  `description` replaces the whole body.
- **`edit_description`** `{task_id, old_str, new_str, replace_all?}` — exact substring
  replace, done server-side, so you never have to hold the whole description. Refuses a
  missing or ambiguous match instead of guessing. Match the **HTML** (`<p>text</p>`), not
  the markdown you wrote.
- **`move_task`** `{project_id, task_id, bucket}` — bucket by title or id.
- **`add_comment`** `{task_id, comment, comment_format?}` — markdown by default.
- **`list_buckets`** `{project_id}` — the kanban view id and its buckets, names only.
- **`list_bucket_tasks`** `{project_id, bucket?}` — the board itself: every column with the
  tasks in it, or one column if you pass `bucket`. The only tool that can see board
  position.
- **`list_labels`** `{}` — every label with its id and colour.
- **`set_labels`** `{task_id, labels, mode?}` — labels by name or id; `mode` is `add`
  (default) or `replace`. Idempotent, so it doubles as an audit sweep: re-running it over a
  set of tickets repairs any that are missing labels and leaves the rest alone.
- **`relate_tasks`** `{task_id, other_task_id, relation_kind}` — `subtask`, `parenttask`,
  `related`, `duplicates`, `blocking`, `blocked`, `precedes`, `follows`, `copiedfrom`,
  `copiedto`. Vikunja writes the inverse side automatically. A duplicate returns **409**,
  which is proof the relation already exists rather than an error to chase.
- **`list_relations`** `{task_id}` — the relations on one task, grouped by kind.
- **`list_project_users`** `{project_id}` — everyone assignable: the project owner plus
  everyone it is shared with, as `{id, username, name}`. Call it when you are unsure of a
  username; a person not on this list cannot be assigned until the project is shared with
  them.
- **`assign_task`** `{task_id, users, mode?}` — usernames or numeric ids, mixed. `mode` is
  `add` (default) or `replace`. Idempotent: assigning someone already on the task is a
  no-op with `changed: false`, not an error, so it is safe to re-run across a batch. An
  unknown name fails with the list of assignable people rather than a bare API error.
- **`unassign_task`** `{task_id, users?, all?}` — remove people by username or id, or pass
  `all: true` to clear the task. Someone who was not assigned comes back in `not_assigned`
  rather than raising.
- **`attach_from_url`** `{task_id, url, filename?, mime_type?}`
- **`add_attachment`** `{task_id, filename, content_base64, mime_type?}`
- **`list_attachments`** `{task_id}`

Write tools return only `{id, identifier, title, done, priority, project_id, due_date,
updated, description_chars}` — **no description**. Echoing back a body you just sent is
pure cost. Read it with `get_task` or `get_description` if you need it.

**Known limitations — all measured, each has produced a wrong answer at least once:**

- **A task never knows its own column.** `bucket_id` comes back as **`0` for every task**,
  in both `list_tasks` and `get_task`, even right after a successful `move_task` — in
  Vikunja 2.6 bucket membership lives on the *view*, not the task. Use
  **`list_bucket_tasks`**; never state a ticket's column from a task response.
- **A column's task list can be short.** Vikunja pages tasks per bucket, so a column of 85
  may return one. `list_bucket_tasks` reports the column's true `count` and sets
  `tasks_truncated` when they disagree — read the flag, don't count the array.
- **`list_tasks` previews descriptions at 500 characters** and strips HTML tags. It flags
  this, so trust the flag rather than the length, and call `get_task` for the real body.
  Never conclude from a preview that a ticket is short or a section is missing.
- **HTML entities survive the stripping**, so returned text contains `&#39;` and `&quot;`
  where the original had quotes. Don't copy that back into a description.
- **Editing a description you haven't read whole is destructive**, because `update_task`
  replaces it wholesale. Use `edit_description` for a small change, or `get_description`
  first.
- **Only `get_task` and `list_relations` show relations.** `list_tasks` omits them, so a
  ticket can look unlinked when it isn't.
- **The assignee filter is not proven server-side.** No task on the instance had an
  assignee when it was built, so the filter syntax could not be tested against real data.
  `assignee_filter` in the response tells you which side actually did the work — read it
  instead of trusting `count`.
- **`assign_task` and `unassign_task` report what Vikunja actually did, not what was
  asked.** If a response carries `drift: true` plus `intended`, the server did not apply
  the assignee list as sent — report that rather than retrying or asking for a delete
  permission to work around it.

Three deliberate restrictions, all worth preserving rather than working around:

- The API tokens are scoped with **no delete permission on anything** — tasks, projects,
  comments, attachments, views, buckets, assignees. Create, read, update and move only.
  Deleting is done by hand in the UI.
- **Un-assigning does not break that rule.** It is implemented by posting the remaining
  assignee list to Vikunja's bulk endpoint, which drops anyone left out, so no `DELETE`
  scope is needed anywhere.
- `MCP_BLOCK_DONE=true` makes `move_task` **refuse the Done bucket**. Closing a ticket is a
  human decision. If a move is refused, report it rather than routing around it.

If an assignee tool returns **401**, the token is missing the *Tasks Assignees* route group
(or *Projects → projectusers*) and has to be re-minted by the administrator — it is not a
bug in the tool.

## Attachments

Image bytes must not pass through the model — base64 of even a 1 KB PNG has been
transcribed with enough drift to upload a corrupt file, and the sandbox's egress policy
blocks the relevant hosts outright.

- **Anything with a URL** → `attach_from_url`. The server downloads it itself and pushes it
  into Vikunja. This works for Linear's `uploads.linear.app` links, which are signed in the
  query string and so need no Linear credential — but they **expire in about five minutes**,
  so fetch the issue and attach in the same pass.
- **A screenshot pasted into chat** has no URL and cannot be automated. Drop it onto the
  ticket in the Vikunja UI instead.

## Vikunja API quirks

These cost real debugging time and are not guessable from the docs.

- Task creation is `PUT /api/v1/projects/:id/tasks`. The older `PUT /api/v1/projects/:id`
  returns **405** on 2.6.
- Task update is `POST /api/v1/tasks/:id` and **replaces the whole object** — read the task
  and merge your changes in, or every field you didn't send is blanked.
- Attachments: `PUT /api/v1/tasks/:id/attachments`, multipart, form field name `files`.
- Comments: `PUT /api/v1/tasks/:id/comments`.
- Bulk create: `POST /api/**v2**/projects/:id/tasks/bulk` — note the **v2**.
- Buckets: `GET /api/v1/projects/:p/views/:v/buckets` gives names and ids only;
  `GET /api/v1/projects/:p/views/:v/tasks` gives the buckets **with their tasks embedded**
  and is the only place board position is visible. Move a task with
  `POST /api/v1/projects/:p/views/:v/buckets/:b/tasks`.
- **Relations**: `PUT` and `DELETE` on `/api/v1/tasks/:id/relations`. There is **no GET** —
  relations come back embedded on the task as `related_tasks`. A duplicate `PUT` returns
  **409 The task relation already exists**.
- **Assignees**: `PUT /api/v1/tasks/:id/assignees` `{user_id}` adds one;
  `POST /api/v1/tasks/:id/assignees/bulk` `{assignees: [{id, username}]}` sets the whole
  list and **unassigns anyone left out** (`[]` clears the task), which is why removal needs
  no delete scope; `GET /api/v1/tasks/:id/assignees` reads them back.
- **Resolving a username to an id: use `/projects/:id/projectusers`, not
  `/projects/:id/users`.** Both exist and return different sets — `/users` lists *shares*
  and omits the project **owner**, so building against it makes the owner un-assignable on
  their own tickets and looks like a permissions bug. `projectusers` sits under the
  *Projects* token route group, not *Projects Users*.
- Sharing a project with a person is `POST /api/v1/projects/:id/users/<username>` with
  `{permission: 1}` — **username in the path, not a numeric id**, and the field is
  `permission` (renamed from `right` in 2.6). It defaults to `0` (read only) if omitted.
- API tokens are scoped **per route group**. `/projects/:id/views` needs *Projects Views →
  Read All*, which is separate from *Projects*; without it, buckets return 401 while tasks
  work fine — a confusing failure that looks like a broken token.
- `GET /api/v1/routes` lists every route your token can actually reach — the fastest way to
  settle a "which endpoint is it" question. The instance also serves its own swagger at
  `/api/v1/docs.json`, which is the authoritative source for what an endpoint *does* on
  this version.

## The MCP bridge

`vikunja-mcp` is a small Node server (plain `node:http` + hand-rolled JSON-RPC, plus
`marked` for markdown→HTML). Source is in `edkog/vik` under `mcp/`. It is **built
from source**, not pulled as a published image, so any change needs a rebuild rather than a
restart. Deploying is the administrator's job — coordinate rather than redeploying under
someone else's session.

Structure, if you add a tool: `EP` maps endpoint shapes, `vk()` does JSON calls (adding the
calling principal's token), `vkUpload()` does multipart,
`slimTask(t, {descriptionChars, relations})` is the read shape (`0` means no limit; only
`list_tasks` passes 500, only `get_task` asks for relations), `slimRelations(t)` flattens
the `related_tasks` map, `resolveProjectUsers()` turns usernames into ids and doubles as
the project-access check, `bulkSetAssignees()` writes the assignee list and reads it back
so a caller is told what happened rather than what was intended, `writeAck(t)` is the write
shape and deliberately omits the body, and `TOOLS` is an array of
`{name, description, inputSchema, run}` — add an entry and it's exposed automatically. Test
against a local stub server before committing, and where behaviour depends on what Vikunja
does, test both branches.

Verify a change from outside afterwards:

- `GET /healthz` → `200 {"ok":true}`
- `GET /mcp` → `405` with `Allow: POST, OPTIONS` (a 404 here makes Claude report the
  unhelpful "Couldn't reach" error)
- `POST /mcp` with no auth → `401`

The server logs **one line per request** — method, path, status, whether an auth header was
present, and which principal it resolved to (`as=<name>`). That log is the first place to
look for any connector problem.

Two traps worth knowing:

- **Docker Compose eats `$` in environment values.** A token containing `$` silently
  differs inside the container from what was pasted. The symptom is the client reporting
  *"Couldn't reach Vikunja"* while the log shows `401 auth=present (token mismatch)`. Use
  hex-only tokens.
- **"Couldn't reach" usually means 401**, not a network problem. Read the log before
  touching networking.

## Connector gotcha

Tools newly added to the bridge need a **new chat session** before they can be used. A live
session picks up a connector's *removal* immediately but never a re-registration, and no
amount of refreshing or disconnect/reconnect will bind new tools to the current
conversation. Don't spend time fighting it — finish what the available tools allow and
start a fresh chat.

**The desktop app and the web each cache the tool list separately**, and the desktop one
lags furthest behind — it can sit at an older set while the web already shows the current
one. If a tool that should exist is missing, check *that* client: Settings → Connectors →
Vikunja → **⋮ → Refresh tools list**, then Disconnect/Connect if it still lags. Refreshing
fixes the client but still won't rebind the conversation you're in — that needs a new chat.
