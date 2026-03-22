#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { createClient } from "@supabase/supabase-js";

// ── constants ─────────────────────────────────────────────────────────────────

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
  if (expiresAt && expiresAt > 1e12) expiresAt = Math.floor(expiresAt / 1000); // ms → s
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
    // Transient error (network, rate limit, etc.) — do NOT delete session.json
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
      // setSession decoded the JWT, found it expired, and internally called _callRefreshToken().
      // The new tokens are returned in setData.session but NOT written to disk
      // (persistSession: false suppresses supabase-js's internal _saveSession).
      // Persist them now — otherwise session.json keeps the consumed refresh_token
      // and the next command fails with "Refresh Token Not Found".
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
    .from("files")
    .select("updated_at")
    .eq("path", relSafe)
    .limit(1);
  if (error) throw error;
  return data?.[0]?.updated_at ?? null;
}

async function fetchRemoteContent(supabase, rel) {
  const relSafe = safeRel(rel);
  const { data, error } = await supabase
    .from("files")
    .select("content, updated_at")
    .eq("path", relSafe)
    .limit(1);
  if (error) throw error;
  return { content: data?.[0]?.content ?? "", updated_at: data?.[0]?.updated_at ?? null };
}

// ── core commands ─────────────────────────────────────────────────────────────

export async function getFile(rel) {
  const relSafe  = safeRel(rel);
  const supabase = await getAuthenticatedClient();
  ensureDir(ROOT);
  const idx    = loadIndex();
  const local  = readLocal(relSafe);
  const cached = idx.files?.[relSafe];

  if (local === null) {
    console.error("NORTHBASE GET remote-refresh", relSafe);
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

  if (cached?.updated_at === remoteUpdatedAt) {
    console.error("NORTHBASE GET local-hit", relSafe);
    return local;
  }

  console.error("NORTHBASE GET remote-refresh", relSafe);
  const { content, updated_at } = await fetchRemoteContent(supabase, relSafe);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_BYTES) throw new Error(`File too large (${bytes} bytes)`);
  writeLocal(relSafe, content);
  idx.files[relSafe] = { updated_at, bytes };
  saveIndex(idx);
  return content;
}

export async function putFile(rel, content) {
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

  console.error("NORTHBASE PUT", relSafe, `bytes=${bytes}`, `updated_at=${updated_at}`);
  return { bytes, updated_at };
}

// ── concurrency helper ────────────────────────────────────────────────────────

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

// ── list / pull commands ──────────────────────────────────────────────────────

export async function listFiles(prefix) {
  const supabase = await getAuthenticatedClient();
  let query = supabase.from("files").select("path").order("path", { ascending: true });
  if (prefix) query = query.like("path", `${prefix}%`);
  const { data, error } = await query;
  if (error) throw error;
  return data.map((row) => row.path);
}

