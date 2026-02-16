// hooks/capture-turn.cjs
// Claude Code Stop hook: captures full user prompt + assistant response from transcript
// Also tracks file modifications as context variables
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { openDb: openCvDb, upsertContextVar, getContextVar } = require("./lib/context-vars.cjs");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);

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

    // Deterministic file tracking: parse assistant response for Write/Edit file paths
    try {
      const cvDb = openCvDb(data.cwd);
      const filePatterns = [
        /(?:Write|Edit).*?file[_\s]*path['":\s]+['"]?([^\s'",}]+)/gi,
        /(?:Created|Updated|Wrote|Edited).*?(?:file|at)[:\s]+['"]?([^\s'",}]+\.\w+)/gi,
      ];
      let filesModified = {};
      const existingFiles = getContextVar(cvDb, sessionId, "FILES_MODIFIED");
      if (existingFiles) {
        try { filesModified = JSON.parse(existingFiles.var_value); } catch {}
      }

      let found = false;
      for (const pattern of filePatterns) {
        let match;
        while ((match = pattern.exec(lastAssistant)) !== null) {
          const filePath = match[1];
          if (filePath && filePath.length > 2 && filePath.includes(".")) {
            filesModified[filePath] = {
              action: "detected",
              timestamp: new Date().toISOString(),
            };
            found = true;
          }
        }
      }

      if (found) {
        const fileCount = Object.keys(filesModified).length;
        upsertContextVar(
          cvDb,
          sessionId,
          "FILES_MODIFIED",
          JSON.stringify(filesModified),
          JSON.stringify({ count: fileCount, source: "stop-hook" })
        );
      }

      // Optional AI analysis gated by env var
      if (process.env.HAIKU_STOP_ANALYSIS === "true") {
        try {
          const { callHaiku } = require("./lib/haiku-client.cjs");
          const analysisPrompt = `Extract from this assistant response:
1. CURRENT_TASK: What is being worked on (1 sentence)
2. DECISIONS: Any decisions made (array of strings)

Response: ${lastAssistant.slice(0, 2000)}

Respond with ONLY valid JSON: {"CURRENT_TASK": "...", "DECISIONS": [...]}`;
          const result = callHaiku("Extract session state. JSON only.", analysisPrompt);
          result.then((text) => {
            try {
              const parsed = JSON.parse(text);
              if (parsed.CURRENT_TASK) {
                upsertContextVar(cvDb, sessionId, "CURRENT_TASK", parsed.CURRENT_TASK,
                  JSON.stringify({ preview: parsed.CURRENT_TASK.slice(0, 80), source: "stop-analysis" }));
              }
              if (parsed.DECISIONS && Array.isArray(parsed.DECISIONS) && parsed.DECISIONS.length > 0) {
                upsertContextVar(cvDb, sessionId, "DECISIONS", JSON.stringify(parsed.DECISIONS),
                  JSON.stringify({ count: parsed.DECISIONS.length, source: "stop-analysis" }));
              }
            } catch {}
            cvDb.close();
          }).catch(() => cvDb.close());
        } catch { cvDb.close(); }
      } else {
        cvDb.close();
      }
    } catch {}
  } catch (err) {
    // Silent failure — don't block Claude Code
    process.exit(0);
  }
});
