#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";

// ── northbase constants ───────────────────────────────────────────────────────

const SUPABASE_URL = "https://ivxgpjracfctkkdhlwgm.supabase.co";
const SUPABASE_KEY = "sb_publishable_LZkkAwsx9q5KgIAeoZAO_A_U88rfFHL";

const NORTHBASE_DIR = path.join(os.homedir(), ".northbase");
const ROOT          = path.join(NORTHBASE_DIR, "files");
const INDEX_PATH    = path.join(NORTHBASE_DIR, "index.json");
const SESSION_PATH  = path.join(NORTHBASE_DIR, "session.json");
const MAX_BYTES     = 500_000;

const DEBUG = !!process.env.NORTHBASE_DEBUG;
function debug(...args) {
  if (DEBUG) console.error("NORTHBASE DEBUG", ...args);
}

// ── directory / index helpers ─────────────────────────────────────────────────

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  } catch {
    return { files: {} };
  }
}

function saveIndex(idx) {
  ensureDir(path.dirname(INDEX_PATH));
  fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2));
}

// ── session helpers ───────────────────────────────────────────────────────────

function normalizeSession(s) {
  let expiresAt = s.expires_at;
  if (expiresAt && expiresAt > 1e12) expiresAt = Math.floor(expiresAt / 1000);
  if (!expiresAt && s.expires_in) expiresAt = Math.floor(Date.now() / 1000) + s.expires_in;
  return { ...s, expires_at: expiresAt ?? 0 };
}

function loadSession() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
    if (!s?.access_token || !s?.refresh_token) throw new Error("incomplete");
    return s;
  } catch {
    throw new Error("Not logged in. Run `northbase login`.");
  }
}

function saveSession(session) {
  ensureDir(NORTHBASE_DIR);
  const normalized = normalizeSession(session);
  const tmp = SESSION_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SESSION_PATH);
  debug("session.json written expires_at=" + normalized.expires_at);
}

function deleteSession() {
  try { fs.unlinkSync(SESSION_PATH); } catch { /* already gone */ }
}

// ── authenticated supabase client ─────────────────────────────────────────────

async function doRefresh(supabase, stored) {
  debug("refresh starting");
  console.error("NORTHBASE session refreshing");
  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: stored.refresh_token,
  });
  if (error) {
    const revoked = error.message?.includes("invalid_grant")
                 || error.message?.includes("Refresh Token Not Found")
                 || error.message?.includes("refresh_token_not_found")
                 || error.error === "invalid_grant"
                 || error.code  === "invalid_grant"
                 || error.code  === "refresh_token_not_found";
    if (revoked) {
      console.error("NORTHBASE session token invalid — deleting session.json");
      deleteSession();
      throw new Error("Refresh token is no longer valid. Run `northbase login`.");
    }
    throw new Error(`Session refresh failed (${error.message}) — session preserved, will retry next command.`);
  }
  const newSession = data.session;
  if (!newSession?.access_token || !newSession?.refresh_token) {
    throw new Error("Refresh returned incomplete session. Run `northbase login`.");
  }
  debug(`refresh ok refresh_token_rotated=${newSession.refresh_token !== stored.refresh_token}`);
  saveSession(newSession);
  const { error: setErr } = await supabase.auth.setSession({
    access_token:  newSession.access_token,
    refresh_token: newSession.refresh_token,
  });
  if (setErr) throw setErr;
}

