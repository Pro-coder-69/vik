/**
 * vikunja-mcp — MCP bridge to a self-hosted Vikunja.
 * Zero dependencies: plain node:http + hand-rolled JSON-RPC, so it runs on
 * a stock node image with no build step and no npm install.
 *
 * Transport: streamable HTTP (single JSON responses), bearer auth.
 */

import http from "node:http";
import { marked } from "marked";

/* ------------------------- markdown -> HTML ------------------------- */
// Vikunja stores task descriptions as HTML (TipTap). Linear stores markdown.
// Passing markdown straight through renders literal "## " and "**bold**",
// so everything inbound is converted unless the caller says it is already HTML.
// No renderer overrides: marked's own output is standard HTML and TipTap
// normalises it on parse. An earlier custom listitem renderer flattened
// nested lists by re-parsing raw text instead of the token's children.
marked.use({ gfm: true, breaks: false });

function mdToHtml(src, format) {
  const text = String(src ?? "");
  if (!text) return "";
  if (format === "html") return text;
  try {
    return marked.parse(text, { async: false });
  } catch (e) {
    // Never lose the content to a parser error — fall back to escaped text.
    const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<pre><code>${esc}</code></pre>`;
  }
}

const VIKUNJA_URL = (process.env.VIKUNJA_URL ?? "http://vikunja:3456").replace(/\/$/, "");
const VIKUNJA_TOKEN = process.env.VIKUNJA_TOKEN ?? "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";
const PORT = Number(process.env.MCP_PORT ?? 8790);
const BLOCK_DONE = (process.env.MCP_BLOCK_DONE ?? "true") === "true";
const DONE_TITLE = (process.env.MCP_DONE_BUCKET_TITLE ?? "Done").toLowerCase();
const MAX_PAGE = 50; // Vikunja reports max_items_per_page: 50

for (const [k, v] of [["VIKUNJA_TOKEN", VIKUNJA_TOKEN], ["MCP_AUTH_TOKEN", MCP_AUTH_TOKEN]]) {
  if (!v) { console.error(`${k} is required`); process.exit(1); }
}

/* --------------------------- Vikunja API --------------------------- */
// Endpoint shapes kept together: Vikunja is non-obvious in places
// (task creation is PUT on the PROJECT, not POST on /tasks).
const EP = {
  projects: () => `/api/v1/projects`,
  projectTasks: (id) => `/api/v1/projects/${id}/tasks`,
  // 2.6 moved creation onto /tasks; PUT on the bare project now 405s.
  createTask: (pid) => `/api/v1/projects/${pid}/tasks`,
  task: (id) => `/api/v1/tasks/${id}`,
  attachments: (tid) => `/api/v1/tasks/${tid}/attachments`,
  comments: (tid) => `/api/v1/tasks/${tid}/comments`,
  views: (pid) => `/api/v1/projects/${pid}/views`,
  buckets: (pid, vid) => `/api/v1/projects/${pid}/views/${vid}/buckets`,
  bucketTasks: (pid, vid, bid) => `/api/v1/projects/${pid}/views/${vid}/buckets/${bid}/tasks`,
};

async function vk(path, { method = "GET", body, query } = {}) {
  const url = new URL(VIKUNJA_URL + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${VIKUNJA_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data && typeof data === "object" && data.message ? data.message : String(text).slice(0, 300);
    throw new Error(`Vikunja ${method} ${path} -> ${res.status}: ${msg}`);
  }
  return data;
}

// Attachments are multipart, so they can't go through vk()'s JSON path.
async function vkUpload(path, { filename, buffer, mimeType }) {
  const fd = new FormData();
  fd.append("files", new Blob([buffer], { type: mimeType || "application/octet-stream" }), filename);
  const res = await fetch(VIKUNJA_URL + path, {
    method: "PUT",
    headers: { Authorization: `Bearer ${VIKUNJA_TOKEN}` }, // no Content-Type: fetch sets the boundary
    body: fd,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`Vikunja PUT ${path} -> ${res.status}: ${String(text).slice(0, 300)}`);
  return data;
}

const strip = (s) => String(s ?? "").replace(/<[^>]*>/g, "").trim();

// descriptionChars: 0 means no limit. Only LIST calls truncate, so a listing of
// 50 tickets doesn't return 50 full specs; single-task reads return everything.
function slimTask(t, { descriptionChars = 0 } = {}) {
  if (!t || typeof t !== "object") return t;
  const full = strip(t.description);
  const cut = descriptionChars > 0 && full.length > descriptionChars;
  return {
    id: t.id,
    identifier: t.identifier,
    title: t.title,
    ...(cut ? { description_truncated: true, description_full_chars: full.length } : {}),
    description: cut ? full.slice(0, descriptionChars) : full,
    done: t.done,
    project_id: t.project_id,
    bucket_id: t.bucket_id,
    labels: (t.labels ?? []).map((l) => l.title),
    assignees: (t.assignees ?? []).map((a) => a.username),
    due_date: t.due_date && !String(t.due_date).startsWith("0001") ? t.due_date : null,
    updated: t.updated,
  };
}

async function kanbanView(projectId) {
  const raw = await vk(EP.views(projectId));
  const list = Array.isArray(raw) ? raw : (raw?.views ?? []);
  const v = list.find((x) => (x.view_kind ?? x.viewKind) === "kanban")
    ?? list.find((x) => /kanban/i.test(x.title ?? ""));
  if (!v) throw new Error(`No kanban view on project ${projectId}. Views: ${list.map(x=>x.title).join(", ")}`);
  return v;
}

/* ------------------------------ tools ------------------------------ */
const TOOLS = [
  {
    name: "list_projects",
    description: "List Vikunja projects (id and title).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => (await vk(EP.projects()) ?? []).map((p) => ({ id: p.id, title: p.title, is_archived: p.is_archived })),
  },
  {
    name: "list_tasks",
    description: "List tasks in a project. Use updated_since to see only recent changes.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number", description: "Project id from list_projects" },
        include_done: { type: "boolean", description: "Include completed tasks (default false)" },
        updated_since: { type: "string", description: "ISO timestamp, e.g. 2026-09-14T00:00:00Z" },
        limit: { type: "number", description: `Max ${MAX_PAGE}` },
        page: { type: "number", description: "1-based page number" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    run: async ({ project_id, include_done = false, updated_since, limit = MAX_PAGE, page = 1 }) => {
      const f = [];
      if (!include_done) f.push("done = false");
      if (updated_since) f.push(`updated > '${updated_since}'`);
      const tasks = await vk(EP.projectTasks(project_id), {
        query: {
          filter: f.length ? f.join(" && ") : undefined,
          per_page: Math.min(limit, MAX_PAGE),
          page,
          sort_by: "updated",
          order_by: "desc",
        },
      });
      // Listings preview the description; get_task returns it whole.
      return (tasks ?? []).map((t) => slimTask(t, { descriptionChars: 500 }));
    },
  },
  {
    name: "edit_description",
    description: "Replace an exact substring inside a task's description, without sending the whole description. Use this to fix or remove a line when you cannot see the full text — get_task truncates to 500 characters, and update_task replaces the description wholesale, so editing blind with update_task destroys content.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "number" },
        old_str: { type: "string", description: "Exact text to replace. Must appear exactly once unless replace_all is set." },
        new_str: { type: "string", description: "Replacement text. Empty string deletes it." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one" },
      },
      required: ["task_id", "old_str", "new_str"],
      additionalProperties: false,
    },
    // The whole point is that the caller never has to hold the full description,
    // so the match and the write both happen here against the stored HTML.
    run: async ({ task_id, old_str, new_str, replace_all }) => {
      const current = await vk(EP.task(task_id));
      const before = String(current.description ?? "");
      const count = old_str ? before.split(old_str).length - 1 : 0;
      if (count === 0) {
        throw new Error(`Not found in task ${task_id}'s description. Remember it is stored as HTML, so match the rendered markup (e.g. "<p>text</p>"), not the markdown you wrote. Use get_description to see the raw text.`);
      }
      if (count > 1 && !replace_all) {
        throw new Error(`"${old_str.slice(0, 40)}..." appears ${count} times; pass replace_all:true or give a longer, unique string.`);
      }
      const after = replace_all ? before.split(old_str).join(new_str) : before.replace(old_str, new_str);
      await vk(EP.task(task_id), { method: "POST", body: { ...current, description: after } });
      return { task_id, replaced: replace_all ? count : 1, chars_before: before.length, chars_after: after.length };
    },
  },
  {
    name: "get_description",
    description: "Fetch a task's description in full and untruncated, as stored (HTML). get_task returns it stripped of tags; use this when you need the exact markup — before rewriting it, or to find the exact string to pass to edit_description.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "number" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    run: async ({ task_id }) => {
      const t = await vk(EP.task(task_id));
      const description = String(t.description ?? "");
      return { task_id, title: t.title, chars: description.length, description };
    },
  },
  {
    name: "get_task",
    description: "Fetch one task with its description and comments in FULL — nothing truncated. Use this to read a whole ticket. (list_tasks previews descriptions at 500 chars and flags them with description_truncated.)",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "number" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    run: async ({ task_id }) => {
      const task = await vk(EP.task(task_id));
      let comments = [];
      try {
        comments = (await vk(EP.comments(task_id)) ?? []).map((c) => ({
          author: c.author?.username, created: c.created, comment: strip(c.comment),
        }));
      } catch { /* comments optional; don't fail the read */ }
      return { ...slimTask(task), comments };
    },
  },
  {
    name: "create_task",
    description: "Create a task in a project. `description` is markdown by default and is converted to HTML, which is what Vikunja renders.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        title: { type: "string" },
        description: { type: "string", description: "Markdown (default) or HTML — see description_format" },
        description_format: { type: "string", enum: ["markdown", "html"], description: "Default markdown" },
        due_date: { type: "string", description: "ISO timestamp" },
        priority: { type: "number", description: "0-5" },
      },
      required: ["project_id", "title"],
      additionalProperties: false,
    },
    run: async ({ project_id, title, description, description_format, due_date, priority }) =>
      slimTask(await vk(EP.createTask(project_id), {
        method: "PUT",
        body: { title, description: mdToHtml(description, description_format), due_date, priority },
      })),
  },
  {
    name: "update_task",
    description: "Update an existing task. Only the fields you pass are changed. `description` is markdown by default.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "number" },
        title: { type: "string" },
        description: { type: "string" },
        description_format: { type: "string", enum: ["markdown", "html"], description: "Default markdown" },
        done: { type: "boolean" },
        due_date: { type: "string", description: "ISO timestamp" },
        priority: { type: "number", description: "0-5" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    // Update is POST on the task, and Vikunja replaces the whole object —
    // so merge onto what is already there instead of blanking the rest.
    run: async ({ task_id, title, description, description_format, done, due_date, priority }) => {
      const current = await vk(EP.task(task_id));
      const body = { ...current };
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = mdToHtml(description, description_format);
      if (done !== undefined) body.done = done;
      if (due_date !== undefined) body.due_date = due_date;
      if (priority !== undefined) body.priority = priority;
      return slimTask(await vk(EP.task(task_id), { method: "POST", body }));
    },
  },
  {
    name: "add_attachment",
    description: "Attach a file (image, PDF, log) to a task. Content is base64. Max ~15MB.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "number" },
        filename: { type: "string", description: "e.g. screenshot.png" },
        content_base64: { type: "string", description: "Base64 of the file bytes, no data: prefix" },
        mime_type: { type: "string", description: "e.g. image/png" },
      },
      required: ["task_id", "filename", "content_base64"],
      additionalProperties: false,
    },
    run: async ({ task_id, filename, content_base64, mime_type }) => {
      const buffer = Buffer.from(content_base64, "base64");
      if (!buffer.length) throw new Error("content_base64 decoded to zero bytes");
      if (buffer.length > 15 * 1024 * 1024) throw new Error(`${filename} is ${(buffer.length/1048576).toFixed(1)}MB — over the 15MB limit`);
      const out = await vkUpload(EP.attachments(task_id), { filename, buffer, mimeType: mime_type });
      return { task_id, filename, bytes: buffer.length, result: out };
    },
  },
  {
    name: "attach_from_url",
    description: "Download a file from a URL and attach it to a task. For migrating images out of another tracker: the server fetches the bytes itself, so they never pass through the conversation. Signed URLs (e.g. Linear's uploads.linear.app links) work as-is and usually expire in minutes — call this promptly after fetching the link.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "number" },
        url: { type: "string", description: "http(s) URL of the file" },
        filename: { type: "string", description: "Override the name; defaults to the URL's last path segment" },
        mime_type: { type: "string", description: "Override; defaults to the response Content-Type" },
      },
      required: ["task_id", "url"],
      additionalProperties: false,
    },
    run: async ({ task_id, url, filename, mime_type }) => {
      let u;
      try { u = new URL(url); } catch { throw new Error(`Not a valid URL: ${url}`); }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`Refusing protocol ${u.protocol}`);
      // This tool fetches arbitrary URLs from inside the private network, so
      // keep it pointed outward: no loopback, link-local or RFC1918 targets.
      const host = u.hostname.toLowerCase();
      const blocked =
        host === "localhost" || host.endsWith(".localhost") || host === "vikunja" ||
        /^(127\.|0\.|10\.|169\.254\.|192\.168\.)/.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        host === "::1" || host === "[::1]";
      if (blocked) throw new Error(`Refusing to fetch a private/loopback address: ${host}`);

      const res = await fetch(u, { redirect: "follow" });
      if (!res.ok) throw new Error(`GET ${host}${u.pathname} -> ${res.status} ${res.statusText} (a signed URL may have expired)`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) throw new Error("Downloaded zero bytes");
      if (buffer.length > 15 * 1024 * 1024) throw new Error(`${(buffer.length/1048576).toFixed(1)}MB — over the 15MB limit`);

      const name = filename || decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "") || "attachment";
      const type = mime_type || res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
      const out = await vkUpload(EP.attachments(task_id), { filename: name, buffer, mimeType: type });
      return { task_id, filename: name, bytes: buffer.length, mime_type: type, source: host + u.pathname, result: out };
    },
  },
  {
    name: "list_attachments",
    description: "List files attached to a task.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "number" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    run: async ({ task_id }) => ((await vk(EP.attachments(task_id))) ?? []).map((a) => ({
      id: a.id, file: a.file?.name, size: a.file?.size, created: a.created,
    })),
  },
  {
    name: "list_buckets",
    description: "List kanban buckets (columns) of a project.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "number" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    run: async ({ project_id }) => {
      const view = await kanbanView(project_id);
      const buckets = await vk(EP.buckets(project_id, view.id));
      return { view_id: view.id, buckets: (buckets ?? []).map((b) => ({ id: b.id, title: b.title })) };
    },
  },
  {
    name: "move_task",
    description: "Move a task into a kanban bucket by title or id.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        task_id: { type: "number" },
        bucket: { type: ["string", "number"], description: "Bucket title e.g. 'In Review', or its id" },
      },
      required: ["project_id", "task_id", "bucket"],
      additionalProperties: false,
    },
    run: async ({ project_id, task_id, bucket }) => {
      const view = await kanbanView(project_id);
      const buckets = await vk(EP.buckets(project_id, view.id)) ?? [];
      const target = typeof bucket === "number"
        ? buckets.find((b) => b.id === bucket)
        : buckets.find((b) => (b.title ?? "").toLowerCase() === String(bucket).toLowerCase());
      if (!target) throw new Error(`No bucket "${bucket}". Available: ${buckets.map((b) => b.title).join(", ")}`);
      if (BLOCK_DONE && (target.title ?? "").toLowerCase() === DONE_TITLE) {
        throw new Error(`Refusing to move task ${task_id} to "${target.title}" — closing tickets is reserved for a human (MCP_BLOCK_DONE=true).`);
      }
      await vk(EP.bucketTasks(project_id, view.id, target.id), { method: "POST", body: { task_id } });
      return { moved: task_id, to: target.title, bucket_id: target.id };
    },
  },
  {
    name: "add_comment",
    description: "Add a comment to a task.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "number" }, comment: { type: "string" } },
      required: ["task_id", "comment"],
      additionalProperties: false,
    },
    run: async ({ task_id, comment }) => {
      const c = await vk(EP.comments(task_id), { method: "PUT", body: { comment } });
      return { id: c?.id, task_id, created: c?.created };
    },
  },
  {
    name: "check_api",
    description: "Self-test: probe the Vikunja endpoints this server uses and report which work.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "number" } },
      additionalProperties: false,
    },
    run: async ({ project_id }) => {
      const results = [];
      const probe = async (name, fn) => {
        try { results.push({ endpoint: name, ok: true, sample: await fn() }); }
        catch (e) { results.push({ endpoint: name, ok: false, error: String(e.message ?? e) }); }
      };
      await probe("GET /projects", async () => `${((await vk(EP.projects())) ?? []).length} projects`);
      let pid = project_id;
      if (!pid) { try { pid = (await vk(EP.projects()))?.[0]?.id; } catch { /* reported above */ } }
      if (pid) {
        await probe(`GET /projects/${pid}/tasks`, async () =>
          `${((await vk(EP.projectTasks(pid), { query: { per_page: 1 } })) ?? []).length} task(s)`);
        await probe(`GET /projects/${pid}/views`, async () => `kanban view id ${(await kanbanView(pid)).id}`);
        await probe("GET buckets", async () => {
          const v = await kanbanView(pid);
          return ((await vk(EP.buckets(pid, v.id))) ?? []).map((b) => b.title).join(" | ") || "(none)";
        });
      } else {
        results.push({ endpoint: "tasks/views/buckets", ok: false, error: "no project to test against" });
      }
      return { vikunja_url: VIKUNJA_URL, block_done: BLOCK_DONE, max_page: MAX_PAGE, results,
        note: "Writes are not probed — test create_task / move_task / add_comment by hand." };
    },
  },
];

