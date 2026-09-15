/**
 * vikunja-mcp — MCP bridge to a self-hosted Vikunja.
 * Zero dependencies: plain node:http + hand-rolled JSON-RPC, so it runs on
 * a stock node image with no build step and no npm install.
 *
 * Transport: streamable HTTP (single JSON responses), bearer auth.
 */

import http from "node:http";

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
  createTask: (pid) => `/api/v1/projects/${pid}`,
  task: (id) => `/api/v1/tasks/${id}`,
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

const strip = (s) => String(s ?? "").replace(/<[^>]*>/g, "").trim();

function slimTask(t) {
  if (!t || typeof t !== "object") return t;
  return {
    id: t.id,
    identifier: t.identifier,
    title: t.title,
    description: strip(t.description).slice(0, 500),
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
      return (tasks ?? []).map(slimTask);
    },
  },
  {
    name: "get_task",
    description: "Fetch one task in full, including comments.",
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
          author: c.author?.username, created: c.created, comment: strip(c.comment).slice(0, 1000),
        }));
      } catch { /* comments optional; don't fail the read */ }
      return { ...slimTask(task), comments };
    },
  },
  {
    name: "create_task",
    description: "Create a task in a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "number" },
        title: { type: "string" },
        description: { type: "string" },
        due_date: { type: "string", description: "ISO timestamp" },
        priority: { type: "number", description: "0-5" },
      },
      required: ["project_id", "title"],
      additionalProperties: false,
    },
    // Creation is PUT on the project, not POST on /tasks.
    run: async ({ project_id, title, description, due_date, priority }) =>
      slimTask(await vk(EP.createTask(project_id), { method: "PUT", body: { title, description, due_date, priority } })),
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
        serverInfo: { name: "vikunja-mcp", version: "1.0.0" },
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
