// hooks/pre-compact.cjs
// PreCompact hook: uses Haiku to extract/update context variables before compaction
const path = require("path");
const Database = require("better-sqlite3");
const { openDb, upsertContextVar, getAllContextVars } = require("./lib/context-vars.cjs");
const { callHaiku } = require("./lib/haiku-client.cjs");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || "default";
    const db = openDb(data.cwd);

    // Load recent events
    let events = [];
    try {
      const memDbPath = path.join(data.cwd || process.cwd(), ".haiku-overseer", "memory.db");
      const memDb = new Database(memDbPath, { readonly: true });
      events = memDb
        .prepare("SELECT role, content, meta FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 30")
        .all(sessionId)
        .reverse();
      memDb.close();
    } catch {}

    // Load existing context vars
    const existingVars = getAllContextVars(db, sessionId);
    const existingMap = {};
    for (const v of existingVars) {
      existingMap[v.var_name] = v.var_value.slice(0, 200);
    }

    const eventLog = events.map((e) => `[${e.role}] ${e.content.slice(0, 300)}`).join("\n");

    const prompt = `You are extracting structured context from a coding session before context compaction.

Current variables:
${JSON.stringify(existingMap, null, 2)}

Recent events:
${eventLog}

Extract/update these variables as a JSON object. Only include variables that have meaningful content:
- CURRENT_TASK: What the user is currently working on (1-2 sentences)
- DECISIONS: Key decisions made in this session (array of strings)
- ERROR_PATTERNS: Recent errors and their resolutions (array of {error, resolution?})
- FILES_MODIFIED: Important files changed (object {path: action})
- PENDING_WORK: Unfinished tasks or TODOs (array of strings)
- KEY_CONTEXT: Critical context that must survive compaction (1-3 sentences)

Respond with ONLY a valid JSON object.`;

    const response = await callHaiku(
      "You extract structured session state. Respond with only valid JSON.",
      prompt
    );

    // Parse and upsert each variable
    let parsed;
    try { parsed = JSON.parse(response); } catch { db.close(); process.exit(0); }

    for (const [varName, varValue] of Object.entries(parsed)) {
      if (varValue === null || varValue === undefined) continue;
      const valueStr = typeof varValue === "string" ? varValue : JSON.stringify(varValue);
      const preview = valueStr.slice(0, 80);
      upsertContextVar(db, sessionId, varName, valueStr, JSON.stringify({ preview, source: "pre-compact" }));
    }

    db.close();
  } catch {
    process.exit(0);
  }
});
