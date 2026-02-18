// hooks/session-start.cjs
// SessionStart hook: injects context variable index + recent session summaries + pre-warms RLM model
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { openDb, getAllContextVars } = require("./lib/context-vars.cjs");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || "default";

    // Persist current session ID so statusline and other tools can read it
    const overseerDir = path.join(data.cwd || process.cwd(), ".haiku-overseer");
    if (!fs.existsSync(overseerDir)) fs.mkdirSync(overseerDir, { recursive: true });
    fs.writeFileSync(path.join(overseerDir, "current-session"), sessionId, "utf-8");

    const db = openDb(data.cwd);

    // Build context variable index (name + char count + preview)
    const vars = getAllContextVars(db, sessionId);
    let varIndex = "";
    if (vars.length > 0) {
      varIndex = "Context variables available (use get_context_vars to retrieve full values):\n";
      for (const v of vars) {
        const charCount = v.var_value.length;
        const preview = v.var_value.slice(0, 80).replace(/\n/g, " ");
        const meta = v.var_meta ? ` [${v.var_meta.slice(0, 60)}]` : "";
        varIndex += `  - ${v.var_name} (${charCount} chars)${meta}: ${preview}...\n`;
      }
    }

    // Load last 3 sessions with turn counts + summaries
    let summarySection = "";
    try {
      const sessions = db
        .prepare(`
          SELECT t.session_id,
                 COUNT(*) as turn_count,
                 MIN(t.created_at) as first_turn,
                 MAX(t.created_at) as last_turn,
                 s.summary
          FROM turns t
          LEFT JOIN session_summaries s ON s.session_id = t.session_id
          GROUP BY t.session_id
          ORDER BY MAX(t.created_at) DESC
          LIMIT 3
        `)
        .all();
      if (sessions.length > 0) {
        summarySection = "\nRecent session summaries:\n";
        for (const s of sessions) {
          const summary = s.summary
            ? s.summary.slice(0, 120).replace(/\n/g, " ")
            : "(no summary)";
          summarySection += `  [${s.session_id}] ${s.turn_count} turns (${s.first_turn} → ${s.last_turn}) ${summary}...\n`;
        }
      }
    } catch {}

    db.close();

    if (!varIndex && !summarySection) process.exit(0);

    const context = [varIndex, summarySection].filter(Boolean).join("\n");
    const result = {
      systemMessage: `[Overseer] Session ${sessionId.slice(0, 8)}… | ${vars.length} vars${summarySection ? " | history loaded" : ""}`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    };
    console.log(JSON.stringify(result));

  } catch {
    process.exit(0);
  }
});