async function getAuthenticatedClient() {
  const stored = loadSession();
  debug(`session loaded expires_at=${stored.expires_at}`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const nowSec        = Math.floor(Date.now() / 1000);
  const expiresAt     = stored.expires_at ?? 0;
  const secsRemaining = expiresAt - nowSec;
  const needsRefresh  = expiresAt === 0 || secsRemaining <= 60;
  debug(`seconds_remaining=${secsRemaining} needs_refresh=${needsRefresh}`);

  if (needsRefresh) {
    await doRefresh(supabase, stored);
  } else {
    const { data: setData, error } = await supabase.auth.setSession({
      access_token:  stored.access_token,
      refresh_token: stored.refresh_token,
    });
    if (error) {
      debug(`setSession failed (${error.message}) — falling back to refresh`);
      await doRefresh(supabase, stored);
    } else if (setData?.session && setData.session.access_token !== stored.access_token) {
      console.error("NORTHBASE setSession triggered internal refresh — persisting new session");
      saveSession(setData.session);
    }
  }

  return supabase;
}

// ── path helpers ──────────────────────────────────────────────────────────────

function safeRel(pth) {
  const cleaned = (pth ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = cleaned.split("/");
  if (!cleaned || parts.some((s) => s === "." || s === ".." || s.trim() === "")) {
    throw new Error(`Unsafe path: ${pth}`);
  }
  return cleaned;
}

function localFullPath(rel) {
  return path.join(ROOT, safeRel(rel));
}

function readLocal(rel) {
  const full = localFullPath(rel);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}

function writeLocal(rel, content) {
  const full = localFullPath(rel);
  ensureDir(path.dirname(full));
  fs.writeFileSync(full, content, "utf8");
}

// ── supabase queries ──────────────────────────────────────────────────────────

async function fetchRemoteUpdatedAt(supabase, rel) {
  const relSafe = safeRel(rel);
  const { data, error } = await supabase
    .from("files").select("updated_at").eq("path", relSafe).limit(1);
  if (error) throw error;
  return data?.[0]?.updated_at ?? null;
}

async function fetchRemoteContent(supabase, rel) {
  const relSafe = safeRel(rel);
  const { data, error } = await supabase
    .from("files").select("content, updated_at").eq("path", relSafe).limit(1);
  if (error) throw error;
  return { content: data?.[0]?.content ?? "", updated_at: data?.[0]?.updated_at ?? null };
}

// ── core file operations ──────────────────────────────────────────────────────

async function getFile(rel) {
  const relSafe  = safeRel(rel);
  const supabase = await getAuthenticatedClient();
  ensureDir(ROOT);
  const idx    = loadIndex();
  const local  = readLocal(relSafe);
  const cached = idx.files?.[relSafe];

  if (local === null) {
    const { content, updated_at } = await fetchRemoteContent(supabase, relSafe);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_BYTES) throw new Error(`File too large (${bytes} bytes)`);
    writeLocal(relSafe, content);
    idx.files[relSafe] = { updated_at, bytes };
    saveIndex(idx);
    return content;
  }

  const remoteUpdatedAt = await fetchRemoteUpdatedAt(supabase, relSafe);
  if (!remoteUpdatedAt) return local;
  if (cached?.updated_at === remoteUpdatedAt) return local;

  const { content, updated_at } = await fetchRemoteContent(supabase, relSafe);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_BYTES) throw new Error(`File too large (${bytes} bytes)`);
  writeLocal(relSafe, content);
  idx.files[relSafe] = { updated_at, bytes };
  saveIndex(idx);
  return content;
}

async function putFile(rel, content) {
  const relSafe = safeRel(rel);
  const bytes   = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_BYTES) throw new Error(`File too large (${bytes} bytes)`);

  const supabase = await getAuthenticatedClient();
  ensureDir(ROOT);
  const idx = loadIndex();

  const { error } = await supabase
    .from("files")
    .upsert({ path: relSafe, content }, { onConflict: "owner_id,path" });
  if (error) throw error;

  const updated_at = await fetchRemoteUpdatedAt(supabase, relSafe);
  writeLocal(relSafe, content);
  idx.files[relSafe] = { updated_at, bytes };
  saveIndex(idx);

  return { bytes, updated_at };
}

async function concurrentMap(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function listFiles(prefix) {
  const supabase = await getAuthenticatedClient();
  let query = supabase.from("files").select("path").order("path", { ascending: true });
  if (prefix) query = query.like("path", `${prefix}%`);
  const { data, error } = await query;
  if (error) throw error;
  return data.map((row) => row.path);
}

async function pullFiles(prefix) {
  ensureDir(ROOT);
  const idx      = loadIndex();
  const supabase = await getAuthenticatedClient();

  let query = supabase.from("files").select("path, updated_at").order("path", { ascending: true });
  if (prefix) query = query.like("path", `${prefix}%`);
  const { data: remote, error } = await query;
  if (error) throw error;

  let downloaded = 0, skipped = 0;
  await concurrentMap(remote, 5, async (row) => {
    const rel    = row.path;
    const cached = idx.files?.[rel];
    if (cached?.updated_at === row.updated_at) { skipped++; return; }
    const { data: rows, error: err } = await supabase
      .from("files").select("content, updated_at").eq("path", rel).limit(1);
    if (err) throw err;
    const content    = rows?.[0]?.content  ?? "";
    const updated_at = rows?.[0]?.updated_at ?? row.updated_at;
    const bytes      = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_BYTES) throw new Error(`File too large (${bytes} bytes): ${rel}`);
    writeLocal(rel, content);
    idx.files[rel] = { updated_at, bytes };
    downloaded++;
  });

  saveIndex(idx);
  return { total: remote.length, downloaded, skipped };
}

