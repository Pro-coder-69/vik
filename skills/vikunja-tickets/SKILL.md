---
name: vikunja-tickets
description: "Use when reading, creating, updating, commenting on, moving, labelling, linking or migrating tickets in the self-hosted Vikunja (vikunja.example.com) through the Vikunja MCP connector, or when working with Linear issues bound for it. For the server, Portainer, GitHub, deploys, users or tokens, use vikunja-admin."
---

# Vikunja — working with tickets

The owner self-hosts Vikunja as the issue tracker for the team,
replacing Linear (free plan capped at 250 issues). Work through the **Vikunja MCP
connector** rather than the web UI unless the UI is the only way.

Vikunja `https://vikunja.example.com` · bridge `https://mcp.example.com/mcp`

Anything about the server, Portainer, GitHub, deploys, user accounts or API tokens is in
the **`vikunja-admin`** skill. This one is about tickets.

**the owner wants to see every comment you add:** whenever you call `add_comment`, paste the
comment's full text in your reply to him.

## Where things belong

The owner is explicit about this, so route output accordingly instead of inventing a home for it:

- **A standard workflow or procedure** → the repo's README on GitHub, where it stays
  referenceable. Not a file handed over in chat.
- **Something the owner has to do** → a Vikunja ticket. Not a file, not a chat list.
- **A file dropped in the conversation** is the wrong answer for both. It gets lost.

## When you find a gap, write it as work to be done

If a capability is missing or a tool has a flaw, **document it as something that needs to be
added**, not as "this doesn't exist" or "this is a blind spot". State what to build, the API
shape to build it against, and how to test it, then file it. The owner's words: it is more
productive. A limitation worth mentioning is usually worth a ticket.

## Start here

Run **`check_api`** first in any session that will touch Vikunja. It probes projects,
tasks, views and buckets and names whichever one is broken, which beats guessing. It also
reports **`acting_as`** — which principal, and therefore which Vikunja account, your calls
run as. Permissions differ per principal, so check that before concluding something is
broken when a write is refused or a project looks empty.

Known ids (confirm with `list_projects` / `list_buckets` — these can change):

| | |
|---|---|
| Project 2 | "Engineering (EK)" — the main board, kanban view id 12 |
| Project 1 | "Inbox" — scratch, not the board |
| Buckets on project 2 | Backlog (11), To-Do (7), In Review (8), Done (9) |

The bridge is **v1.4.0** and exposes **20 tools**. If you see fewer, the container is on an
older build or your client cached an older list — see the connector gotcha at the bottom.

## The tools

