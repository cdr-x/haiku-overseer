// hooks/capture-turn.cjs
// Claude Code Stop hook: captures full user prompt + assistant response from transcript
// Also tracks file modifications as context variables
// Spawns detached rlm-learn-worker.mjs for deterministic utility updates
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const Database = require("better-sqlite3");
const { openDb: openCvDb, upsertContextVar, getContextVar, deleteContextVar } = require("./lib/context-vars.cjs");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);

    const transcriptPath = data.transcript_path;
    const sessionId = data.session_id || "default";
    if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

    // --- SUGGESTED_COMMANDS blocking gate ---
    // Block stop if a high-confidence command wasn't invoked, unless already blocked once
    try {
      const blockDb = openCvDb(data.cwd);
      const cmdVar = getContextVar(blockDb, sessionId, "SUGGESTED_COMMANDS");
      // Skip stale suggestions (older than 30 minutes)
      const isStale = cmdVar && cmdVar.updated_at &&
        (Date.now() - new Date(cmdVar.updated_at + "Z").getTime()) > 30 * 60 * 1000;
      if (isStale) {
        deleteContextVar(blockDb, sessionId, "SUGGESTED_COMMANDS");
        blockDb.close();
      } else if (cmdVar && !data.stop_hook_active) {
        const commands = JSON.parse(cmdVar.var_value);
        const highConf = commands.filter(c => c.confidence >= 0.6);

        if (highConf.length > 0) {
          // Check if already blocked once this cycle
          const meta = cmdVar.var_meta ? JSON.parse(cmdVar.var_meta) : {};
          if (meta._blocked_once) {
            // Already blocked once — clear and let stop proceed
            deleteContextVar(blockDb, sessionId, "SUGGESTED_COMMANDS");
            blockDb.close();
          } else {
            // Scan transcript for evidence the command was invoked
            const transcript = fs.readFileSync(transcriptPath, "utf-8");
            const uninvoked = highConf.filter(cmd => {
              const namePattern = new RegExp(`Skill.*${cmd.name}|/${cmd.name}`, "i");
              return !namePattern.test(transcript);
            });

            if (uninvoked.length > 0) {
              // Mark as blocked once so next stop proceeds
              meta._blocked_once = true;
              upsertContextVar(
                blockDb, sessionId, "SUGGESTED_COMMANDS",
                cmdVar.var_value,
                JSON.stringify(meta)
              );
              blockDb.close();

              const cmdNames = uninvoked.map(c => c.name.startsWith("/") ? c.name : `/${c.name}`).join(" ");
              console.log(JSON.stringify({
                decision: "block",
                reason: `You have suggested command(s) ${cmdNames} that weren't run. Please invoke with the Skill tool before finishing, or explicitly explain why they're not needed.`,
              }));
              return;
            }
            blockDb.close();
          }
        } else {
          blockDb.close();
        }
      } else if (cmdVar && data.stop_hook_active) {
        // Re-entry after a block — clear commands and let stop proceed
        deleteContextVar(blockDb, sessionId, "SUGGESTED_COMMANDS");
        blockDb.close();
      } else {
        blockDb.close();
      }
    } catch {
      // Don't let blocking logic prevent turn capture
    }

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

    // --- Spawn detached RLM learning worker ---
    // This makes learnFromTurn deterministic (every turn) instead of depending
    // on Claude calling observe_turn MCP tool. Worker runs in background, updates
    // utilities in DB before next UserPromptSubmit fires.
    try {
      const workerPath = path.join(__dirname, "lib", "rlm-learn-worker.mjs");
      if (fs.existsSync(workerPath)) {
        // Extract error signals from assistant response for process reward
        let errorSignal = null;
        const errorPatterns = /(?:error|Error|ERROR|exception|failed|FAILED|TypeError|ReferenceError|SyntaxError)/g;
        const errorMatches = lastAssistant.match(errorPatterns);
        if (errorMatches && errorMatches.length > 0) {
          errorSignal = `${errorMatches.length} error mentions detected`;
        }

        const workerData = JSON.stringify({
          cwd: data.cwd || process.cwd(),
          sessionId,
          userPrompt: lastUser,
          assistantResponse: lastAssistant,
          errors: errorSignal,
        });

        const child = spawn("node", [workerPath], {
          stdio: ["pipe", "ignore", "ignore"],
          detached: true,
          env: { ...process.env },
        });
        child.stdin.write(workerData);
        child.stdin.end();
        child.unref(); // don't wait for worker — it runs in background
      }
    } catch {
      // Don't let worker spawn failure block the hook
    }

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
