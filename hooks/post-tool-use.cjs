// hooks/post-tool-use.cjs
// PostToolUse hook: tracks file modifications and error patterns as context variables
const fs = require("fs");
const path = require("path");
const { openDb, upsertContextVar, getContextVar, deleteContextVar } = require("./lib/context-vars.cjs");

function hookLog(cwd, section, err, context) {
  const msg = `[PostToolUse:${section}] ${err.message || err}`;
  process.stderr.write(msg + (context ? ` | ${context}` : "") + "\n");
  try {
    const logDir = path.join(cwd || ".", ".haiku-overseer");
    const logPath = path.join(logDir, "hook-errors.log");
    // Auto-rotate: truncate to last 50KB if over 100KB
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > 100 * 1024) {
        const content = fs.readFileSync(logPath, "utf-8");
        fs.writeFileSync(logPath, content.slice(-50 * 1024));
      }
    } catch {}
    const entry = JSON.stringify({
      hook: "PostToolUse", section, error: err.message || String(err),
      stack: err.stack || null, context: context || null,
      timestamp: new Date().toISOString(),
    }) + "\n";
    fs.appendFileSync(logPath, entry);
  } catch {}
}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || "default";
    const toolName = data.tool_name || "";
    const toolInput = data.tool_input || {};
    const toolResponse = data.tool_response || {};

    const db = openDb(data.cwd);

    // --- SUGGESTED_COMMANDS nudge + Skill clearing ---
    try {
      const cmdVar = getContextVar(db, sessionId, "SUGGESTED_COMMANDS");
      if (cmdVar) {
        const commands = JSON.parse(cmdVar.var_value);

        if (toolName === "Skill") {
          // Check if the invoked skill matches a suggested command
          const skillName = toolInput.skill || toolInput.name || "";
          const match = commands.find(c => c.name === skillName || skillName.endsWith(c.name));
          if (match) {
            deleteContextVar(db, sessionId, "SUGGESTED_COMMANDS");
            deleteContextVar(db, sessionId, "_NUDGE_COUNT");
          }
        } else if (commands.length > 0) {
          // Nudge every 3rd tool call
          let nudgeCount = 0;
          const nudgeVar = getContextVar(db, sessionId, "_NUDGE_COUNT");
          if (nudgeVar) {
            try { nudgeCount = JSON.parse(nudgeVar.var_value); } catch {}
          }
          nudgeCount++;
          upsertContextVar(db, sessionId, "_NUDGE_COUNT", JSON.stringify(nudgeCount), null);

          if (nudgeCount % 3 === 0) {
            const highConf = commands.filter(c => c.confidence >= 0.5);
            if (highConf.length > 0) {
              const cmdNames = highConf.map(c => c.name.startsWith("/") ? c.name : `/${c.name}`).join(" ");
              console.log(JSON.stringify({
                hookSpecificOutput: {
                  additionalContext: `Reminder: suggested command(s) ${cmdNames} available for this task. Invoke with the Skill tool when ready.`,
                },
              }));
            }
          }
        }
      }
    } catch (err) {
      hookLog(data.cwd, "nudge", err, `tool=${toolName}`);
    }

    // Track errors from ANY tool (Read, Glob, Grep, Task, etc.)
    const isError = data.is_error === true || data.error === true;
    if (isError && !["Write", "Edit", "Bash"].includes(toolName)) {
      try {
        let errorPatterns = [];
        const existing = getContextVar(db, sessionId, "ERROR_PATTERNS");
        if (existing) {
          try { errorPatterns = JSON.parse(existing.var_value); } catch {}
        }

        // Extract the best error description from the response
        const errorText = (
          toolResponse.error || toolResponse.message || toolResponse.stderr ||
          (typeof toolResponse === "string" ? toolResponse : "") ||
          data.tool_error || ""
        ).slice(0, 300);

        // Build a readable context of what was attempted
        const inputSummary = Object.entries(toolInput)
          .filter(([k]) => !k.startsWith("_"))
          .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
          .join(", ")
          .slice(0, 200);

        errorPatterns.push({
          tool: toolName,
          input: inputSummary,
          error: errorText || `${toolName} failed`,
          timestamp: new Date().toISOString(),
        });

        if (errorPatterns.length > 10) errorPatterns = errorPatterns.slice(-10);

        const errorCounts = {};
        for (const e of errorPatterns) {
          const key = `${e.tool}:${(e.error || "").slice(0, 80)}`;
          errorCounts[key] = (errorCounts[key] || 0) + 1;
        }
        const hasLoop = Object.values(errorCounts).some((c) => c >= 3);

        upsertContextVar(
          db, sessionId, "ERROR_PATTERNS",
          JSON.stringify(errorPatterns),
          JSON.stringify({ count: errorPatterns.length, lastTool: toolName, loop: hasLoop })
        );

        if (hasLoop) {
          upsertContextVar(
            db, sessionId, "ERROR_LOOP",
            JSON.stringify({ detected: true, counts: errorCounts, timestamp: new Date().toISOString() }),
            JSON.stringify({ warning: "Same error repeated 3+ times" })
          );
        }
      } catch (err) {
        hookLog(data.cwd, "error-tracking", err, `tool=${toolName} input=${JSON.stringify(toolInput).slice(0, 150)}`);
      }
      db.close();
      process.exit(0);
    }

    // Only process Write, Edit, Bash for file/success tracking
    if (!["Write", "Edit", "Bash"].includes(toolName)) { db.close(); process.exit(0); }

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
        const existing2 = getContextVar(db, sessionId, "ERROR_PATTERNS");
        if (existing2) {
          try { errorPatterns = JSON.parse(existing2.var_value); } catch {}
        }

        // Extract error text from multiple possible response fields
        const stderr = (
          toolResponse.stderr || toolResponse.error || toolResponse.output ||
          (typeof toolResponse === "string" ? toolResponse : "")
        ).slice(0, 300);

        // Label well-known exit codes for clarity
        const exitLabel = exitCode === 127 ? "command not found"
          : exitCode === 126 ? "permission denied"
          : exitCode === 1 ? "general error"
          : `exit ${exitCode}`;

        // Build rich error entry with command context
        const cmdSlice = command.slice(0, 200);
        const errorDesc = stderr || `Exit code ${exitCode}`;

        errorPatterns.push({
          tool: "Bash",
          input: cmdSlice,
          error: errorDesc,
          exitCode,
          exitLabel,
          timestamp: new Date().toISOString(),
        });

        // Keep last 10
        if (errorPatterns.length > 10) errorPatterns = errorPatterns.slice(-10);

        // Loop detection: same error pattern 3+ times in last 10
        // Use tool:exitCode as the key for Bash (more specific than truncated stderr)
        const errorCounts = {};
        for (const e of errorPatterns) {
          const key = e.exitCode !== undefined
            ? `${e.tool}:exit${e.exitCode}`
            : `${e.tool}:${(e.error || "").slice(0, 80)}`;
          errorCounts[key] = (errorCounts[key] || 0) + 1;
        }
        const hasLoop = Object.values(errorCounts).some((c) => c >= 3);

        upsertContextVar(
          db, sessionId, "ERROR_PATTERNS",
          JSON.stringify(errorPatterns),
          JSON.stringify({ count: errorPatterns.length, lastTool: "Bash", loop: hasLoop })
        );

        if (hasLoop) {
          upsertContextVar(
            db, sessionId, "ERROR_LOOP",
            JSON.stringify({ detected: true, counts: errorCounts, timestamp: new Date().toISOString() }),
            JSON.stringify({ warning: "Same error repeated 3+ times" })
          );
        }

        db.close();

        if (hasLoop) {
          // Build informative block message showing what's failing and why
          const loopDetails = Object.entries(errorCounts)
            .filter(([, c]) => c >= 3)
            .map(([k, c]) => `${k} (${c}x)`);

          // Find the last error's command for context
          const lastErr = errorPatterns[errorPatterns.length - 1];
          const cmdContext = lastErr && lastErr.input ? ` Last command: \`${lastErr.input.slice(0, 100)}\`` : "";

          console.log(JSON.stringify({
            decision: "block",
            reason: `Error loop detected: ${loopDetails.join(", ")}.${cmdContext} Change your approach — the current strategy is not working. Use get_context_vars with ["ERROR_PATTERNS", "ERROR_LOOP"] for details.`,
          }));
          return;
        }
      } else {
        db.close();
      }
    }
  } catch (err) {
    // Log the error but don't block Claude Code
    const cwd = (() => { try { return JSON.parse(input).cwd; } catch { return null; } })();
    const toolName = (() => { try { return JSON.parse(input).tool_name; } catch { return "unknown"; } })();
    hookLog(cwd, "top-level", err, `tool=${toolName} input_len=${input.length}`);
    process.exit(0);
  }
});
