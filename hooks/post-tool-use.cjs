// hooks/post-tool-use.cjs
// PostToolUse hook: tracks file modifications and error patterns as context variables
const { openDb, upsertContextVar, getContextVar, deleteContextVar } = require("./lib/context-vars.cjs");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || "default";
    const toolName = data.tool_name || "";
    const toolInput = data.tool_input || {};
    const toolResponse = data.tool_response || {};

    // Only process Write, Edit, Bash
    if (!["Write", "Edit", "Bash"].includes(toolName)) process.exit(0);

    const db = openDb(data.cwd);

    if (toolName === "Write" || toolName === "Edit") {
      // Track file modifications
      const filePath = toolInput.file_path || toolInput.path || "";
      if (!filePath) { db.close(); process.exit(0); }

      const action = toolName === "Write" ? "write" : "edit";
      let filesModified = {};
      const existing = getContextVar(db, sessionId, "FILES_MODIFIED");
      if (existing) {
        try { filesModified = JSON.parse(existing.var_value); } catch {}
      }

      filesModified[filePath] = {
        action,
        timestamp: new Date().toISOString(),
      };

      const fileCount = Object.keys(filesModified).length;
      upsertContextVar(
        db,
        sessionId,
        "FILES_MODIFIED",
        JSON.stringify(filesModified),
        JSON.stringify({ count: fileCount, last: filePath })
      );
      db.close();
    }

    if (toolName === "Bash") {
      const command = (toolInput.command || "");
      const exitCode = toolResponse.exit_code ?? toolResponse.exitCode;

      // Auto-clear FILES_MODIFIED after successful git commit
      if (/git\s+commit/.test(command) && (exitCode === undefined || exitCode === 0)) {
        deleteContextVar(db, sessionId, "FILES_MODIFIED");
      }

      // Auto-clear ERROR_PATTERNS and ERROR_LOOP after 2 consecutive successful Bash calls
      if (exitCode === undefined || exitCode === 0) {
        const existing = getContextVar(db, sessionId, "ERROR_PATTERNS");
        if (existing) {
          let successStreak = 0;
          const streakVar = getContextVar(db, sessionId, "_BASH_SUCCESS_STREAK");
          if (streakVar) {
            try { successStreak = JSON.parse(streakVar.var_value); } catch {}
          }
          successStreak++;
          if (successStreak >= 2) {
            deleteContextVar(db, sessionId, "ERROR_PATTERNS");
            deleteContextVar(db, sessionId, "ERROR_LOOP");
            deleteContextVar(db, sessionId, "_BASH_SUCCESS_STREAK");
          } else {
            upsertContextVar(db, sessionId, "_BASH_SUCCESS_STREAK", JSON.stringify(successStreak), null);
          }
        }
      }

      // Track errors from non-zero exit codes
      if (exitCode !== undefined && exitCode !== 0) {
        // Reset success streak on failure
        deleteContextVar(db, sessionId, "_BASH_SUCCESS_STREAK");
        let errorPatterns = [];
        const existing = getContextVar(db, sessionId, "ERROR_PATTERNS");
        if (existing) {
          try { errorPatterns = JSON.parse(existing.var_value); } catch {}
        }

        const cmdSlice = command.slice(0, 200);
        const stderr = (toolResponse.stderr || toolResponse.output || "").slice(0, 300);

        errorPatterns.push({
          tool: "Bash",
          command: cmdSlice,
          error: stderr,
          exitCode,
          timestamp: new Date().toISOString(),
        });

        // Keep last 10
        if (errorPatterns.length > 10) errorPatterns = errorPatterns.slice(-10);

        // Loop detection: same error pattern 3+ times in last 10
        const errorCounts = {};
        for (const e of errorPatterns) {
          const key = `${e.tool}:${(e.error || "").slice(0, 80)}`;
          errorCounts[key] = (errorCounts[key] || 0) + 1;
        }
        const hasLoop = Object.values(errorCounts).some((c) => c >= 3);

        upsertContextVar(
          db,
          sessionId,
          "ERROR_PATTERNS",
          JSON.stringify(errorPatterns),
          JSON.stringify({ count: errorPatterns.length, lastTool: "Bash", loop: hasLoop })
        );

        if (hasLoop) {
          upsertContextVar(
            db,
            sessionId,
            "ERROR_LOOP",
            JSON.stringify({ detected: true, counts: errorCounts, timestamp: new Date().toISOString() }),
            JSON.stringify({ warning: "Same error repeated 3+ times" })
          );
        }

        db.close();

        if (hasLoop) {
          const loopKeys = Object.entries(errorCounts)
            .filter(([, c]) => c >= 3)
            .map(([k]) => k.split(":")[0])
            .join(", ");
          console.log(JSON.stringify({
            decision: "block",
            reason: `Error loop detected in ${loopKeys}: same failure repeated 3+ times. Change your approach — the current strategy is not working. Use get_context_vars with ["ERROR_PATTERNS", "ERROR_LOOP"] for details.`,
          }));
          return;
        }
      } else {
        db.close();
      }
    }
  } catch {
    // Silent failure — don't block Claude Code
    process.exit(0);
  }
});