const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/* ---------------------------- JSON-RPC ---------------------------- */
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleRpc(msg) {
  const { id, method, params } = msg ?? {};
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "vikunja-mcp", version: "1.1.0" },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = BY_NAME[params?.name];
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const out = await tool.run(params?.arguments ?? {});
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return rpcResult(id, { isError: true, content: [{ type: "text", text: String(e.message ?? e) }] });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function tokenOk(header) {
  const p = (header ?? "").startsWith("Bearer ") ? header.slice(7) : "";
  if (!p || p.length !== MCP_AUTH_TOKEN.length) return false;
  let d = 0;
  for (let i = 0; i < p.length; i++) d |= p.charCodeAt(i) ^ MCP_AUTH_TOKEN.charCodeAt(i);
  return d === 0;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
};

const server = http.createServer((req, res) => {
  const log = (status, note) =>
    console.error(
      `${new Date().toISOString()} ${req.method} ${req.url} -> ${status}` +
      ` auth=${req.headers.authorization ? "present" : "absent"}` +
      ` accept=${req.headers.accept ?? "-"}${note ? ` (${note})` : ""}`
    );

  if (req.method === "GET" && req.url === "/healthz") {
    log(200);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  const isMcp = req.url.startsWith("/mcp");

  // Preflight — answer before the auth check, it carries no credentials.
  if (req.method === "OPTIONS" && isMcp) {
    log(204, "preflight");
    res.writeHead(204, CORS); return res.end();
  }

  // We serve JSON responses only, no server-initiated SSE stream. The spec
  // requires 405 (not 404) here so the client knows the endpoint exists.
  if (isMcp && (req.method === "GET" || req.method === "DELETE")) {
    log(405, "no SSE stream offered");
    res.writeHead(405, { Allow: "POST, OPTIONS", "Content-Type": "application/json", ...CORS });
    return res.end(JSON.stringify(rpcError(null, -32000, "Method Not Allowed: POST JSON-RPC to this endpoint.")));
  }

  if (req.method !== "POST" || !isMcp) {
    log(404);
    res.writeHead(404); return res.end();
  }
  if (!tokenOk(req.headers.authorization)) {
    log(401, "token mismatch");
    res.writeHead(401, { "Content-Type": "application/json", ...CORS });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 1_000_000) { res.writeHead(413); res.end(); req.destroy(); }
  });
  req.on("end", async () => {
    let msg;
    try { msg = JSON.parse(body || "{}"); }
    catch { res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(rpcError(null, -32700, "Parse error"))); }

    // Notifications (no id) get 202 with no body, per spec.
    const batch = Array.isArray(msg) ? msg : [msg];
    const methods = batch.map((m) => m?.method ?? "?").join(",");
    const needsReply = batch.filter((m) => m && m.id !== undefined && m.id !== null);
    if (needsReply.length === 0) { log(202, `notification ${methods}`); res.writeHead(202, CORS); return res.end(); }

    try {
      const out = await Promise.all(needsReply.map(handleRpc));
      log(200, methods);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
    } catch (e) {
      console.error("rpc failure:", e);
      log(500, methods);
      res.writeHead(500, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(rpcError(null, -32603, "Internal error")));
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.error(`vikunja-mcp on :${PORT} -> ${VIKUNJA_URL} (block_done=${BLOCK_DONE})`);
});