- **`check_api`** `{project_id?}` — self-test, plus `acting_as`. Run first.
- **`list_projects`** `{}` — id, title, is_archived. A negative id (e.g. `-2` "My Open
  Tasks") is a Vikunja pseudo-project, not a real one.
- **`list_tasks`** `{project_id, include_done?, updated_since?, limit?, page?}` — sorted by
  most recently updated. **`limit` is capped at 50**; page through with `page`.
  `include_done` defaults to false. `updated_since` takes an ISO timestamp and is the
  cheapest way to answer "what changed recently". **Descriptions are previewed at 500
  chars**, flagged with `description_truncated: true` and `description_full_chars`.
  Relations are omitted.
- **`search_tasks`** `{query, project_id?, include_done?, limit?}` — title/description
  match. Searches the whole instance unless `project_id` is given; `include_done` defaults
  to **true**, unlike `list_tasks`. Descriptions previewed at 200 chars. The fast way to
  find a ticket by keyword, and the **only** reliable way to map an imported `EK-nnn` key
  to a task id.
- **`get_task`** `{task_id}` — one task with description, comments **and relations** in
  full, nothing truncated. `related_tasks` is a map of relation kind to the linked tasks,
  and is `{}` when there are none.
- **`list_relations`** `{task_id}` — just the links, grouped by kind, with a `count`.
  Cheaper than `get_task` when you want the graph and not a 9 KB spec plus every comment.
- **`get_description`** `{task_id}` — the description as **raw stored HTML**. Use before
  rewriting one, or to find the exact string for `edit_description`.
- **`create_task`** `{project_id, title, description?, description_format?, done?,
  due_date?, priority?, unique_title?, allow_duplicate?}` — `description` is **markdown by
  default** and converted to HTML for you. **Pass `done: true` to create an
  already-completed task** in one call; Vikunja files it into Done itself. An open task
  lands in the default bucket, so follow with `move_task` if it belongs elsewhere.
- **`update_task`** `{task_id, title?, description?, description_format?, done?, due_date?,
  priority?}` — only the fields you pass change; the bridge reads and merges. But
  `description` **replaces the whole body** — for a small edit use `edit_description`.
- **`edit_description`** `{task_id, old_str, new_str, replace_all?}` — exact substring
  replace done server-side, so you never need to hold the whole description. Refuses a
  missing or ambiguous match instead of guessing. **Descriptions are stored as HTML**, so
  match the markup (`<p>text</p>`), not the markdown you wrote — check with
  `get_description` first.
- **`move_task`** `{project_id, task_id, bucket}` — `bucket` accepts a title
  (case-insensitive, e.g. `"In Review"`) or a bucket id.
- **`add_comment`** `{task_id, comment, comment_format?}` — markdown by default and
  converted, same as descriptions.
- **`list_buckets`** `{project_id}` — the kanban `view_id` and the buckets, names and ids.
- **`list_bucket_tasks`** `{project_id, bucket?}` — **the board itself**: every column with
  the tasks in it. The only tool that can see board position. Each column reports `count`
  (the true total); when Vikunja pages and returns fewer, the column carries
  `tasks_truncated: true`, so **trust `count`, not the length of `tasks`**. Returns only
  id/identifier/title/done/priority and no descriptions, which makes it far cheaper than
  `list_tasks` for a board-wide inventory.
- **`list_labels`** `{}` — all labels with ids. Labels are instance-wide, not per-project.
- **`set_labels`** `{task_id, labels, replace?}` — attach by title, creating any that don't
  exist. Titles match case-insensitively, so "bug" will not create a second "Bug"
  (verified live). Additive unless `replace: true`.
- **`relate_tasks`** `{task_id, other_task_id, relation_kind?}` — link two tasks. From
  `task_id`'s perspective, `"subtask"` makes the other a child, `"parenttask"` makes it the
  parent. Vikunja writes the inverse side itself. Unknown kinds and self-relation are
  rejected before any request goes out. A duplicate returns **409 The task relation already
  exists** — read first with `list_relations` rather than probing with a write.
- **`attach_from_url`** `{task_id, url, filename?, mime_type?, allow_duplicate?}` — the
  preferred way to attach anything.
- **`add_attachment`** `{task_id, filename, content_base64, mime_type?}` — avoid; see below.
- **`list_attachments`** `{task_id}`

## Who you are acting as

The bridge maps each caller's MCP bearer token to a **principal** with its own Vikunja API
token, so different people act as different Vikunja accounts through the same URL.
`check_api` reports `acting_as`. If a write is refused or something is invisible, check the
principal before assuming a bug — it may be a token with narrower scopes, or a project
never shared with that account.

**Assignees can be read but not set.** `get_task` and `list_tasks` return `assignees`, but
no tool writes them, so you cannot assign a ticket to anyone yet. This is tracked as work to
be done, not a permanent limitation — see the assignee-tools ticket on project 2.

## Two things that make re-running safe

The token cannot delete anything, so anything created twice has to be removed by hand.
Both write paths therefore guard themselves — if a session drops mid-batch, just re-run
the ticket:

- **`create_task` refuses to duplicate an imported key.** A title starting with e.g.
  `"EK-142 "` is looked up first; if that key exists, nothing is created and you get
  `skipped: true` with the existing task's id. Carry on with that task. `unique_title: true`
  extends the guard to a whole title for native tasks; `allow_duplicate: true` bypasses it.
  Ordinary titles with no key are unguarded, so two tasks can still share a name — pass
  `unique_title: true` on anything you must not create twice.
- **`attach_from_url` skips an identical filename + byte size.** A different file reusing a
  name still uploads. Pass a stable `filename` — the check matches on it.

**Writes do not echo the description back.** `create_task` and `update_task` return
`{id, identifier, title, done, priority, project_id, due_date, updated, description_chars}`.
Echoing a body you just sent doubled the cost of every write (a 9 KB spec cost ~9,800
tokens per ticket, ~4,800 of it the echo). Use `get_task` or `get_description` to read.

## Auditing a range cheaply

`set_labels` is idempotent and reports, per label, whether it was `added` or was `already`
there. That makes it a combined **repair-and-audit sweep**: run it across a range with the
labels you believe should be present, and the responses tell you which were actually
missing, fixing them as it goes. Far cheaper than paging `list_tasks` to inspect first.
This is how the Linear label backfill was both applied and verified.

## Known limitations — read before answering a question with these tools

Measured, not guessed. Each has produced a wrong answer at least once.

- **`bucket_id` is always `0`** on a task, in both `list_tasks` and `get_task`, even
  immediately after a successful `move_task` — in Vikunja 2.6 bucket membership lives on
  the *view*, not the task. **Never infer a ticket's column from a task response.** Use
  **`list_bucket_tasks`**.
- **A column's `tasks` array can be short.** Vikunja pages per bucket, so a column with 85
  tasks may return one. Read the `tasks_truncated` flag rather than counting the array.
- **`list_tasks` previews descriptions at 500 chars** (`search_tasks` at 200). Trust the
  flag rather than the length and call `get_task` for the real body. `get_task` does not
  truncate — that limit was the bridge's own `slimTask()`, never Vikunja's.
- **Editing a description you cannot see whole is destructive.** `update_task` replaces the
  body wholesale. To change one line use `edit_description`; to rewrite deliberately read it
  first with `get_description`. A session once attached images and then could not remove the
  placeholder lines because it could only see a fragment — stopping to ask was right.
- **HTML entities survive the tag-stripping**, so returned text contains `&#39;` and
  `&quot;` where the original had quotes. Cosmetic, but don't copy it back in.
- **Titles are plain text, not HTML.** Writing `&amp;` in a title stores it literally —
  this mistake has been made twice; just write `&`.
- `identifier` is Vikunja's own number (`#1`, `#2`), unrelated to any Linear key.

## Writing tickets

**New tickets created in Vikunja need no special title prefix** — just a clear title.
The Linear key convention applies **only to tickets imported from Linear**, which keep
their key in the title (`EK-241 Money representation: ...`) so the old identifier stays
searchable. Vikunja assigns its own numbers and the API cannot override them, so both
schemes coexist on imports. That is expected.

- Write descriptions in **markdown**; the bridge converts. Vikunja stores HTML, so raw
  markdown would otherwise render as literal `##` and `**bold**`.
- Imported tickets open with a blockquote header linking back to the Linear issue with its
  team, project, status, priority, assignee and labels.
- **Priority scales are inverted** between the systems. Linear counts down from Urgent=1;
  Vikunja counts up: Urgent→4, High→3, Medium→2, Low→1, none→0. Passing a Linear
  priority straight through silently mislabels the ticket — this mistake has been made.
- When a ticket restates a procedure that lives in the repo README, **link to the README**
  instead of duplicating it. Two copies drift, and the ticket is the one nobody updates.

## Two deliberate restrictions — don't work around them

- The API token has **no delete permission on anything**. Create, read, update, move,
  label and relate only. If something needs deleting, owner does it in the UI.
- `MCP_BLOCK_DONE=true` makes `move_task` **refuse the Done bucket** — closing a ticket is
  a human decision. Report the refusal rather than routing around it. (Creating an
  *imported* already-completed ticket with `create_task done:true` is the migration path
  and is not the same as closing live work.)

## Attachments

Image bytes must never pass through the model: base64 of even a 1 KB PNG was transcribed
with 11 bytes of drift and uploaded corrupt, and the sandbox's egress policy blocks
`uploads.linear.app` and `*.example.com` outright (403 on CONNECT).

- **Anything with a URL** → `attach_from_url`. The server fetches it itself. Verified
  against real Linear URLs — PNGs from 16 KB to 1.6 MB land in one pass, and non-image
  files (`.html` mockups, `.zip` bundles) work identically. Linear's signed links need no
  credential but **expire in ~5 minutes**: call `get_issue` and attach in the same pass. If
  a connection drops in between, re-fetch the issue for fresh URLs rather than retrying
  stale ones.
- When a ticket has several screenshots interleaved with text, prefix the filenames
  `"1 - "`, `"2 - "` and reference them as *(screenshot N)* in the description — Vikunja
  shows attachments as a flat list at the bottom. **Count the images before writing the
  body**: a header promising "8 screenshots" against 9 attachments has to be corrected
  afterwards.
- **A screenshot pasted into chat** has no URL and cannot be automated. Ask owner to drop it
  on the ticket in the Vikunja UI.

## The Linear migration is complete

Moved in September 2026 when Linear's free plan hit its 250-issue cap. **Engineering (EK)
only** — all **160** issues, EK-79 … EK-241, are on project 2, verified by count on both
sides. AnythingCode (ANY) was deliberately left in Linear. **New work is created natively
and needs none of this.**

EK-141, EK-150 and EK-167 do not exist in Linear (deleted) — gaps in the sequence are
correct, not a dropped ticket.

**Do not compute a Vikunja task id from an EK number.** EK-241, EK-205 and EK-238 were
imported first, as tasks 3, 4 and 5, and three EK numbers are missing, so no arithmetic
holds across the range (an older version of this skill claimed `#(nn-75)`; that is wrong
beyond the earliest tickets). Use `search_tasks` on the `EK-nnn` prefix.

What did and did not come across:

- **Labels and parent relations: complete and verified live.** All 129 ticket/label pairs
  and all 22 parent relations were confirmed in September 2026. The 31 tickets carrying no
  label have none in Linear either — that is not a gap.
- **Assignees: text only**, in the header block — no Vikunja user accounts existed at
  import time. Once the assignee tools ship, these can be backfilled from the `Assignee:`
  line in each header.
- **Milestones: not carried across at all.**
- **Cross-references** inside descriptions on tickets before EK-183 still point at Linear
  URLs; from EK-183 on they were rewritten to bare `EK-nnn`.
- Early imports also keep a `Parent: EK-nn` text line in the header. Redundant with the
  real relation now, but it preserves the Linear key — leave it.

If a further batch ever has to move: do **not** go ticket-by-ticket through MCP calls —
every description is written out token by token, and `list_issues` truncates so `get_issue`
per ticket is unavoidable. Write a one-off Node script (Linear GraphQL → Vikunja REST),
commit it to `edkog/vik` (GitHub account renamed from `Pro-coder-69` on 2026-09-16), and
have owner run it as a throwaway container. For metadata alone, `list_issues` with
`fields: ["id","labels","parentId"]` returns every issue on a team in a single call — the
cheap way to audit a whole board without per-ticket fetches.

Linear is **read-only**. Never call a Linear write tool (`save_issue`, `save_comment`,
state changes) without drafting the content and getting the owner's explicit go-ahead first.

## Connector gotcha — the important one

`RefreshMcpTools` **adds newly registered tools to a live session, but never updates the
schema of a tool that already exists.** Observed directly: after the bridge gained `done`,
`unique_title` and `allow_duplicate` on `create_task`, a refresh reported the four *new*
tools and zero changes to `create_task` — and the old signature survived a server upgrade
and a full desktop restart in the same conversation.

So: a **new tool** appears after `RefreshMcpTools`. A **changed tool signature** needs a
genuinely new chat. If a parameter documented here is missing from the schema you can see,
that is why — start a fresh chat rather than concluding the deploy failed.

The desktop app and the web also cache the tool list separately, the desktop lagging
furthest behind. If a tool that should exist is missing entirely: Settings → Connectors →
Vikunja → **⋮ → Refresh tools list**, then Disconnect/Connect.