function whoami() {
  let stored;
  try { stored = loadSession(); } catch { return { loggedIn: false }; }
  return { loggedIn: true, email: stored.user?.email ?? "(unknown)", id: stored.user?.id ?? "(unknown)" };
}

function sessionStatus() {
  let stored;
  try { stored = loadSession(); } catch { return { loggedIn: false }; }
  const nowSec        = Math.floor(Date.now() / 1000);
  const expiresAt     = stored.expires_at ?? 0;
  const secsRemaining = expiresAt - nowSec;
  return { loggedIn: true, email: stored.user?.email ?? "(unknown)", nowSec, expiresAt, secsRemaining, willRefreshSoon: secsRemaining <= 60 };
}

// ── MCP tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "northbase_get",
    description: "Get the content of a file stored in northbase by its path. Uses a local cache at ~/.northbase/files/ and only fetches from the remote when the cached copy is stale.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path (e.g. 'ideas.md' or 'notes/todo.txt'). Must not contain '..', '.', empty segments, or leading slashes." },
      },
      required: ["path"],
    },
  },
  {
    name: "northbase_put",
    description: "Write content to a file in northbase. Creates the file if it doesn't exist, or overwrites it if it does. Updates the local cache after writing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path (e.g. 'ideas.md' or 'notes/todo.txt')." },
        content: { type: "string", description: "The full text content to write to the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "northbase_list",
    description: "List all file paths stored in northbase. Optionally filter to paths starting with a given prefix.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Optional path prefix to filter by (e.g. 'memory/'). Omit to list all files." },
      },
      required: [],
    },
  },
  {
    name: "northbase_pull",
    description: "Bulk-sync files from northbase to the local cache at ~/.northbase/files/. Only downloads files whose remote updated_at differs from the cached value.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: { type: "string", description: "Optional path prefix to limit the sync (e.g. 'memory/'). Omit to sync everything." },
      },
      required: [],
    },
  },
  {
    name: "northbase_whoami",
    description: "Return the email and user ID of the currently authenticated northbase user.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "northbase_session_status",
    description: "Return session information: login status, email, token expiry time, seconds remaining, and whether a refresh is imminent.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "northbase-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "northbase_get": {
        const content = await getFile(args.path);
        return { content: [{ type: "text", text: content }] };
      }
      case "northbase_put": {
        const result = await putFile(args.path, args.content);
        return { content: [{ type: "text", text: `PUT ok ${args.path} bytes=${result.bytes} updated_at=${result.updated_at}` }] };
      }
      case "northbase_list": {
        const paths = await listFiles(args.prefix || undefined);
        return { content: [{ type: "text", text: paths.length > 0 ? paths.join("\n") : "(no files found)" }] };
      }
      case "northbase_pull": {
        const result = await pullFiles(args.prefix || undefined);
        return { content: [{ type: "text", text: `PULL ok files=${result.total} downloaded=${result.downloaded} skipped=${result.skipped}` }] };
      }
      case "northbase_whoami": {
        const result = whoami();
        if (!result.loggedIn) return { content: [{ type: "text", text: "Not logged in. Run `northbase login` in a terminal." }], isError: true };
        return { content: [{ type: "text", text: `Logged in as ${result.email} (${result.id})` }] };
      }
      case "northbase_session_status": {
        const s = sessionStatus();
        if (!s.loggedIn) return { content: [{ type: "text", text: "Not logged in. Run `northbase login` in a terminal." }], isError: true };
        return { content: [{ type: "text", text: [`email=${s.email}`, `now=${s.nowSec}`, `expires_at=${s.expiresAt}`, `seconds_remaining=${s.secsRemaining}`, `will_refresh_soon=${s.willRefreshSoon}`].join("\n") }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err?.message ?? err}` }], isError: true };
  }
});

// ── process-level error traps ─────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  console.error("[northbase-mcp] uncaughtException:", err?.stack ?? err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[northbase-mcp] unhandledRejection:", reason?.stack ?? reason);
  process.exit(1);
});

// ── startup ───────────────────────────────────────────────────────────────────

console.error("[northbase-mcp] starting up, node", process.version, "pid", process.pid);

try {
  const transport = new StdioServerTransport();
  console.error("[northbase-mcp] transport created");
  await server.connect(transport);
  console.error("[northbase-mcp] connected, server running");
} catch (err) {
  console.error("[northbase-mcp] fatal startup error:", err?.stack ?? err);
  process.exit(1);
}
