# Skills

Agent skills written alongside this stack — the operational knowledge that made the
bridge and the Linear migration work, kept here so it outlives any one chat session.

| Skill | For |
|---|---|
| `vikunja-tickets` | Day-to-day ticket work through the MCP connector |
| `vikunja-for-developers` | The handout version for someone given their own access — conventions and API notes, no infrastructure |
| `vikunja-admin` | The stack itself: Portainer, deploys, adding people, minting tokens, troubleshooting |

## These are sanitised

Real hostnames are replaced with `example.com`, and real people with `the owner` and
`alice`. Everything else — the API quirks, the failure modes, the things that cost an
afternoon each — is exactly as written.

That means a couple of sentences read slightly oddly where a name used to be. The
substance is intact; the identifying detail is not meant to be.

## What they are

A skill is a markdown file an AI assistant loads when the work matches its description.
These three are worth reading even without one, because most of their content is
findings rather than instructions — things like:

- Vikunja reports `bucket_id: 0` on every task regardless of which column it is in, so
  board position can only be read from the view endpoint.
- API tokens are scoped per route group, and `/projects/:id/views` needs a permission
  separate from `/projects`, which fails as a 401 that looks like a broken token.
- `/projects/:id/projectusers` and `/projects/:id/users` look equivalent and are not —
  the second omits the project owner, so building against it makes the owner
  un-assignable on their own tickets.
- Docker Compose interprets `$` in environment values, so a token containing one
  silently differs inside the container from what was pasted.

## Status

Vikunja is being replaced (see the `plane-stack` repo), so these will stop matching
reality at some point. They are kept as a record of how the system worked and what it
taught, not as a live runbook. The README in this repo is the live document.
