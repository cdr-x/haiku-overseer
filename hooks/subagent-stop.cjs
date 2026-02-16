// hooks/subagent-stop.cjs
// SubagentStop hook: logs when sub-agents finish
const { openDb, upsertContextVar, getContextVar } = require("./lib/context-vars.cjs");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || "default";
    const agentId = data.agent_id || "unknown";

    const db = openDb(data.cwd);

    // Load existing subagent tracking
    let subagents = {};
    const existing = getContextVar(db, sessionId, "SUBAGENTS");
    if (existing) {
      try { subagents = JSON.parse(existing.var_value); } catch {}
    }

    if (subagents[agentId]) {
      subagents[agentId].status = "completed";
      subagents[agentId].completed_at = new Date().toISOString();
    } else {
      subagents[agentId] = {
        type: "unknown",
        status: "completed",
        completed_at: new Date().toISOString(),
      };
    }

    const activeCount = Object.values(subagents).filter((s) => s.status === "running").length;
    upsertContextVar(
      db,
      sessionId,
      "SUBAGENTS",
      JSON.stringify(subagents),
      JSON.stringify({ active: activeCount, total: Object.keys(subagents).length })
    );

    db.close();

    if (activeCount > 0) {
      console.log(JSON.stringify({
        systemMessage: `[Overseer] Subagent finished (${activeCount} still active)`,
      }));
    }
  } catch {
    process.exit(0);
  }
});
