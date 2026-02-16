// hooks/post-tool-use-failure.cjs
// PostToolUseFailure hook: tracks tool failures and detects error loops
const { openDb, upsertContextVar, getContextVar } = require("./lib/context-vars.cjs");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || "default";
    const toolName = data.tool_name || "unknown";
    const error = (data.error || data.tool_response?.error || "").slice(0, 300);

    const db = openDb(data.cwd);

    // Load existing error patterns
    let errorPatterns = [];
    const existing = getContextVar(db, sessionId, "ERROR_PATTERNS");
    if (existing) {
      try { errorPatterns = JSON.parse(existing.var_value); } catch {}
    }

    const entry = {
      tool: toolName,
      error,
      timestamp: new Date().toISOString(),
    };
    errorPatterns.push(entry);

    // Keep last 10
    if (errorPatterns.length > 10) errorPatterns = errorPatterns.slice(-10);

    // Loop detection: same error pattern 3+ times in last 10
    const recentErrors = errorPatterns.slice(-10);
    const errorCounts = {};
    for (const e of recentErrors) {
      // Normalize key: tool + first 80 chars of error
      const key = `${e.tool}:${(e.error || "").slice(0, 80)}`;
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
    const hasLoop = Object.values(errorCounts).some((c) => c >= 3);

    upsertContextVar(
      db,
      sessionId,
      "ERROR_PATTERNS",
      JSON.stringify(errorPatterns),
      JSON.stringify({ count: errorPatterns.length, lastTool: toolName, loop: hasLoop })
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
        systemMessage: `[Overseer] Error loop detected in ${loopKeys} — same failure 3+ times`,
        hookSpecificOutput: {
          hookEventName: "PostToolUseFailure",
          additionalContext: `Error loop detected. ${errorPatterns.length} recent errors tracked. Use get_context_vars with ["ERROR_PATTERNS", "ERROR_LOOP"] for details.`,
        },
      }));
    }
  } catch {
    // Silent failure
    process.exit(0);
  }
});
