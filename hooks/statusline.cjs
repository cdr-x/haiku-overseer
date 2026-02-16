// hooks/statusline.cjs
// Claude Code status line: shows haiku-overseer metrics from memory.db
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

try {
  const cwd = process.cwd();
  const overseerDir = path.join(cwd, ".haiku-overseer");
  const dbPath = path.join(overseerDir, "memory.db");
  if (!fs.existsSync(dbPath)) {
    console.log("\x1b[35m\u{1F441} Overseer:\x1b[0m waiting for first call...");
    process.exit(0);
  }

  // Read current session ID (written by session-start hook)
  let sessionId = "default";
  const sessionFile = path.join(overseerDir, "current-session");
  try {
    if (fs.existsSync(sessionFile)) {
      sessionId = fs.readFileSync(sessionFile, "utf-8").trim();
    }
  } catch {}

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("journal_mode = WAL");
  db.pragma("query_only = ON");

  // Check if cache columns exist (migration compat)
  const cols = db.prepare("PRAGMA table_info(token_usage)").all().map(c => c.name);
  const hasCache = cols.includes("cache_creation_tokens");
  const usage = hasCache
    ? db.prepare("SELECT COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COALESCE(SUM(cache_creation_tokens),0) as cc, COALESCE(SUM(cache_read_tokens),0) as cr, COUNT(*) as cnt FROM token_usage").get()
    : { ...db.prepare("SELECT COALESCE(SUM(input_tokens),0) as inp, COALESCE(SUM(output_tokens),0) as out, COUNT(*) as cnt FROM token_usage").get(), cc: 0, cr: 0 };
  const estCost = ((usage.inp / 1e6) * 0.8 + (usage.out / 1e6) * 4 + (usage.cc / 1e6) * 1.0 + (usage.cr / 1e6) * 0.08).toFixed(4);

  // Count turns: current session from events (real-time) + past sessions from turns table
  let turns = 0;
  try {
    // Current session turns: count user events (observe_turn may use "default" or real session ID)
    const sessionTurns = db.prepare(
      "SELECT COUNT(*) as c FROM events WHERE session_id IN (?, 'default') AND role = 'user'"
    ).get(sessionId).c;
    // Past sessions: total from turns table minus current session IDs
    const pastTurns = db.prepare(
      "SELECT COUNT(*) as c FROM turns WHERE session_id NOT IN (?, 'default')"
    ).get(sessionId).c;
    turns = sessionTurns + pastTurns;
  } catch {}

  const errors = db.prepare(
    "SELECT COUNT(*) as c FROM events WHERE role='error' AND created_at > datetime('now','-5 minutes')"
  ).get().c;

  // Check for active thinking state (streaming Haiku response)
  let isThinking = false;
  let thinkingPreview = "";
  let thinkingDone = false;
  let thinkingDonePreview = "";
  const thinkingPath = path.join(overseerDir, "thinking.json");
  try {
    if (fs.existsSync(thinkingPath)) {
      const raw = fs.readFileSync(thinkingPath, "utf-8");
      const state = JSON.parse(raw);
      if ((state.session_id === sessionId || state.session_id === "default") && state.started_at) {
        if (state.status === "thinking" && Date.now() - state.started_at < 30000) {
          isThinking = true;
          thinkingPreview = (state.preview || "").trim();
        } else if (state.status === "done" && state.completed_at && Date.now() - state.completed_at < 120000) {
          // Recently completed — show brief "done" indicator
          thinkingDone = true;
          thinkingDonePreview = (state.preview || "").trim();
        }
      }
    }
  } catch {}

  // Advisory lookup: try real session ID, fall back to "default"
  let lastInj = null;
  let isLgtm = true;
  try {
    let advisory = db.prepare(
      "SELECT content, is_lgtm FROM last_advisory WHERE session_id = ?"
    ).get(sessionId);
    if (!advisory && sessionId !== "default") {
      advisory = db.prepare(
        "SELECT content, is_lgtm FROM last_advisory WHERE session_id = 'default'"
      ).get();
    }
    if (advisory) {
      lastInj = { content: advisory.content };
      isLgtm = advisory.is_lgtm === 1;
    }
  } catch {
    lastInj = db.prepare(
      "SELECT content FROM events WHERE role='injection' ORDER BY id DESC LIMIT 1"
    ).get();
    isLgtm = !lastInj || lastInj.content === "LGTM";
  }

  // Use real session ID for context vars
  let varsCount = 0;
  let taskPreview = "";
  try {
    varsCount = db.prepare(
      "SELECT COUNT(*) as c FROM context_vars WHERE session_id = ?"
    ).get(sessionId).c;
  } catch {}
  try {
    const taskVar = db.prepare(
      "SELECT var_meta FROM context_vars WHERE session_id = ? AND var_name = 'CURRENT_TASK'"
    ).get(sessionId);
    if (taskVar && taskVar.var_meta) {
      const meta = JSON.parse(taskVar.var_meta);
      taskPreview = (meta.preview || "").slice(0, 40);
    }
  } catch {}

  const parts = [
    `\x1b[35m\u{1F441}\x1b[0m ${usage.cnt} calls \u00B7 $${estCost}`,
    `${turns} turns`,
  ];
  if (varsCount > 0) parts.push(`${varsCount} vars`);
  if (errors > 0) parts.push(`\x1b[31m${errors} err\x1b[0m`);
  if (isThinking) {
    parts.push("\x1b[33m[thinking...]\x1b[0m");
  } else if (thinkingDone) {
    parts.push("\x1b[32m[done]\x1b[0m");
  } else if (isLgtm && lastInj) {
    parts.push("\x1b[32m\u2713\x1b[0m");
  }
  if (taskPreview) parts.push(`\x1b[36m${taskPreview}\x1b[0m`);

  console.log(parts.join(" | "));

  if (isThinking && thinkingPreview) {
    // Show streaming preview instead of advisory
    const previewLines = thinkingPreview.split("\n").filter((l) => l.trim());
    const maxLines = 4;
    const shown = previewLines.slice(0, maxLines);
    for (let i = 0; i < shown.length; i++) {
      const prefix = i < shown.length - 1 ? "\u251C" : "\u2514";
      const line = shown[i].trim().slice(0, 120);
      console.log(`\x1b[33m  ${prefix} ${line}\x1b[0m`);
    }
    if (previewLines.length > maxLines) {
      console.log(`\x1b[33m    ...\x1b[0m`);
    }
  } else if (thinkingDone && thinkingDonePreview && thinkingDonePreview !== "LGTM") {
    // Show recently completed advisory from thinking.json
    console.log(`\x1b[33m\u26A0 Advisory:\x1b[0m`);
    const previewLines = thinkingDonePreview.split("\n").filter((l) => l.trim());
    const maxLines = 6;
    const shown = previewLines.slice(0, maxLines);
    for (let i = 0; i < shown.length; i++) {
      const prefix = i < shown.length - 1 ? "\u251C" : "\u2514";
      const line = shown[i].trim().slice(0, 120);
      console.log(`\x1b[33m  ${prefix} ${line}\x1b[0m`);
    }
    if (previewLines.length > maxLines) {
      console.log(`\x1b[33m    (+${previewLines.length - maxLines} more lines)\x1b[0m`);
    }
  } else if (!isLgtm && lastInj) {
    // Show advisory content across multiple lines when last response wasn't LGTM
    console.log(`\x1b[33m\u26A0 Last advisory:\x1b[0m`);
    const lines = lastInj.content.split("\n").filter((l) => l.trim());
    const maxLines = 8;
    const shown = lines.slice(0, maxLines);
    for (let i = 0; i < shown.length; i++) {
      const prefix = i < shown.length - 1 && !(i === maxLines - 1 && lines.length > maxLines) ? "\u251C" : "\u2514";
      const line = shown[i].trim();
      console.log(`\x1b[33m  ${prefix} ${line}\x1b[0m`);
    }
    if (lines.length > maxLines) {
      console.log(`\x1b[33m    (+${lines.length - maxLines} more lines)\x1b[0m`);
    }
  }

  db.close();
} catch {
  console.log("\x1b[35m\u{1F441} Overseer:\x1b[0m \x1b[2munavailable\x1b[0m");
}