export async function pullFiles(prefix) {
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
    if (cached?.updated_at === row.updated_at) {
      skipped++;
      return;
    }
    console.error("NORTHBASE PULL download", rel);
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

// ── auth info ─────────────────────────────────────────────────────────────────

export function whoami() {
  let stored;
  try { stored = loadSession(); } catch {
    return { loggedIn: false };
  }
  return {
    loggedIn: true,
    email: stored.user?.email ?? "(unknown)",
    id:    stored.user?.id    ?? "(unknown)",
  };
}

export function sessionStatus() {
  let stored;
  try { stored = loadSession(); } catch {
    return { loggedIn: false };
  }
  const nowSec        = Math.floor(Date.now() / 1000);
  const expiresAt     = stored.expires_at ?? 0;
  const secsRemaining = expiresAt - nowSec;
  return {
    loggedIn:        true,
    email:           stored.user?.email ?? "(unknown)",
    nowSec,
    expiresAt,
    secsRemaining,
    willRefreshSoon: secsRemaining <= 60,
  };
}

// ── interactive prompts ───────────────────────────────────────────────────────

async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function promptPassword(question) {
  if (!process.stdin.isTTY) {
    throw new Error("`northbase login` requires an interactive terminal (stdin is not a TTY).");
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    let pass = "";

    const onData = (buf) => {
      const ch = buf.toString("utf8");
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        // enter / ctrl-d
        process.stdin.setRawMode(false);
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(pass);
      } else if (ch === "\u0003") {
        // ctrl-c
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(1);
      } else if (ch === "\u007f" || ch === "\b") {
        // backspace
        if (pass.length > 0) pass = pass.slice(0, -1);
      } else {
        pass += ch;
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ── auth commands ─────────────────────────────────────────────────────────────

async function cmdLogin() {
  const email    = await promptLine("Email: ");
  const password = await promptPassword("Password: ");

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;

  saveSession(data.session);
  console.log("Logged in.");
}

async function cmdLogout() {
  let supabase;
  try {
    supabase = await getAuthenticatedClient();
  } catch { /* not logged in — still clean up local session */ }

  if (supabase) {
    try { await supabase.auth.signOut(); } catch { /* best-effort */ }
  }

  deleteSession();
  console.log("Logged out.");
}

async function cmdWhoami() {
  const result = whoami();
  if (!result.loggedIn) { console.log("Not logged in."); return; }
  console.log(`Logged in as ${result.email} (${result.id})`);
}

async function cmdSession() {
  const s = sessionStatus();
  if (!s.loggedIn) { console.log("Not logged in."); return; }
  console.log(`now=${s.nowSec}`);
  console.log(`expires_at=${s.expiresAt}`);
  console.log(`seconds_remaining=${s.secsRemaining}`);
  console.log(`will_refresh_soon=${s.willRefreshSoon}`);
  console.log(`email=${s.email}`);
}

async function cmdAuthDebug() {
  const exists = fs.existsSync(SESSION_PATH);
  console.log(`session_file_exists=${exists}`);
  if (!exists) { console.log("status=not_logged_in"); return; }

  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
  } catch (e) {
    console.log(`session_file_parse_error=${e.message}`);
    return;
  }

  const nowSec        = Math.floor(Date.now() / 1000);
  const expiresAt     = stored.expires_at ?? 0;
  const secsRemaining = expiresAt - nowSec;

  console.log(`has_access_token=${!!stored.access_token}`);
  console.log(`has_refresh_token=${!!stored.refresh_token}`);
  console.log(`refresh_token_prefix=${stored.refresh_token?.slice(0, 6) ?? "none"}`);
  console.log(`expires_at=${expiresAt}`);
  console.log(`seconds_remaining=${secsRemaining}`);
  console.log(`will_refresh_soon=${secsRemaining <= 60}`);
  console.log(`email=${stored.user?.email ?? "(unknown)"}`);

  try {
    const stat = fs.statSync(SESSION_PATH);
    const mtimeSec = Math.floor(stat.mtimeMs / 1000);
    console.log(`session_file_mtime=${mtimeSec}`);
    console.log(`session_file_age_seconds=${nowSec - mtimeSec}`);
  } catch { /* ignore */ }

  let refreshAttempted = false, refreshSucceeded = false, userFetchSucceeded = false;
  try {
    const supabase = await getAuthenticatedClient();
    const after    = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
    refreshAttempted  = secsRemaining <= 60 || after.expires_at !== expiresAt;
    refreshSucceeded  = !!after.access_token;
    console.log(`token_silently_refreshed=${after.access_token !== stored.access_token}`);
    console.log(`refresh_token_rotated=${after.refresh_token?.slice(0,6) !== stored.refresh_token?.slice(0,6)}`);
    console.log(`new_expires_at=${after.expires_at}`);
    const { data, error } = await supabase.auth.getUser();
    userFetchSucceeded = !error && !!data?.user;
  } catch (e) {
    console.log(`auth_error=${e.message}`);
  }

  console.log(`refresh_attempted=${refreshAttempted}`);
  console.log(`refresh_succeeded=${refreshSucceeded}`);
  console.log(`user_fetch_succeeded=${userFetchSucceeded}`);
}

// ── CLI main ──────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "login")      { await cmdLogin();        return; }
  if (cmd === "logout")     { await cmdLogout();       return; }
  if (cmd === "whoami")     { await cmdWhoami();       return; }
  if (cmd === "session")    { await cmdSession();      return; }
  if (cmd === "auth-debug") { await cmdAuthDebug();    return; }

  if (cmd === "list") {
    const paths = await listFiles(args[0]);
    for (const p of paths) process.stdout.write(p + "\n");
    return;
  }

  if (cmd === "pull") {
    const result = await pullFiles(args[0]);
    console.log(`PULL ok files=${result.total} downloaded=${result.downloaded} skipped=${result.skipped}`);
    return;
  }

  if (cmd === "get") {
    const rel = args[0];
    if (!rel) { console.log("Usage: northbase get <path>"); process.exit(1); }
    const content = await getFile(rel);
    process.stdout.write(content);
    return;
  }

  if (cmd === "put") {
    const rel = args[0];
    if (!rel) { console.log("Usage: northbase put <path>"); process.exit(1); }
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const content = Buffer.concat(chunks).toString("utf8");
    const result  = await putFile(rel, content);
    console.log(`PUT ok ${safeRel(rel)} bytes=${result.bytes} updated_at=${result.updated_at}`);
    return;
  }

  console.log("Usage:");
  console.log("  northbase login");
  console.log("  northbase logout");
  console.log("  northbase whoami");
  console.log("  northbase session");
  console.log("  northbase auth-debug");
  console.log("  northbase list [prefix]");
  console.log("  northbase pull [prefix]");
  console.log("  northbase get <path>");
  console.log("  northbase put <path>");
  process.exit(1);
}

// Only run CLI when executed directly (not when imported as a library)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    console.error("NORTHBASE:", e?.message ?? e);
    process.exit(1);
  });
}
