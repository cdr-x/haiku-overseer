// hooks/capture-turn.cjs
// Claude Code Stop hook: captures full user prompt + assistant response from transcript
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    if (data.stop_hook_active) process.exit(0);

    const transcriptPath = data.transcript_path;
    const sessionId = data.session_id || "default";
    if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

    // Read JSONL transcript, parse each line
    const lines = fs
      .readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    // Find last user message and last assistant message
    let lastUser = "";
    let lastAssistant = "";
    for (const entry of lines) {
      if (!entry.messages) continue;
      for (const msg of entry.messages) {
        if (msg.role === "user") {
          lastUser =
            typeof msg.content === "string"
              ? msg.content
              : msg.content
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("\n");
        }
        if (msg.role === "assistant") {
          lastAssistant =
            typeof msg.content === "string"
              ? msg.content
              : msg.content
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("\n");
        }
      }
    }

    if (!lastUser && !lastAssistant) process.exit(0);

    // Write to DB
    const dbPath = path.join(
      data.cwd || process.cwd(),
      ".haiku-overseer",
      "memory.db"
    );
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_prompt TEXT NOT NULL,
      assistant_response TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.prepare(
      "INSERT INTO turns (session_id, user_prompt, assistant_response) VALUES (?, ?, ?)"
    ).run(sessionId, lastUser, lastAssistant);
    db.close();
  } catch (err) {
    // Silent failure — don't block Claude Code
    process.exit(0);
  }
});
