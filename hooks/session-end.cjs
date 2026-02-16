// hooks/session-end.cjs
// SessionEnd hook: consolidates context vars into a session summary via Haiku
const path = require("path");
const Database = require("better-sqlite3");
const { openDb, getAllContextVars } = require("./lib/context-vars.cjs");
const { callHaiku } = require("./lib/haiku-client.cjs");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", async () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || "default";
    const db = openDb(data.cwd);

    // Load all context vars
    const vars = getAllContextVars(db, sessionId);
    if (vars.length === 0) { db.close(); process.exit(0); }

    const varsText = vars
      .map((v) => `[${v.var_name}]\n${v.var_value.slice(0, 500)}`)
      .join("\n\n");

    const prompt = `Summarize this coding session based on its context variables. Be concise (3-5 sentences).
Focus on: what was accomplished, key decisions, unresolved issues, and files changed.

Session context variables:
${varsText}`;

    const summary = await callHaiku(
      "You are a concise session summarizer. Produce a brief summary.",
      prompt
    );

    // Store summary using the session_summaries table
    const memDbPath = path.join(data.cwd || process.cwd(), ".haiku-overseer", "memory.db");
    try {
      const memDb = new Database(memDbPath);
      memDb.pragma("journal_mode = WAL");
      memDb.exec(`CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        summary TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      memDb.prepare(
        `INSERT INTO session_summaries (session_id, summary) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, created_at = datetime('now')`
      ).run(sessionId, summary);
      memDb.close();
    } catch {}

    db.close();
  } catch {
    process.exit(0);
  }
});
